#!/usr/bin/env python3
"""env_check.py — CommitBrew Coffee AI 环境检测（对应任务验收 4）。

检测：Apple Silicon / 芯片型号 / 统一内存 / 可用磁盘 / Python 版本 /
mlx 与 mlx-lm 是否安装 / HuggingFace 缓存与指定模型是否已下载。

用法:
  python3 Tools/CoffeeAI/scripts/env_check.py
  python3 Tools/CoffeeAI/scripts/env_check.py --json
  python3 Tools/CoffeeAI/scripts/env_check.py --min-mem-gb 16 --min-disk-gb 20
  python3 Tools/CoffeeAI/scripts/env_check.py --check-model mlx-community/Qwen3-4B-Instruct-2507-4bit
退出码: 0 = 硬性项全部满足；1 = 有硬性项不满足（Apple Silicon / 内存 / 磁盘）。
注意: mlx-lm 未安装不算硬性失败，但会给出安装命令与磁盘占用预估。
"""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys


def sysctl(key):
    try:
        r = subprocess.run(["sysctl", "-n", key], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() or None
    except Exception:
        return None


def module_version(name):
    try:
        if importlib.util.find_spec(name) is None:
            return None
        mod = importlib.import_module(name)
        return getattr(mod, "__version__", "unknown")
    except Exception as e:
        return f"import-failed: {type(e).__name__}"


def dir_size_gb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total / (1024 ** 3)


def hf_cache_dir():
    return os.path.expanduser(os.environ.get("HF_HOME", "~/.cache/huggingface"))


def model_cached(model_id):
    if not model_id or "/" not in model_id:
        return None  # 本地路径或非 HF id，无法判断
    org, name = model_id.split("/", 1)
    d = os.path.join(hf_cache_dir(), "hub", f"models--{org}--{name}")
    if os.path.isdir(d):
        return {"path": d, "size_gb": round(dir_size_gb(d), 2)}
    return None


def collect(model_id=None):
    machine = platform.machine()
    system = platform.system()
    chip = sysctl("machdep.cpu.brand_string")
    mem_bytes = sysctl("hw.memsize")
    mem_gb = round(int(mem_bytes) / (1024 ** 3), 1) if (mem_bytes or "").isdigit() else None
    disk = shutil.disk_usage(RepoRoot()) if os.access(RepoRoot(), os.R_OK) else shutil.disk_usage("/")
    info = {
        "os": f"{system} {platform.mac_ver()[0] or ''}".strip(),
        "machine": machine,
        "chip": chip,
        "apple_silicon": system == "Darwin" and machine == "arm64",
        "memory_gb": mem_gb,
        "disk_free_gb": round(disk.free / (1024 ** 3), 1),
        "python_version": sys.version.split()[0],
        "python_executable": sys.executable,
        "mlx_version": module_version("mlx"),
        "mlx_lm_version": module_version("mlx_lm"),
        "hf_cache_dir": hf_cache_dir(),
        "hf_cache_gb": round(dir_size_gb(hf_cache_dir()), 2) if os.path.isdir(hf_cache_dir()) else 0.0,
        "model": model_id,
        "model_cached": model_cached(model_id) if model_id else None,
    }
    return info


def RepoRoot():
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def evaluate(info, min_mem_gb, min_disk_gb, model_size_gb):
    hard = []
    soft = []
    if not info["apple_silicon"]:
        hard.append("非 Apple Silicon（MLX 路线要求 Apple 芯片；Intel Mac 请改用 llama.cpp/GGUF 等路线，"
                    "本工程不提供亦不假装支持）")
    if info["memory_gb"] is None or info["memory_gb"] < min_mem_gb:
        hard.append(f"统一内存 {info['memory_gb']}GB 低于要求 {min_mem_gb}GB")
    need = model_size_gb + 5
    if info["disk_free_gb"] < min_disk_gb or info["disk_free_gb"] < need:
        hard.append(f"可用磁盘 {info['disk_free_gb']}GB 不足（需 >= max({min_disk_gb}, 模型 {model_size_gb}GB + 5GB 缓冲)）")
    if info["mlx_lm_version"] is None:
        soft.append("mlx-lm 未安装。安装命令: pip install \"mlx-lm[train]\"（联网，"
                    "依赖约 0.3–0.6GB 磁盘占用，以 pip 实际输出为准）")
    if info["model"] and not info["model_cached"]:
        soft.append(f"模型 {info['model']} 不在本地 HF 缓存中。首次训练/评测需联网下载，"
                    f"4bit 4B 级别模型约 2.4–2.6GB（以模型卡实际大小为准）。"
                    "本工程任何脚本都不会擅自下载。")
    return hard, soft


def main(argv=None):
    p = argparse.ArgumentParser(description="CommitBrew Coffee AI 环境检测")
    p.add_argument("--check-model", default=None, help="检查该 HF 模型是否已在本地缓存")
    p.add_argument("--min-mem-gb", type=float, default=8.0)
    p.add_argument("--min-disk-gb", type=float, default=20.0)
    p.add_argument("--model-size-gb", type=float, default=3.0,
                   help="待下载/使用模型的预估大小（GB），用于磁盘检查")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)

    info = collect(args.check_model)
    hard, soft = evaluate(info, args.min_mem_gb, args.min_disk_gb, args.model_size_gb)
    info["hard_failures"] = hard
    info["soft_notices"] = soft
    info["ok"] = not hard

    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
    else:
        print("=" * 62)
        print("CommitBrew Coffee AI — 环境检测")
        print("=" * 62)
        print(f"系统/架构 : {info['os']}  {info['machine']}")
        print(f"芯片      : {info['chip']}")
        print(f"统一内存  : {info['memory_gb']} GB")
        print(f"可用磁盘  : {info['disk_free_gb']} GB")
        print(f"Python    : {info['python_version']}  ({info['python_executable']})")
        print(f"mlx       : {info['mlx_version']}")
        print(f"mlx-lm    : {info['mlx_lm_version']}")
        print(f"HF 缓存   : {info['hf_cache_gb']} GB  ({info['hf_cache_dir']})")
        if info["model"]:
            cached = info["model_cached"]
            print(f"模型 {info['model']}: " + (f"已在本地 ({cached['size_gb']} GB)" if cached else "不在本地缓存"))
        print("-" * 62)
        for h in hard:
            print(f"✗ [不满足] {h}")
        for s in soft:
            print(f"⚠ [提示]   {s}")
        if hard:
            print("结论: 环境不满足硬性要求。")
        else:
            print("结论: 环境满足要求。")
    sys.exit(0 if not hard else 1)


if __name__ == "__main__":
    main()
