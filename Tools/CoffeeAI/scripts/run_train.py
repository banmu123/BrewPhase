#!/usr/bin/env python3
"""run_train.py — CommitBrew Coffee AI 训练启动器（对应任务验收 5/6/7）。

三种模式（互斥，必须显式选择其一）：
  --dry-run   只打印将要使用的模型、数据目录、配置与输出目录，不训练、不下载。
  --smoke     2 次迭代的管线烟测（仅在用户显式执行本命令时运行；模型必须已在
              本地缓存，绝不擅自下载）。
  --train     正式训练。训练前强制 preflight（环境/数据/模型/磁盘），通过后才
              调用官方 mlx_lm.lora；结束后写 run_manifest.json 记录全部要素。

底层一律复用当前版本 MLX-LM 官方命令（mlx_lm.lora），不自建训练框架。

用法:
  python3 Tools/CoffeeAI/scripts/run_train.py --dry-run
  python3 Tools/CoffeeAI/scripts/run_train.py --smoke  --config Tools/CoffeeAI/configs/generated_smoke.yaml
  python3 Tools/CoffeeAI/scripts/run_train.py --train  --config Tools/CoffeeAI/configs/m2_16gb_qwen3_4b_qlora.yaml
可选: --model <HF-id|本地路径>  --data-dir <目录>  --allow-download
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env_check  # noqa: E402
from validate_data import check_splits_dir, check_training_admission  # noqa: E402

COFFEEAI = Path(__file__).resolve().parents[1]
REPO_ROOT = COFFEEAI.parent.parent
DEFAULT_CONFIG = "Tools/CoffeeAI/configs/m2_16gb_qwen3_4b_qlora.yaml"


# ---------------------------------------------------------------- 极简 YAML 读取
# 配置由 make_train_config.py 生成的扁平 YAML（一层嵌套 lora_parameters），
# 这里用手写解析避免引入 PyYAML 依赖。

def parse_simple_yaml(path):
    text = Path(path).read_text(encoding="utf-8")
    cfg, current_key = {}, None
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if line.startswith("  ") and current_key:
            k, v = line.strip().split(":", 1)
            cfg[current_key][k.strip()] = _scalar(v.strip())
        elif ":" in line:
            k, v = line.split(":", 1)
            k, v = k.strip(), v.strip()
            if v == "":
                cfg[k] = {}
                current_key = k
            else:
                cfg[k] = _scalar(v)
                current_key = None
    return cfg


def _scalar(v):
    if v.startswith(('"', "'")):
        return json.loads(v.replace("'", '"'))
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    if v.lower() in ("null", "~"):
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    return v


def dump_yaml(cfg):
    lines = []
    for k, v in cfg.items():
        if isinstance(v, dict):
            lines.append(f"{k}:")
            for k2, v2 in v.items():
                lines.append(f"  {k2}: {_fmt(v2)}")
        else:
            lines.append(f"{k}: {_fmt(v)}")
    return "\n".join(lines) + "\n"


def _fmt(v):
    import json as _json
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, list):
        return "[" + ", ".join(_fmt(x) for x in v) + "]"
    return _json.dumps(v, ensure_ascii=False)


# ---------------------------------------------------------------- 模型定位

def resolve_model(model_ref, allow_download):
    """返回 (status, detail)。status ∈ local / hf-cache / needs-download / invalid"""
    p = Path(model_ref)
    if p.is_absolute() or os.path.isdir(model_ref):
        if (p / "config.json").is_file() and list(p.glob("*.safetensors")):
            size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / (1024 ** 3)
            return "local", {"path": str(p), "size_gb": round(size, 2)}
        return "invalid", {"reason": "本地目录缺少 config.json 或 *.safetensors"}
    if "/" in model_ref:
        cached = env_check.model_cached(model_ref)
        if cached:
            return "hf-cache", cached
        if allow_download:
            return "needs-download", {"note": "用户已显式允许下载；4bit 4B 级模型约 2.4–2.6GB（以模型卡为准）"}
        return "needs-download", {"note": "不在本地 HF 缓存。下载约 2.4–2.6GB（以模型卡为准），需联网"}
    return "invalid", {"reason": "既不是本地路径也不是 HF repo id（org/name）"}


def mlx_entry():
    """官方入口优先：console script mlx_lm.lora；退化用 python -m mlx_lm.lora。"""
    exe = shutil.which("mlx_lm.lora")
    if exe:
        return [exe], [shutil.which("mlx_lm.generate") or "mlx_lm.generate"]
    return [sys.executable, "-m", "mlx_lm.lora"], [sys.executable, "-m", "mlx_lm.generate"]


def preflight(config_path, model_override, data_override, mode, allow_download):
    """返回 (ok, report)。mode: dry-run / smoke / train"""
    report = {}
    cfg = parse_simple_yaml(config_path)
    model_ref = model_override or cfg.get("model")
    data_dir = Path(data_override or cfg.get("data") or "")
    if not data_dir.is_absolute():
        data_dir = REPO_ROOT / data_dir
    adapter_path = Path(cfg.get("adapter_path") or "")
    if adapter_path and not adapter_path.is_absolute():
        adapter_path = REPO_ROOT / adapter_path
    report["model_ref"] = model_ref
    report["data_dir"] = str(data_dir)
    report["adapter_path"] = str(adapter_path)
    report["config"] = cfg

    ok = True

    # 1) 环境硬性项
    info = env_check.collect(model_ref if "/" in str(model_ref) else None)
    hard, soft = env_check.evaluate(info, min_mem_gb=8.0, min_disk_gb=20.0,
                                    model_size_gb=3.0)
    report["env"] = {k: info[k] for k in ("os", "machine", "chip", "memory_gb",
                                          "disk_free_gb", "python_version",
                                          "mlx_version", "mlx_lm_version")}

    # 2) mlx-lm（dry-run 容忍缺失，smoke/train 必须有）
    if info["mlx_lm_version"] is None or str(info["mlx_lm_version"]).startswith("import-failed"):
        soft.append("mlx-lm 不可用")
        if mode != "dry-run":
            hard.append('训练/烟测前必须先安装: pip install "mlx-lm[train]"')
    else:
        report["mlx_lm_version"] = info["mlx_lm_version"]

    # 3) 数据
    train_f = data_dir / "train.jsonl"
    if not train_f.is_file():
        hard.append(f"数据目录缺少 train.jsonl: {data_dir}（先运行 split_dataset.py）")
        report["data_counts"] = {}
    else:
        counts = {}
        for name in ("train", "valid", "test"):
            f = data_dir / f"{name}.jsonl"
            counts[name] = sum(1 for line in f.read_text(encoding="utf-8").splitlines() if line.strip()) if f.is_file() else 0
        report["data_counts"] = counts
        if counts["train"] == 0:
            hard.append("train.jsonl 为空")
        else:
            issues, _ = check_splits_dir(data_dir)
            errs = [i for i in issues if i["level"] == "error"]
            if errs:
                hard.append("数据集跨集合泄漏/结构错误: " + "; ".join(i["message"] for i in errs[:3]))
            # ---- P0：训练准入复查（独立重读 meta，不信任划分时的任何标志）。
            # --include-unreviewed 的产物在此被硬性拒绝：只要 meta 里存在
            # 非 approved / 许可不明 / 来源不合规 / 元数据不全的样本，一律阻断。
            a_issues, a_summary = check_training_admission(data_dir)
            report["admission"] = {"counts": a_summary["counts"],
                                   "n_samples": a_summary["n_samples"],
                                   "errors": a_summary["errors"]}
            a_errs = [i for i in a_issues if i["level"] == "error"]
            if a_errs:
                head = "; ".join(f"[{i.get('code')}] {i.get('sample_id', '')} {i['message']}"
                                 for i in a_errs[:4])
                hard.append(f"训练准入复查未通过（P0，{len(a_errs)} 项）: {head}")
            report["split_dir_sha256"] = {
                n: hashlib.sha256((data_dir / f"{n}.jsonl").read_bytes()).hexdigest()[:16]
                for n in ("train", "valid", "test") if (data_dir / f"{n}.jsonl").is_file()
            }

    # 4) 模型。--allow-download 仅对 --train 生效：dry-run 与烟测绝不下载。
    effective_allow = bool(allow_download) and mode == "train"
    report["allow_download_effective"] = effective_allow
    status, detail = resolve_model(str(model_ref), effective_allow)
    report["model_status"] = status
    report["model_detail"] = detail
    if status == "invalid":
        hard.append(f"模型不可用: {detail}")
    elif status == "needs-download":
        if mode == "dry-run":
            soft.append(f"模型尚未下载——dry-run 不下载。正式训练前请先手动下载到本地 HF 缓存"
                        f"（或正式训练时显式传 --allow-download）。{detail.get('note', '')}")
        elif mode == "smoke":
            hard.append("烟测不下载：模型不在本地缓存。请先手动下载（huggingface-cli download …）；"
                        "--allow-download 对烟测无效。")
        elif effective_allow:
            soft.append("用户已显式 --allow-download：正式训练启动时将由 mlx-lm 下载该模型"
                        "（约 2.4–2.6GB，以模型卡为准；联网）。")
        else:
            hard.append("模型不在本地。本工具绝不擅自下载；如确认要下载请加 --allow-download"
                        f"（仅 --train 生效，约 2.4–2.6GB，以模型卡为准）。{detail.get('note', '')}")

    # 5) 磁盘
    model_gb = float(detail.get("size_gb") or 3.0) if status in ("local", "hf-cache") else 3.0
    if info["disk_free_gb"] < model_gb + 5:
        hard.append(f"磁盘不足: 需要约 {model_gb + 5:.0f}GB（模型+缓冲），当前 {info['disk_free_gb']}GB")

    report["preflight_hard"] = hard
    report["preflight_soft"] = soft
    report["ok"] = not hard
    return ok if not hard else False, report


def print_dry_run(report, config_path):
    cfg = report["config"]
    print("=" * 66)
    print("CommitBrew Coffee AI — 训练 DRY-RUN（只读预览，不训练、不下载）")
    print("=" * 66)
    print(f"配置文件   : {config_path}")
    print(f"基础模型   : {report['model_ref']}")
    print(f"模型状态   : {report['model_status']}  {report['model_detail'].get('size_gb', report['model_detail'].get('note', ''))}")
    print(f"微调类型   : {cfg.get('fine_tune_type')}（量化模型自动按 QLoRA，官方 LORA.md）")
    print(f"数据目录   : {report['data_dir']}  train/valid/test = "
          f"{report['data_counts'].get('train', 0)}/{report['data_counts'].get('valid', 0)}/{report['data_counts'].get('test', 0)}")
    print(f"迭代/批/层 : iters={cfg.get('iters')} batch_size={cfg.get('batch_size')} num_layers={cfg.get('num_layers')}")
    print(f"学习率/序列: lr={cfg.get('learning_rate')} max_seq_length={cfg.get('max_seq_length')} grad_checkpoint={cfg.get('grad_checkpoint')}")
    print(f"适配器输出 : {report['adapter_path']}")
    print(f"日志目录   : {COFFEEAI / 'runs' / 'logs'}")
    print(f"manifest   : 正式训练后写 {COFFEEAI / 'runs' / '<run_id>' / 'run_manifest.json'}")
    entry, _ = mlx_entry()
    print("-" * 66)
    print("将执行（dry-run 不执行）:")
    print(f"  {' '.join(entry)} --config {config_path}")
    print("-" * 66)
    for h in report["preflight_hard"]:
        print(f"✗ [阻断] {h}")
    for s in report["preflight_soft"]:
        print(f"⚠ [提示] {s}")
    print("-" * 66)
    if report["ok"]:
        print("Preflight: 通过。dry-run 到此为止——没有任何训练、下载或写盘发生。")
    else:
        print("Preflight: 存在阻断项，正式训练会被拒绝。")
    print("=" * 66)


def run_subprocess(cmd, log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"[CoffeeAI] 执行: {' '.join(cmd)}")
    print(f"[CoffeeAI] 日志: {log_path}")
    with log_path.open("w", encoding="utf-8") as log:
        proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    return proc.returncode


def main(argv=None):
    p = argparse.ArgumentParser(description="CommitBrew Coffee AI 训练启动器")
    p.add_argument("--config", default=DEFAULT_CONFIG)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--smoke", action="store_true")
    p.add_argument("--train", action="store_true")
    p.add_argument("--model", default=None, help="覆盖配置中的 model")
    p.add_argument("--data-dir", default=None, help="覆盖配置中的 data")
    p.add_argument("--allow-download", action="store_true",
                   help="显式允许在【正式训练】时下载缺失的基础模型；--dry-run 与 --smoke "
                        "即使传入也绝不下载（烟测要求模型已在本地缓存）")
    args = p.parse_args(argv)

    modes = [m for m in ("dry-run", "smoke", "train") if getattr(args, m.replace("-", "_"))]
    if len(modes) != 1:
        p.error("必须且只能选择一种模式: --dry-run / --smoke / --train")
    mode = modes[0]

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = REPO_ROOT / config_path
    if not config_path.is_file():
        print(f"[CoffeeAI] 错误: 配置不存在: {config_path}（先用 make_train_config.py 生成）",
              file=sys.stderr)
        sys.exit(1)

    ok, report = preflight(config_path, args.model, args.data_dir, mode, args.allow_download)

    if mode == "dry-run":
        print_dry_run(report, config_path)
        sys.exit(0 if ok else 1)

    if not ok:
        print("[CoffeeAI] Preflight 未通过，已停止：", file=sys.stderr)
        for h in report["preflight_hard"]:
            print(f"  ✗ {h}", file=sys.stderr)
        print("（这是刻意设计：环境/数据/模型不满足时绝不启动训练。）", file=sys.stderr)
        sys.exit(1)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    cfg = dict(report["config"])
    entry, _ = mlx_entry()

    if mode == "smoke":
        cfg.update({
            "iters": 2, "batch_size": 1, "num_layers": 2,
            "max_seq_length": min(512, int(cfg.get("max_seq_length") or 512)),
            "grad_checkpoint": True, "save_every": 1000, "steps_per_eval": 100,
            "adapter_path": f"Tools/CoffeeAI/runs/smoke_adapter_{ts}",
        })
        smoke_cfg = COFFEEAI / "runs" / f"smoke_config_{ts}.yaml"
        smoke_cfg.parent.mkdir(parents=True, exist_ok=True)
        smoke_cfg.write_text(dump_yaml(cfg), encoding="utf-8")
        log = COFFEEAI / "runs" / "logs" / f"smoke_{ts}.log"
        code = run_subprocess(entry + ["--config", str(smoke_cfg)], log)
        if code == 0:
            print("[CoffeeAI] 烟测通过：数据加载→训练循环→适配器保存整条管线可用。")
            print("[CoffeeAI] 注意：烟测不代表模型质量，2 次迭代没有学习意义。")
        else:
            print(f"[CoffeeAI] 烟测失败（exit={code}），请查看日志: {log}", file=sys.stderr)
        sys.exit(code)

    # ---- 正式训练
    run_id = f"train_{ts}"
    run_dir = COFFEEAI / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log = COFFEEAI / "runs" / "logs" / f"{run_id}.log"
    code = run_subprocess(entry + ["--config", str(config_path)], log)

    manifest = {
        "run_id": run_id,
        "mode": mode,
        "started_at": ts,
        "base_model": report["model_ref"],
        "model_source": report["model_status"],
        "model_detail": report["model_detail"],
        "fine_tune_type": cfg.get("fine_tune_type"),
        "config_path": str(config_path),
        "config": cfg,
        "data_dir": report["data_dir"],
        "data_counts": report.get("data_counts", {}),
        "split_files_sha256_16": report.get("split_dir_sha256", {}),
        "adapter_path": cfg.get("adapter_path"),
        "log_path": str(log),
        "exit_code": code,
        "mlx_lm_version": report.get("mlx_lm_version"),
        "python_version": sys.version.split()[0],
        "host": {"chip": report["env"].get("chip"), "memory_gb": report["env"].get("memory_gb")},
        "notes": "训练完成后请运行 evaluate.py 对比基础模型；本 manifest 不宣称任何质量结论。",
    }
    if code == 0:
        (run_dir / "run_manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[CoffeeAI] 训练完成。manifest: {run_dir / 'run_manifest.json'}")
        print(f"[CoffeeAI] 适配器: {cfg.get('adapter_path')}   日志: {log}")
        print("[CoffeeAI] 下一步: python3 Tools/CoffeeAI/scripts/evaluate.py --adapter-path ...")
    else:
        print(f"[CoffeeAI] 训练失败（exit={code}），日志: {log}", file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
