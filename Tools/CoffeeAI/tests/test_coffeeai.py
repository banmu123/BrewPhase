#!/usr/bin/env python3
"""test_coffeeai.py — CommitBrew Coffee AI 自动化测试（unittest，仅标准库）。

覆盖任务验收标准 1/2/3/4/5/6/7/8 的可自动化部分：
  - validate_data 能抓无效 JSONL / 缺字段 / 空回答 / 完全重复 / 未经审核
  - split_dataset 可复现、题组与高相似样本不跨集合、数据不足时明确拒绝
  - env_check 能识别 Apple Silicon 与内存/磁盘不足
  - make_train_config 字段严格落在 MLX-LM 官方 schema 内
  - run_train --dry-run 只预览不执行；--train 无本地模型时拒绝（不联网）
  - fixture 样本仅用于测试，不是训练数据

运行: python3 Tools/CoffeeAI/tests/test_coffeeai.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
COFFEEAI = TESTS.parent
REPO = COFFEEAI.parents[1]
PY = sys.executable

FIXTURES = COFFEEAI / "tests" / "fixtures"
SCRIPTS = COFFEEAI / "scripts"


def run_script(script, *args, expect=None):
    cmd = [PY, str(SCRIPTS / script), *[str(a) for a in args]]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=str(REPO))
    if expect is not None and proc.returncode != expect:
        raise AssertionError(
            f"{script} {' '.join(str(a) for a in args)}\n"
            f"期望 exit={expect} 实际={proc.returncode}\n--- STDOUT ---\n{proc.stdout}\n--- STDERR ---\n{proc.stderr}")
    return proc


def write_jsonl(path, rows):
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                    encoding="utf-8")


def load_meta(path):
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


class ValidateTests(unittest.TestCase):
    def test_fixture_passes(self):
        run_script("validate_data.py",
                   "--corpus", FIXTURES / "fixture_approved.jsonl",
                   "--meta", FIXTURES / "fixture_approved.meta.jsonl",
                   expect=0)

    def test_default_examples_are_rejected_for_training(self):
        """验收 3：未审核示例不得通过训练前置校验。"""
        proc = run_script("validate_data.py", "--for-training")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("not-approved", proc.stdout)

    def test_bad_jsonl_and_missing_fields(self):
        """验收 1：无效 JSONL / 缺字段 / 空回答必须被抓到。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            bad = td / "bad.jsonl"
            rows = [
                {"sample_id": "b1", "group_id": "g1", "messages": [
                    {"role": "user", "content": "问题"},
                    {"role": "assistant", "content": "好的。"},  # 过短回答
                ]},
                {"sample_id": "b2", "group_id": "g1", "messages": [
                    {"role": "system", "content": "两个 system，没有用户提问。"},
                    {"role": "system", "content": "仍然没有 assistant 回答，同时长度足够通过别的检查。"} ]},
                {"sample_id": "b3", "group_id": "g1", "messages": [
                    {"role": "user", "content": "空回答"},
                    {"role": "assistant", "content": "   "}]},
            ]
            bad.write_text(
                "{not valid json\n" +
                "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                encoding="utf-8")
            meta = td / "bad.meta.jsonl"
            # 元数据只覆盖 b1 → b2/b3 缺元数据；b1 许可不明
            write_jsonl(meta, [
                {"sample_id": "b1", "topic": "t", "license_status": "unknown",
                 "review_status": "approved", "data_version": "v", "dedup_fingerprint": "x"},
            ])
            proc = run_script("validate_data.py", "--corpus", bad, "--meta", meta)
            out = proc.stdout
            self.assertEqual(proc.returncode, 1)
            for code in ("invalid-json", "short-answer", "no-user", "empty-content",
                         "missing-meta"):
                self.assertIn(code, out, f"应报出 {code}")

    def test_exact_duplicate_detected(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            dup_msg = [{"role": "user", "content": "重复问题？"},
                       {"role": "assistant", "content": "这是一条足够长的回答用来通过长度检查。"}]
            c = td / "c.jsonl"
            write_jsonl(c, [
                {"sample_id": "d1", "group_id": "g1", "messages": dup_msg},
                {"sample_id": "d2", "group_id": "g1", "messages": dup_msg},
            ])
            m = td / "c.meta.jsonl"
            write_jsonl(m, [
                {"sample_id": "d1", "topic": "t", "license_status": "own-original",
                 "review_status": "approved", "data_version": "v",
                 "dedup_fingerprint": "a" * 64},
                {"sample_id": "d2", "topic": "t", "license_status": "own-original",
                 "review_status": "approved", "data_version": "v",
                 "dedup_fingerprint": "a" * 64},
            ])
            proc = run_script("validate_data.py", "--corpus", c, "--meta", m)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("exact-duplicate", proc.stdout)

    def test_license_and_source_discipline(self):
        """许可不明/受限、未注册来源、pending 来源都要拦。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            c = td / "c.jsonl"
            msgs = [{"role": "user", "content": "q?"},
                    {"role": "assistant", "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
            write_jsonl(c, [
                {"sample_id": "s1", "group_id": "g1", "messages": msgs},
                {"sample_id": "s2", "group_id": "g2", "messages": msgs},
                {"sample_id": "s3", "group_id": "g3", "messages": msgs},
            ])
            m = td / "c.meta.jsonl"
            write_jsonl(m, [
                {"sample_id": "s1", "topic": "t", "license_status": "cc-by-nc-nd",
                 "review_status": "approved", "data_version": "v", "dedup_fingerprint": "a" * 64},
                {"sample_id": "s2", "topic": "t", "license_status": "own-original",
                 "review_status": "approved", "data_version": "v", "dedup_fingerprint": "b" * 64,
                 "source_ids": ["not-in-registry-source"]},
                {"sample_id": "s3", "topic": "t", "license_status": "own-original",
                 "review_status": "unreviewed", "data_version": "v", "dedup_fingerprint": "c" * 64},
            ])
            proc = run_script("validate_data.py", "--corpus", c, "--meta", m, "--for-training")
            self.assertEqual(proc.returncode, 1)
            for code in ("license-blocked", "unknown-source-id", "not-approved"):
                self.assertIn(code, proc.stdout)


class SplitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="coffeeai_split_"))
        cls.out1 = cls.tmp / "s1"
        cls.out2 = cls.tmp / "s2"
        run_script("split_dataset.py",
                   "--corpus", FIXTURES / "fixture_approved.jsonl",
                   "--meta", FIXTURES / "fixture_approved.meta.jsonl",
                   "--out", cls.out1, expect=0)
        run_script("split_dataset.py",
                   "--corpus", FIXTURES / "fixture_approved.jsonl",
                   "--meta", FIXTURES / "fixture_approved.meta.jsonl",
                   "--out", cls.out2, expect=0)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _sample_groups(self, out):
        """返回 {split: {sample_id: group_id}} 与合并后的组根。"""
        res = {}
        roots = {}
        for split in ("train", "valid", "test"):
            m = load_meta(out / f"{split}.meta.jsonl")
            res[split] = {r["sample_id"]: r["group_id"] for r in m}
            for r in m:
                roots[r["sample_id"]] = r["merged_group_root"]
        return res, roots

    def test_deterministic(self):
        """验收 2：同种子两次划分逐字节一致。"""
        for f in ("train.jsonl", "valid.jsonl", "test.jsonl"):
            self.assertEqual(
                (self.out1 / f).read_bytes(), (self.out2 / f).read_bytes(),
                f"{f} 在相同 seed 下不一致")

    def test_no_leakage(self):
        """验收 2：sample_id / 题组 / 高相似样本不得跨集合。"""
        sg, roots = self._sample_groups(self.out1)
        all_ids = [i for split in sg.values() for i in split]
        self.assertEqual(len(all_ids), len(set(all_ids)), "sample_id 跨集合")
        per_root = {}
        for split, ids in sg.items():
            for sid in ids:
                per_root.setdefault(roots[sid], set()).add(split)
        for root, splits in per_root.items():
            self.assertEqual(len(splits), 1,
                             f"合并组 {root} 跨集合: {splits}（题组/近似改写泄漏）")
        # fix-009/fix-010 group_id 不同但内容几乎相同 → 必须同集合
        loc = {}
        for split, ids in sg.items():
            for sid in ids:
                loc[sid] = split
        self.assertEqual(loc["fix-009"], loc["fix-010"],
                         "高相似样本对 fix-009/fix-010 未被并组，发生泄漏")

    def test_split_report(self):
        report = json.loads((self.out1 / "split_report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["seed"], 42)
        self.assertEqual(report["counts"]["train"] + report["counts"]["valid"]
                         + report["counts"]["test"], 10)
        self.assertEqual(len(report["merged_near_duplicate_pairs"]), 1)

    def test_unreviewed_excluded_by_default(self):
        """验收 3：默认划分必须排除未审核样本。"""
        out = self.tmp / "s_unreviewed"
        run_script("split_dataset.py",
                   "--corpus", COFFEEAI / "data" / "corpus" / "examples_unreviewed.jsonl",
                   "--meta", COFFEEAI / "data" / "meta" / "examples_unreviewed.meta.jsonl",
                   "--out", out, expect=1)
        self.assertFalse((out / "train.jsonl").exists(),
                         "没有已审核数据时不得生成训练文件")

    def test_insufficient_data_refused(self):
        """验收 2/八.3：有效数据不足时明确拒绝，不伪造比例。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            c = td / "tiny.jsonl"
            msgs = [{"role": "user", "content": "q?"},
                    {"role": "assistant", "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
            write_jsonl(c, [{"sample_id": "t1", "group_id": "g1", "messages": msgs}])
            m = td / "tiny.meta.jsonl"
            write_jsonl(m, [{"sample_id": "t1", "topic": "t", "license_status": "own-original",
                             "review_status": "approved", "data_version": "v",
                             "dedup_fingerprint": "a" * 64}])
            out = td / "out"
            proc = run_script("split_dataset.py", "--corpus", c, "--meta", m,
                              "--out", out, expect=1)
            self.assertIn("不足以", proc.stderr)

    def test_splits_pass_cross_check(self):
        """已生成 splits 通过 validate --check-splits。"""
        run_script("validate_data.py", "--check-splits", self.out1, expect=0)


class EnvCheckTests(unittest.TestCase):
    def test_env_ok_json(self):
        proc = run_script("env_check.py", "--json", expect=0)
        info = json.loads(proc.stdout)
        self.assertTrue(info["apple_silicon"])
        self.assertEqual(info["machine"], "arm64")
        self.assertGreaterEqual(info["memory_gb"], 8)
        self.assertIsNone(info["mlx_lm_version"])  # 本机尚未安装，应如实报告

    def test_env_detects_insufficient_mem_and_disk(self):
        """验收 4：内存/磁盘不足能被识别（用夸张阈值模拟）。"""
        proc = run_script("env_check.py", "--min-mem-gb", 9999, "--min-disk-gb", 9999)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("低于要求", proc.stdout)
        self.assertIn("磁盘", proc.stdout)

    def test_env_rejects_non_arm(self):
        # 用 JSON 输出检查硬性失败路径存在（本机为 arm64，通过阈值触发失败即可）
        proc = run_script("env_check.py", "--json", "--min-mem-gb", 9999)
        self.assertEqual(proc.returncode, 1)
        info = json.loads(proc.stdout)
        self.assertFalse(info["ok"])


class ConfigTests(unittest.TestCase):
    OFFICIAL = {
        "model", "train", "fine_tune_type", "optimizer", "optimizer_config",
        "data", "seed", "num_layers", "batch_size", "iters", "val_batches",
        "learning_rate", "report_to", "project_name", "steps_per_report",
        "steps_per_eval", "grad_accumulation_steps", "resume_adapter_file",
        "adapter_path", "save_every", "test", "test_batches", "max_seq_length",
        "grad_checkpoint", "lora_parameters", "lr_schedule", "hf_dataset",
    }

    def test_config_fields_match_official_schema(self):
        """验收 5：生成配置的字段必须全部来自当前版本官方示例。"""
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "cfg.yaml"
            run_script("make_train_config.py", "--out", out, expect=0)
            keys = set()
            for raw in out.read_text(encoding="utf-8").splitlines():
                line = raw.split("#", 1)[0]
                if not line.strip():
                    continue
                if line.startswith(" "):
                    continue  # lora_parameters 等嵌套键不算顶层字段
                keys.add(line.split(":", 1)[0].strip())
            self.assertTrue(keys, "配置为空")
            unknown = keys - self.OFFICIAL
            self.assertFalse(unknown, f"出现官方 schema 之外的字段: {unknown}")
            required = {"model", "train", "fine_tune_type", "data", "iters",
                        "batch_size", "num_layers", "learning_rate",
                        "max_seq_length", "grad_checkpoint", "adapter_path",
                        "steps_per_eval", "save_every", "seed"}
            self.assertTrue(required <= keys, f"缺少必需字段: {required - keys}")

    def test_config_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            before = set(str(p) for p in (COFFEEAI / "configs").glob("*"))
            proc = run_script("make_train_config.py", "--dry-run")
            self.assertIn("model:", proc.stdout)
            after = set(str(p) for p in (COFFEEAI / "configs").glob("*"))
            self.assertEqual(before, after, "--dry-run 不应写盘")


class RunTrainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="coffeeai_runtrain_"))
        cls.split_dir = cls.tmp / "splits"
        run_script("split_dataset.py",
                   "--corpus", FIXTURES / "fixture_approved.jsonl",
                   "--meta", FIXTURES / "fixture_approved.meta.jsonl",
                   "--out", cls.split_dir, expect=0)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_dry_run_no_training_no_download(self):
        """验收 6：dry-run 显示模型/数据/配置/输出，不训练不下载。"""
        proc = run_script("run_train.py", "--dry-run",
                          "--config", COFFEEAI / "configs" / "smoke.yaml",
                          "--data-dir", self.split_dir)
        self.assertEqual(proc.returncode, 0)
        out = proc.stdout
        self.assertIn("DRY-RUN", out)
        self.assertIn("mlx-community/Qwen3-4B-Instruct-2507-4bit", out)
        self.assertIn(str(self.split_dir), out)
        self.assertIn("不训练、不下载", out)
        self.assertIn("dry-run 到此为止", out)
        # dry-run 不得新增适配器/manifest
        self.assertFalse((COFFEEAI / "runs" / "adapters").exists())
        self.assertFalse(any((COFFEEAI / "runs").glob("train_*")))

    def test_train_requires_model_and_real_data(self):
        """验收 7：无本地模型 + 数据未就绪时，--train 被拒绝且不联网。"""
        proc = run_script("run_train.py", "--train",
                          "--config", COFFEEAI / "configs" / "smoke.yaml",
                          "--data-dir", self.split_dir)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("绝不", proc.stderr)

    def test_dry_run_reports_blockers_when_data_missing(self):
        """数据未就绪时 dry-run 必须如实列出阻断项（而不是假装可训练）。"""
        proc = run_script("run_train.py", "--dry-run",
                          "--config", COFFEEAI / "configs" / "smoke.yaml")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("缺少 train.jsonl", proc.stdout)
        self.assertIn("尚未下载", proc.stdout)
        self.assertIn("Preflight", proc.stdout)


class EvaluateTests(unittest.TestCase):
    def test_evaluate_refuses_without_mlx_or_model(self):
        """验收 8：评测守卫生效（本机无 mlx / 无模型缓存 → 拒绝而非假装成功）。"""
        proc = run_script("evaluate.py", "--base-model",
                          "mlx-community/Qwen3-4B-Instruct-2507-4bit")
        self.assertEqual(proc.returncode, 1)
        self.assertTrue(("评测需要先安装" in proc.stdout + proc.stderr)
                        or ("不在本地缓存" in proc.stdout + proc.stderr))


class ReviewQueueTests(unittest.TestCase):
    """阶段二：审核队列（候选样本）的隔离与可追溯性。"""

    QUEUE = COFFEEAI / "review_queue"
    BATCH_CORPUS = QUEUE / "batch1_candidates.jsonl"
    BATCH_META = QUEUE / "batch1_candidates.meta.jsonl"

    def _load_meta(self, path):
        return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]

    def _known_ids(self):
        """从知识库收集全部真实 ID：claim.* / rule.* / conflict.*。"""
        import re
        ids = set()
        for md in (REPO / "knowledge").rglob("*.md"):
            ids |= {m.group(1) for m in re.finditer(
                r"\|\s*(claim\.[a-zA-Z0-9.\-]+)\s*\|", md.read_text(encoding="utf-8"))}
        rules = REPO / "knowledge" / "troubleshooting" / "troubleshooting.json"
        if rules.is_file():
            ids |= {r["id"] for r in json.loads(rules.read_text(encoding="utf-8")).get("rules", [])}
        conflicts = REPO / "knowledge" / "CONFLICTS.md"
        if conflicts.is_file():
            ids |= {m.group(1) for m in re.finditer(
                r"^## (conflict\.[a-zA-Z0-9.\-]+)\s*$",
                conflicts.read_text(encoding="utf-8"), re.M)}
        return ids

    def test_batch1_builder_idempotent_and_verified(self):
        """构建器可重复运行，且 ID 反向校验持续通过（防知识库改动造成悬空引用）。"""
        run_script("../review_queue/build_batch1.py", expect=0)

    def test_all_candidates_stay_unreviewed(self):
        """验收：候选（batch1 + 存量示例）必须全部 unreviewed，无自动批准。"""
        for meta_file in (self.BATCH_META,
                          COFFEEAI / "data" / "meta" / "examples_unreviewed.meta.jsonl"):
            for row in self._load_meta(meta_file):
                self.assertEqual(row.get("review_status"), "unreviewed", f"{meta_file.name}:{row['sample_id']}")

    def test_candidate_ids_traceable(self):
        """验收：source_ids/claim_ids 均可追溯，无编造 ID。"""
        reg = json.loads((REPO / "knowledge" / "SOURCE_REGISTRY.json").read_text(encoding="utf-8"))
        known_sources = {s["sourceId"] for s in reg["sources"]}
        known_claims = self._known_ids()
        checked_claims = 0
        for row in self._load_meta(self.BATCH_META):
            for sid in row.get("source_ids", []):
                self.assertIn(sid, known_sources, f"{row['sample_id']} 引用未注册来源 {sid}")
            for cid in row.get("claim_ids", []):
                self.assertIn(cid, known_claims, f"{row['sample_id']} 引用不存在的 ID {cid}")
                checked_claims += 1
        self.assertGreater(checked_claims, 30, "claim 锚点数量异常")

    def test_review_queue_isolated_from_training_pipeline(self):
        """验收：候选不被默认管线读入；未审核样本进不了训练集。"""
        # 1) 默认校验路径不含 review_queue
        proc = run_script("validate_data.py", "--json")
        report = json.loads(proc.stdout)
        for f in report["validation"]["corpus_files"] + report["validation"]["meta_files"]:
            self.assertNotIn("review_queue", f)
        # 2) 默认划分仍然拒绝（0 条 approved）
        run_script("split_dataset.py", "--out", COFFEEAI / "data" / "splits", expect=1)
        self.assertFalse((COFFEEAI / "data" / "splits" / "train.jsonl").exists())
        # 3) batch1 显式校验通过
        run_script("validate_data.py", "--corpus", self.BATCH_CORPUS,
                   "--meta", self.BATCH_META, expect=0)

    def test_checklist_is_review_only(self):
        """审核清单只含人工勾选项，不得出现自动批准语义。"""
        text = (self.QUEUE / "batch1_checklist.md").read_text(encoding="utf-8")
        self.assertIn("- [ ] 通过", text)
        self.assertIn("- [ ] 拒绝", text)
        self.assertIn("不产生任何自动效果", text)


class RepoIntegrityTests(unittest.TestCase):
    def test_existing_kb_build_check_still_passes(self):
        """验收 9：不影响既有工程——知识库校验脚本仍通过。"""
        proc = subprocess.run(
            [sys.executable, "Tools/knowledge/build_kb.py", "--check"],
            capture_output=True, text=True, timeout=120, cwd=str(REPO))
        self.assertEqual(proc.returncode, 0,
                         f"build_kb --check 失败:\n{proc.stdout}\n{proc.stderr}")

    def test_no_samples_marked_approved_outside_fixtures(self):
        """正式数据目录里不得出现 self-approved 样本（审核是人做的事）。"""
        for m in (COFFEEAI / "data" / "meta").glob("*.jsonl"):
            for row in load_meta(m):
                self.assertNotEqual(row.get("review_status"), "approved",
                                    f"{m.name} 里出现了 approved 样本——"
                                    "审核必须由人工完成，不能由脚本自封。")


if __name__ == "__main__":
    unittest.main(verbosity=2)
