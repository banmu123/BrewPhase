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
from datetime import date
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
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import (messages_fingerprint,
                                         reviewed_record_sha256)
            tiny_msgs = [{"role": "user", "content": "q?"},
                         {"role": "assistant",
                          "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
            tiny_meta = {"sample_id": "t1", "topic": "t", "license_status": "own-original",
                         "review_status": "approved", "data_version": "v",
                         "dedup_fingerprint": "a" * 64,
                         "reviewed_content_sha256": messages_fingerprint(tiny_msgs),
                         "source_ids": [], "claim_ids": [], "source_usage": None,
                         "source_waiver": "测试样本：无外部事实来源。"}
            tiny_meta["reviewed_record_sha256"] = reviewed_record_sha256(tiny_meta, tiny_msgs)
            write_jsonl(m, [tiny_meta])
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
                          "--data-dir", self.split_dir,
                          "--deployment-purpose", "noncommercial-research")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("绝不", proc.stderr)

    def test_dry_run_reports_blockers_when_data_missing(self):
        """数据未就绪时 dry-run 必须如实列出阻断项（而不是假装可训练）。"""
        # 六点九-E：正式 splits 已存在，显式传空数据目录构造「数据缺失」场景
        with tempfile.TemporaryDirectory() as td:
            empty_dir = Path(td) / "splits"
            empty_dir.mkdir()
            proc = run_script("run_train.py", "--dry-run",
                              "--config", COFFEEAI / "configs" / "smoke.yaml",
                              "--data-dir", empty_dir)
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

    def test_all_candidates_review_status_disciplined(self):
        """验收（阶段五点七演进）：候选状态只允许两种——
        unreviewed（默认）或 approved（必须带审批人与双指纹）；禁止其它状态、
        禁止无审批记录的 approved（防自动批准）。"""
        for meta_file in (self.BATCH_META,
                          COFFEEAI / "data" / "meta" / "examples_unreviewed.meta.jsonl"):
            for row in self._load_meta(meta_file):
                st = row.get("review_status")
                if st == "unreviewed":
                    continue
                if st == "approved":
                    # approved 必须有完整审批记录（防无审批人的自动批准）
                    self.assertTrue(str(row.get("reviewed_by") or "").strip(),
                                    f"{meta_file.name}:{row['sample_id']} approved 缺 reviewed_by")
                    self.assertTrue(str(row.get("reviewed_at") or "").strip(),
                                    f"{meta_file.name}:{row['sample_id']} approved 缺 reviewed_at")
                    self.assertTrue(str(row.get("reviewed_content_sha256") or "").strip(),
                                    f"{meta_file.name}:{row['sample_id']} approved 缺内容指纹")
                    self.assertTrue(str(row.get("reviewed_record_sha256") or "").strip(),
                                    f"{meta_file.name}:{row['sample_id']} approved 缺记录指纹")
                else:
                    self.fail(f"{meta_file.name}:{row['sample_id']} 非法状态: {st!r}")

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
        # 2) 默认划分仍然拒绝（0 条 approved），且不得在任何输出目录留下 train.jsonl
        #    （六点九-E：data/splits 已有正式划分，改用临时目录验证，不碰真实产物）
        with tempfile.TemporaryDirectory() as td:
            out_dir = Path(td) / "splits"
            run_script("split_dataset.py", "--out", out_dir, expect=1)
            self.assertFalse((out_dir / "train.jsonl").exists())
        # 2b) 正式划分（若存在）必须只含 approved 样本——未审核样本进不了训练集
        train_meta = COFFEEAI / "data" / "splits" / "train.meta.jsonl"
        if train_meta.exists():
            for line in train_meta.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    self.assertEqual(json.loads(line).get("review_status"), "approved",
                                     "训练集出现未审核样本")
        # 3) batch1 显式校验通过
        run_script("validate_data.py", "--corpus", self.BATCH_CORPUS,
                   "--meta", self.BATCH_META, expect=0)

    def test_checklist_is_review_only(self):
        """审核清单只含人工勾选项，不得出现自动批准语义。"""
        text = (self.QUEUE / "batch1_checklist.md").read_text(encoding="utf-8")
        self.assertIn("- [ ] 通过", text)
        self.assertIn("- [ ] 拒绝", text)
        self.assertIn("不产生任何自动效果", text)


class TrainingAdmissionTests(unittest.TestCase):
    """阶段三 P0：--include-unreviewed 的产物进不了正式训练。"""

    MSG_OK = [{"role": "user", "content": "问题？"},
              {"role": "assistant", "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]

    _CONTENT = [
        ("V60 滤杯的肋骨有什么作用？",
         "肋骨影响水流与排气路径，不同滤杯设计的流速差异明显。冲煮时应以实际滴滤速度为准做对比，参数只是起点。"),
        ("意式粉饼为什么要压平？",
         "平整的粉床有助于水流均匀通过，减少通道效应。官方建议填压后粉面与滤杯刻痕对齐，具体手法以机型说明为准。"),
        ("冷萃和冰滴是一回事吗？",
         "两者都是低温萃取，但制作方式不同：浸泡式冷萃把粉长时间泡在水里，冰滴则是让冷水缓慢滴过粉层。风味取向与设备都不同。"),
        ("为什么磨豆机用久了要清理？",
         "残粉滞留会影响出粉量与新豆风味，厂商也把清洁不足列为保修除外情形。定期清理并用部件图定位零件是推荐做法。"),
        ("咖啡果皮能利用吗？",
         "咖啡加工副产物包括果肉、果壳等，行业有循环利用的研究与讨论；具体利用方式与效果请参考专门资料，不要凭印象断言。"),
    ]

    def _mixed_corpus(self, td):
        c, m = Path(td) / "mixed.jsonl", Path(td) / "mixed.meta.jsonl"
        rows_c, rows_m = [], []
        plan = [("adm-a1", "g-adm-1", "approved"), ("adm-a2", "g-adm-2", "approved"),
                ("adm-a3", "g-adm-3", "approved"), ("adm-u1", "g-adm-4", "unreviewed"),
                ("adm-u2", "g-adm-5", "unreviewed")]
        for i, (sid, gid, status) in enumerate(plan):
            q, a = self._CONTENT[i]
            msgs = [{"role": "user", "content": q},
                    {"role": "assistant", "content": a}]
            rows_c.append({"sample_id": sid, "group_id": gid, "messages": msgs})
            meta = {"sample_id": sid, "group_id": gid, "topic": "t",
                    "source_doc": "t", "source_ids": [], "claim_ids": [],
                    "license_status": "own-original", "review_status": status,
                    "data_version": "v", "dedup_fingerprint": "a" * 64,
                    "source_waiver": "测试样本：行为演示，无外部事实来源。"}
            if status == "approved":
                # 阶段四/六：approved 样本必须绑定审核内容与审核记录指纹
                sys.path.insert(0, str(SCRIPTS))
                from coffeeai_common import (messages_fingerprint,
                                             reviewed_record_sha256)
                meta["reviewed_content_sha256"] = messages_fingerprint(msgs)
                meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
            rows_m.append(meta)
        write_jsonl(c, rows_c)
        write_jsonl(m, rows_m)
        return c, m

    def test_include_unreviewed_splits_blocked_from_formal_training(self):
        """完整模拟：--include-unreviewed 生成划分 → 正式训练被阻断。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._mixed_corpus(td)
            out = Path(td) / "splits"
            run_script("split_dataset.py", "--corpus", c, "--meta", m,
                       "--out", out, "--include-unreviewed", expect=0)
            # 划分确实产出了含未审核样本的文件
            meta_rows = load_meta(out / "train.meta.jsonl") + \
                load_meta(out / "valid.meta.jsonl") + load_meta(out / "test.meta.jsonl")
            self.assertEqual(len(meta_rows), 5)
            self.assertTrue(any(r["review_status"] == "unreviewed" for r in meta_rows))
            # 正式训练必须被准入复查阻断
            proc = run_script("run_train.py", "--train",
                              "--config", COFFEEAI / "configs" / "smoke.yaml",
                              "--data-dir", out,
                              "--deployment-purpose", "noncommercial-research")
            self.assertEqual(proc.returncode, 1)
            combined = proc.stdout + proc.stderr
            self.assertIn("准入复查未通过", combined)
            self.assertIn("unreviewed", combined)
            self.assertFalse(any((COFFEEAI / "runs").glob("train_*")),
                             "不得产生任何训练运行目录")
            self.assertFalse((COFFEEAI / "runs" / "adapters").exists())

    def test_check_admission_cli(self):
        """准入复查 CLI：合格划分通过；含未审核样本的划分被拒。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._mixed_corpus(td)
            out_bad = Path(td) / "splits_bad"
            run_script("split_dataset.py", "--corpus", c, "--meta", m,
                       "--out", out_bad, "--include-unreviewed", expect=0)
            proc = run_script("validate_data.py", "--check-admission", out_bad, "--json")
            report = json.loads(proc.stdout)
            self.assertEqual(proc.returncode, 1)
            codes = {i["code"] for i in report["admission"]["issues"]}
            self.assertIn("admission-not-approved", codes)

    def test_admission_requires_metadata_one_to_one(self):
        """缺 meta 行 / meta 多行都要被拦。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            out = td / "splits"
            out.mkdir()
            (out / "train.jsonl").write_text(
                json.dumps({"sample_id": "x1", "messages": self.MSG_OK}, ensure_ascii=False) + "\n",
                encoding="utf-8")
            # 缺 train.meta.jsonl
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("admission-meta-missing", proc.stdout)
            # meta 有但 sample_id 对不上
            (out / "train.meta.jsonl").write_text(
                json.dumps({"sample_id": "OTHER", "review_status": "approved",
                            "license_status": "own-original", "data_version": "v",
                            "dedup_fingerprint": "a" * 64,
                            "source_waiver": "w"}, ensure_ascii=False) + "\n",
                encoding="utf-8")
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("admission-meta-missing", proc.stdout)


class SourceAdmissionTests(unittest.TestCase):
    """阶段三/四：来源级训练准入（默认拒绝 + 可审计人工例外；全部使用真实注册表来源）。"""

    def _one_sample(self, td, source_ids, claim_ids, usage=None, waiver=None,
                    review="approved", license_status="own-original", topic="t"):
        c = Path(td) / "s.jsonl"
        m = Path(td) / "s.meta.jsonl"
        msgs = [{"role": "user", "content": "问题？"},
                {"role": "assistant", "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
        write_jsonl(c, [{"sample_id": "sa1", "group_id": "g-sa", "messages": msgs}])
        meta = {"sample_id": "sa1", "group_id": "g-sa", "topic": topic, "source_doc": "t",
                "source_ids": source_ids, "claim_ids": claim_ids,
                "license_status": license_status, "review_status": review,
                "data_version": "v", "dedup_fingerprint": "a" * 64}
        if usage is not None:
            meta["source_usage"] = usage
        if waiver is not None:
            meta["source_waiver"] = waiver
        if review == "approved":
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import (messages_fingerprint,
                                         reviewed_record_sha256)
            meta["reviewed_content_sha256"] = messages_fingerprint(msgs)
            meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
        write_jsonl(m, [meta])
        return c, m

    def _for_training(self, c, m, exceptions=None, purpose=None, json_mode=False):
        args = ["validate_data.py", "--corpus", c, "--meta", m, "--for-training"]
        if exceptions is not None:
            exc = Path(exceptions)
            if not exc.is_absolute():
                exc = Path.cwd() / exc
            args += ["--source-exceptions", exc]
        if purpose:
            args += ["--deployment-purpose", purpose]
        if json_mode:
            args += ["--json"]
        return run_script(*args)

    def _assert_admission_ok(self, proc):
        """阶段四点六：正向测试必须证明退出成功，而非仅看输出不含某错误串。"""
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["validation"]["errors"], 0,
                         json.dumps(report["validation"]["issues"], ensure_ascii=False))
        return report

    def _write_exceptions(self, td, entries):
        p = Path(td) / "exceptions.json"
        p.write_text(json.dumps({"schemaVersion": 2, "exceptions": entries},
                                ensure_ascii=False, indent=2), encoding="utf-8")
        return p

    def _full_exception(self, **overrides):
        """阶段四点五：字段与范围完整的例外模板。"""
        exc = {
            "sourceId": "wcr-varieties-catalog",
            "usage": "fact-extraction-rewrite",
            "reason": "注册表口径：品种知识仅可独立改写，禁止复制目录表格",
            "approved_by": "人工审核人（测试占位）",
            "approved_at": "2026-10-14",
            "scope": "仅非商业训练样本；逐条人工审核；不复制原文",
            "deployment_purposes": ["noncommercial-research"],
            "allowed_sample_ids": ["sa1"],
            "allowed_topics": ["varieties"],
            "allowed_claim_ids": ["claim.varieties.no-absolute-data"],
            "license_basis": {"basis": "registry-sanctioned-use",
                              "evidence_ref": "knowledge/SOURCE_REGISTRY.md §2 wcr 行"},
        }
        exc.update(overrides)
        return exc

    def test_wcr_catalog_blocked_by_default(self):
        """阶段四核心回归：wcr-varieties-catalog（NC-ND + 禁商用/禁衍生）默认必须被阻断，
        source_usage 声明不能替代人工例外。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._for_training(c, m)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-requires-human-exception", proc.stdout)
            self.assertIn("wcr-varieties-catalog", proc.stdout)

    def test_valid_human_exception_unblocks(self):
        """字段完整、范围匹配、用途匹配的有效例外才放行。"""
        with tempfile.TemporaryDirectory() as td:
            exc = self._write_exceptions(td, [self._full_exception()])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"},
                                    topic="varieties")
            proc = self._for_training(c, m, exceptions=exc, purpose="noncommercial-research",
                                      json_mode=True)
            self._assert_admission_ok(proc)
            self.assertNotIn("source-requires-human-exception", proc.stdout)
            self.assertNotIn("exception-out-of-scope", proc.stdout)

    def test_incomplete_exception_still_blocks(self):
        """例外缺审批人 → fail-closed，仍然阻断，并给出无效提示。"""
        with tempfile.TemporaryDirectory() as td:
            exc = self._write_exceptions(td, [{
                "sourceId": "wcr-varieties-catalog", "usage": "fact-extraction-rewrite",
                "reason": "缺审批人的例外", "approved_by": "", "approved_at": "2026-10-14",
                "scope": "n/a",
            }])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._for_training(c, m, exceptions=exc)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-requires-human-exception", proc.stdout)
            self.assertIn("exception-invalid", proc.stdout)

    def test_expired_exception_still_blocks(self):
        """阶段四点七：过期测试独立——除 valid_until 外所有字段完整有效、
        范围与用途均匹配，断言拒绝原因明确指向「过期」而非字段缺失。"""
        with tempfile.TemporaryDirectory() as td:
            exc = self._write_exceptions(td, [self._full_exception(
                approved_at="2026-01-01",
                valid_until="2026-01-02",
                deployment_purposes=["noncommercial-research"],
                allowed_sample_ids=["sa1"],
                allowed_topics=["varieties"],
                allowed_claim_ids=["claim.varieties.no-absolute-data"],
                license_basis={"basis": "registry-sanctioned-use",
                               "evidence_ref": "knowledge/SOURCE_REGISTRY.md §2"})])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"},
                                    topic="varieties")
            proc = self._for_training(c, m, exceptions=exc,
                                      purpose="noncommercial-research", json_mode=True)
            self.assertEqual(proc.returncode, 1)
            report = json.loads(proc.stdout)
            invalid = [i for i in report["validation"]["issues"]
                       if i.get("code") == "exception-invalid"]
            self.assertTrue(invalid, "应给出 exception-invalid 提示")
            self.assertIn("过期", " ".join(i["message"] for i in invalid))
            codes = {i["code"] for i in report["validation"]["issues"]}
            self.assertIn("source-requires-human-exception", codes)

    def test_public_domain_auto_allowed(self):
        """fda-caffeine（public-domain + allowed/allowed）无需例外即可自动准入。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["fda-caffeine"], ["claim.health.fda-400"],
                                    {"fda-caffeine": "fact-extraction-rewrite"})
            proc = self._for_training(c, m, purpose="noncommercial-research", json_mode=True)
            self._assert_admission_ok(proc)
            self.assertNotIn("source-requires-human-exception", proc.stdout)
            self.assertNotIn("source-blocked-status", proc.stdout)

    def test_unclear_fields_require_exception_even_with_usage(self):
        """commercialUse/derivatives unclear 的 see-source-terms 来源：声明 usage 也不自动准入。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["sca-coffee-standards"],
                                    ["claim.sensory.cva-four"],
                                    {"sca-coffee-standards": "fact-extraction-rewrite"})
            proc = self._for_training(c, m)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-requires-human-exception", proc.stdout)

    def test_pending_verification_source_blocks_training(self):
        """真实存在的待核验来源（wcr-sensory-lexicon）必须阻断训练。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["wcr-sensory-lexicon"], [], {})
            proc = self._for_training(c, m)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-blocked-status", proc.stdout)

    def test_paywalled_and_restricted_sources_block_training(self):
        """付费墙（sca-digital-store）与受限资产（sca-flavor-wheel-2016）阻断。"""
        for sid in ("sca-digital-store", "sca-flavor-wheel-2016"):
            with tempfile.TemporaryDirectory() as td:
                c, m = self._one_sample(td, [sid], [], {sid: "fact-extraction-rewrite"})
                proc = self._for_training(c, m)
                self.assertEqual(proc.returncode, 1, sid)
                self.assertIn("source-blocked-status", proc.stdout, sid)

    def test_claim_linkage_required_when_sources_cited(self):
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["fda-caffeine"], [],
                                    {"fda-caffeine": "fact-extraction-rewrite"})
            proc = self._for_training(c, m)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("missing-claim-linkage", proc.stdout)

    def test_waiver_required_when_no_sources(self):
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, [], [], waiver=None)
            proc = self._for_training(c, m)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("missing-source-waiver", proc.stdout)
            c, m = self._one_sample(td, [], [],
                                    waiver="行为规范样本：无外部事实来源。")
            proc = self._for_training(c, m, purpose="noncommercial-research", json_mode=True)
            self._assert_admission_ok(proc)

    def test_unreviewed_blocks_before_source_noise(self):
        """未审核样本：阻断原因是 not-approved，不再叠加来源检查。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["wcr-sensory-lexicon"], [], review="unreviewed")
            proc = self._for_training(c, m)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("not-approved", proc.stdout)
            self.assertNotIn("source-blocked-status", proc.stdout)


class AllowDownloadTests(unittest.TestCase):
    """阶段三 P1：--allow-download 只对 --train 生效。"""

    def test_smoke_never_downloads_even_with_flag(self):
        proc = run_script("run_train.py", "--smoke",
                          "--config", COFFEEAI / "configs" / "smoke.yaml",
                          "--allow-download",
                          "--deployment-purpose", "noncommercial-research")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("烟测不下载", proc.stdout + proc.stderr)

    def test_resolve_model_flag_semantics(self):
        sys.path.insert(0, str(SCRIPTS))
        import run_train
        status, detail = run_train.resolve_model("nonexistent-org/never-cached", False)
        self.assertEqual(status, "needs-download")
        status, detail = run_train.resolve_model("nonexistent-org/never-cached", True)
        self.assertEqual(status, "needs-download")
        self.assertIn("显式允许", detail.get("note", ""))
        status, detail = run_train.resolve_model("/definitely/not/a/model/dir", False)
        self.assertEqual(status, "invalid")

    def test_train_without_flag_still_blocked(self):
        """回归：不传 --allow-download 时正式训练仍被拒且不联网。"""
        proc = run_script("run_train.py", "--train",
                          "--config", COFFEEAI / "configs" / "smoke.yaml",
                          "--deployment-purpose", "noncommercial-research")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("绝不", proc.stderr)


class EvaluateCommandTests(unittest.TestCase):
    """阶段三 P1：评测输入构造（聊天模板 + 双模型参数一致）。"""

    def test_cmd_symmetry_and_template(self):
        sys.path.insert(0, str(SCRIPTS))
        import evaluate
        base = evaluate.build_generate_cmd(["E"], "M", None, "SYS", "Q", 512, 0.2, 0)
        ft = evaluate.build_generate_cmd(["E"], "M", "ADP", "SYS", "Q", 512, 0.2, 0)
        self.assertEqual(ft, base + ["--adapter-path", "ADP"])
        self.assertIn("--system-prompt", base)
        self.assertIn("--verbose", base)
        self.assertEqual(base[base.index("--verbose") + 1], "False")
        self.assertNotIn("--ignore-chat-template", base)
        self.assertIn("--temp", base)
        self.assertIn("--seed", base)

    def test_default_system_prompt_matches_training(self):
        sys.path.insert(0, str(SCRIPTS))
        import evaluate
        self.assertEqual(evaluate.TRAINING_SYSTEM,
                         "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。")


def _build_approved_split(td):
    """构建 3 个 approved 组的可划分语料（内容互不相同、审核指纹正确绑定）。"""
    sys.path.insert(0, str(SCRIPTS))
    from coffeeai_common import (messages_fingerprint,
                                 reviewed_record_sha256)
    c, m = Path(td) / "c.jsonl", Path(td) / "c.meta.jsonl"
    content = [
        ("问题一？", "第一条回答：内容足够长，且与其他条目明显不同，用来通过全部检查要求。"),
        ("问题二？", "第二条回答：手冲与意式的诊断路径不同，需要分别讨论变量与证据。"),
        ("问题三？", "第三条回答：养豆窗口取决于烘焙度、处理法与储存，不能给统一天数。"),
    ]
    rows_c, rows_m = [], []
    for i, (q, a) in enumerate(content, 1):
        msgs = [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
        rows_c.append({"sample_id": f"cb-{i}", "group_id": f"g-cb-{i}", "messages": msgs})
        meta = {"sample_id": f"cb-{i}", "group_id": f"g-cb-{i}", "topic": "t",
                "source_doc": "t", "source_ids": [], "claim_ids": [],
                "license_status": "own-original", "review_status": "approved",
                "data_version": "v", "dedup_fingerprint": messages_fingerprint(msgs),
                "reviewed_content_sha256": messages_fingerprint(msgs),
                "source_waiver": "测试样本：无外部事实来源。"}
        meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
        rows_m.append(meta)
    write_jsonl(c, rows_c)
    write_jsonl(m, rows_m)
    out = Path(td) / "splits"
    run_script("split_dataset.py", "--corpus", c, "--meta", m, "--out", out, expect=0)
    return out


class ContentBindingTests(unittest.TestCase):
    """阶段四：人工审核结果必须绑定到确切的训练文本（reviewed_content_sha256）。"""

    def _approved_split(self, td):
        return _build_approved_split(td)

    def test_approved_split_passes_admission(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            run_script("validate_data.py", "--check-admission", out, "--json", expect=0)

    def test_tampered_answer_blocks_training(self):
        """核心回归：保持 sample_id 与已批准元数据不变，只改 JSONL 回答 → 准入失败。"""
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            f = out / "train.jsonl"
            rows = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
            target = rows[0]
            for msg in target["messages"]:
                if msg["role"] == "assistant":
                    msg["content"] = "被篡改的回答：内容与人工审核时确认的文本完全不同。"
            f.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                         encoding="utf-8")
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            report = json.loads(proc.stdout)
            codes = {i["code"] for i in report["admission"]["issues"]}
            self.assertIn("admission-content-mismatch", codes)
            self.assertIn(target["sample_id"],
                          json.dumps(report["admission"]["issues"], ensure_ascii=False))

    def test_missing_reviewed_fingerprint_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            for name in ("train.meta.jsonl", "valid.meta.jsonl", "test.meta.jsonl"):
                p = out / name
                rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
                for r in rows:
                    r.pop("reviewed_content_sha256", None)
                p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                             encoding="utf-8")
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("admission-content-unverified", proc.stdout)

    def test_cross_split_duplicate_sample_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            # 把 train 的一条复制进 test（同 sample_id）
            train_rows = [l for l in (out / "train.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
            meta_rows = [l for l in (out / "train.meta.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
            with (out / "test.jsonl").open("a", encoding="utf-8") as f:
                f.write(train_rows[0] + "\n")
            with (out / "test.meta.jsonl").open("a", encoding="utf-8") as f:
                f.write(meta_rows[0] + "\n")
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("sample-cross-split", proc.stdout)


class EffectiveConfigTests(unittest.TestCase):
    """阶段四：预检查对象 == 实际训练对象（有效配置唯一化）。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="coffeeai_effcfg_"))
        cls.split_dir = _build_approved_split(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_build_effective_config_applies_overrides(self):
        sys.path.insert(0, str(SCRIPTS))
        import run_train
        raw = {"model": "default/model", "data": "Tools/CoffeeAI/data/splits", "iters": 300}
        eff = run_train.build_effective_config(raw, "override/model", None)
        self.assertEqual(eff["model"], "override/model")
        self.assertEqual(eff["iters"], 300)
        self.assertEqual(raw["model"], "default/model", "不得就地修改原始配置")
        eff2 = run_train.build_effective_config(raw, None, "some/data/dir")
        self.assertEqual(eff2["data"], str(REPO / "some/data/dir"), "相对数据目录应基于仓库根解析")

    def test_effective_config_roundtrip(self):
        sys.path.insert(0, str(SCRIPTS))
        import run_train
        with tempfile.TemporaryDirectory() as td:
            raw = {"model": "default/model", "data": "d", "iters": 2, "train": True,
                   "fine_tune_type": "lora", "seed": 0, "batch_size": 1,
                   "num_layers": 2, "learning_rate": 1.0e-4, "val_batches": 1,
                   "steps_per_report": 1, "steps_per_eval": 100,
                   "grad_accumulation_steps": 1, "adapter_path": "adp",
                   "save_every": 1000, "test": False, "test_batches": 1,
                   "max_seq_length": 512, "grad_checkpoint": True,
                   "lora_parameters": {"keys": ["self_attn.q_proj"], "rank": 4,
                                       "scale": 10.0, "dropout": 0.0}}
            eff = run_train.build_effective_config(raw, "override/model", None)
            p = run_train.write_effective_config(eff, Path(td) / "eff.yaml")
            parsed = run_train.parse_simple_yaml(p)
            self.assertEqual(parsed["model"], "override/model")
            self.assertEqual(parsed["iters"], 2)
            self.assertEqual(parsed["grad_checkpoint"], True)

    def test_dry_run_shows_effective_overrides(self):
        proc = run_script("run_train.py", "--dry-run",
                          "--config", COFFEEAI / "configs" / "smoke.yaml",
                          "--data-dir", self.split_dir,
                          "--model", "override/test-model", "--allow-download")
        self.assertEqual(proc.returncode, 0)
        out = proc.stdout
        self.assertIn("有效配置", out)
        self.assertIn("override/test-model", out)
        # 有效配置应用于基础模型行；原配置模型不得出现在基础模型行
        model_line = next(l for l in out.splitlines() if l.startswith("基础模型"))
        self.assertIn("override/test-model", model_line)
        self.assertNotIn("Qwen3", model_line)


class ExceptionScopeTests(unittest.TestCase):
    """阶段四点五：例外的字段校验、范围约束与用途判定（全部用临时文件，不动正式例外表）。"""

    def _one_sample(self, td, source_ids, claim_ids, usage, topic="varieties",
                    review="approved"):
        c = Path(td) / "s.jsonl"
        m = Path(td) / "s.meta.jsonl"
        msgs = [{"role": "user", "content": "问题？"},
                {"role": "assistant", "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
        write_jsonl(c, [{"sample_id": "sa1", "group_id": "g-sa", "messages": msgs}])
        meta = {"sample_id": "sa1", "group_id": "g-sa", "topic": topic, "source_doc": "t",
                "source_ids": source_ids, "claim_ids": claim_ids,
                "license_status": "own-original", "review_status": review,
                "data_version": "v", "dedup_fingerprint": "a" * 64}
        if usage is not None:
            meta["source_usage"] = usage
        meta["source_waiver"] = None if source_ids else "测试豁免"
        if review == "approved":
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import (messages_fingerprint,
                                         reviewed_record_sha256)
            meta["reviewed_content_sha256"] = messages_fingerprint(msgs)
            meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
        write_jsonl(m, [meta])
        return c, m

    def _run(self, c, m, exceptions=None, purpose=None):
        args = ["validate_data.py", "--corpus", c, "--meta", m, "--for-training", "--json"]
        if exceptions is not None:
            args += ["--source-exceptions", Path(exceptions).resolve()]
        if purpose:
            args += ["--deployment-purpose", purpose]
        return run_script(*args)

    def _assert_ok(self, proc):
        """阶段四点六：正向测试必须证明退出成功且 0 error，而非仅看不含某错误串。"""
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["validation"]["errors"], 0,
                         json.dumps(report["validation"]["issues"], ensure_ascii=False))

    def _write_exceptions(self, td, entries, raw=None):
        p = Path(td) / "exceptions.json"
        if raw is not None:
            p.write_text(raw, encoding="utf-8")
        else:
            p.write_text(json.dumps({"schemaVersion": 2, "exceptions": entries},
                                    ensure_ascii=False, indent=2), encoding="utf-8")
        return p

    def _full_exception(self, **overrides):
        exc = {
            "sourceId": "wcr-varieties-catalog",
            "usage": "fact-extraction-rewrite",
            "reason": "注册表口径：品种知识仅可独立改写",
            "approved_by": "人工审核人（测试占位）",
            "approved_at": "2026-10-14",
            "scope": "仅非商业训练样本",
            "deployment_purposes": ["noncommercial-research"],
            "allowed_sample_ids": ["sa1"],
            "allowed_topics": ["varieties"],
            "allowed_claim_ids": ["claim.varieties.no-absolute-data"],
            "license_basis": {"basis": "registry-sanctioned-use",
                              "evidence_ref": "knowledge/SOURCE_REGISTRY.md §2"},
        }
        exc.update(overrides)
        return exc

    # ---- 1) reason 缺失/为空
    def test_reason_missing_rejected(self):
        for bad in (None, ""):
            with tempfile.TemporaryDirectory() as td:
                exc = self._full_exception()
                if bad is None:
                    exc.pop("reason")
                else:
                    exc["reason"] = bad
                ef = self._write_exceptions(td, [exc])
                c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                        ["claim.varieties.no-absolute-data"],
                                        {"wcr-varieties-catalog": "fact-extraction-rewrite"})
                proc = self._run(c, m, exceptions=ef, purpose="noncommercial-research")
                self.assertEqual(proc.returncode, 1)
                self.assertIn("source-requires-human-exception", proc.stdout)

    # ---- 2) approved_at 格式/合理性
    def test_approved_at_invalid_or_unreasonable_rejected(self):
        for bad in ("not-a-date", "2026-13-40", "14/10/2026", "2030-01-01", "2019-12-31"):
            with tempfile.TemporaryDirectory() as td:
                ef = self._write_exceptions(td, [self._full_exception(approved_at=bad)])
                c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                        ["claim.varieties.no-absolute-data"],
                                        {"wcr-varieties-catalog": "fact-extraction-rewrite"})
                proc = self._run(c, m, exceptions=ef, purpose="noncommercial-research")
                self.assertEqual(proc.returncode, 1, bad)
                self.assertIn("source-requires-human-exception", proc.stdout, bad)
                self.assertIn("exception-invalid", proc.stdout, bad)

    # ---- 3) 样本 ID 不在允许范围
    def test_sample_outside_allowed_ids_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            ef = self._write_exceptions(td, [self._full_exception(
                allowed_sample_ids=["other-sample"])])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._run(c, m, exceptions=ef, purpose="noncommercial-research")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("exception-out-of-scope", proc.stdout)
            self.assertIn("不在例外允许的样本范围", proc.stdout)

    # ---- 4) 仅非商业例外 vs 声明商业用途
    def test_commercial_purpose_outside_noncommercial_exception_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            ef = self._write_exceptions(td, [self._full_exception()])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._run(c, m, exceptions=ef, purpose="commercial-product")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("exception-out-of-scope", proc.stdout)
            self.assertIn("commercial-product", proc.stdout)

    # ---- 5) 禁商用来源做商业用途必须有 licensor-grant + 证据
    def test_commercial_use_of_nc_nd_source_requires_licensor_grant(self):
        with tempfile.TemporaryDirectory() as td:
            # 无授权依据 → 拒绝（内部审批不能冒充外部授权）
            ef = self._write_exceptions(td, [self._full_exception(
                deployment_purposes=["noncommercial-research", "commercial-product"])])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._run(c, m, exceptions=ef, purpose="commercial-product")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("exception-out-of-scope", proc.stdout)
            self.assertIn("licensor-grant", proc.stdout)
            # 有 licensor-grant + 可追溯证据 → 该项通过
            ef2 = self._write_exceptions(td, [self._full_exception(
                deployment_purposes=["noncommercial-research", "commercial-product"],
                license_basis={"basis": "licensor-grant",
                               "evidence_ref": "permissions/wcr-grant-2026-10.pdf"})])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._run(c, m, exceptions=ef2, purpose="commercial-product")
            self._assert_ok(proc)
            self.assertNotIn("exception-out-of-scope", proc.stdout)

    # ---- 6) 有效例外只在批准范围内生效
    def test_exception_scope_conjunctive(self):
        base = dict(source_ids=["wcr-varieties-catalog"],
                    claim_ids=["claim.varieties.no-absolute-data"],
                    usage={"wcr-varieties-catalog": "fact-extraction-rewrite"})
        with tempfile.TemporaryDirectory() as td:
            ef = self._write_exceptions(td, [self._full_exception()])
            # 主题不符 → 拒绝
            c, m = self._one_sample(td, topic="grinding", **{k: v for k, v in base.items()})
            proc = self._run(c, m, exceptions=ef, purpose="noncommercial-research")
            self.assertIn("不在例外允许的主题范围", proc.stdout)
            # claim 超范围 → 拒绝
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    claim_ids=["claim.grinding.manual-not-recipe"],
                                    usage=base["usage"])
            proc = self._run(c, m, exceptions=ef, purpose="noncommercial-research")
            self.assertIn("超出例外允许范围", proc.stdout)
            # 用途未声明 → 拒绝
            c, m = self._one_sample(td, **base)
            proc = self._run(c, m, exceptions=ef, purpose=None)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("exception-out-of-scope", proc.stdout)
            self.assertIn("未显式声明", proc.stdout)

    # ---- 8) 例外文件缺失/格式错误/字段类型错误 → 不放行
    def test_missing_or_broken_exceptions_file_fail_closed(self):
        base = dict(source_ids=["wcr-varieties-catalog"],
                    claim_ids=["claim.varieties.no-absolute-data"],
                    usage={"wcr-varieties-catalog": "fact-extraction-rewrite"})
        with tempfile.TemporaryDirectory() as td:
            # 文件不存在
            c, m = self._one_sample(td, **base)
            proc = self._run(c, m, exceptions=Path(td) / "nope.json",
                             purpose="noncommercial-research")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-requires-human-exception", proc.stdout)
            # 非法 JSON
            bad = self._write_exceptions(td, [], raw="{not json")
            c, m = self._one_sample(td, **base)
            proc = self._run(c, m, exceptions=bad, purpose="noncommercial-research")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-requires-human-exception", proc.stdout)
            # 字段类型错误（deployment_purposes 为字符串）
            wrong = self._write_exceptions(td, [self._full_exception(
                deployment_purposes="noncommercial-research")])
            c, m = self._one_sample(td, **base)
            proc = self._run(c, m, exceptions=wrong, purpose="noncommercial-research")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-requires-human-exception", proc.stdout)

    # ---- run_train 侧：用途声明 fail-closed
    def test_run_train_requires_deployment_purpose(self):
        proc = run_script("run_train.py", "--train",
                          "--config", COFFEEAI / "configs" / "smoke.yaml")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("deployment-purpose", proc.stderr)
        proc = run_script("run_train.py", "--smoke",
                          "--config", COFFEEAI / "configs" / "smoke.yaml",
                          "--allow-download")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("deployment-purpose", proc.stderr)
        # dry-run 不强制（预览用途未声明状态）
        proc = run_script("run_train.py", "--dry-run",
                          "--config", COFFEEAI / "configs" / "smoke.yaml")
        self.assertIn("训练用途   : 未声明", proc.stdout)

    # ---- 7) 自动准入与既有阻断保持有效（抽查）
    def test_auto_allow_and_blocklist_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["fda-caffeine"], ["claim.health.fda-400"],
                                    {"fda-caffeine": "fact-extraction-rewrite"})
            proc = self._run(c, m, exceptions=None, purpose="noncommercial-research")
            self._assert_ok(proc)
            c, m = self._one_sample(td, ["sca-digital-store"], [], {})
            proc = self._run(c, m, exceptions=None, purpose="commercial-product")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-blocked-status", proc.stdout)


class DualDimLicenseTests(unittest.TestCase):
    """阶段四点六：商业授权必须独立检查 commercialUse 与 derivatives 两个维度。

    使用合成 registry fixture（来源 ID 带 synthetic- 前缀，不触碰正式注册表，
    不伪造任何现有来源的许可状态）。
    """

    SYN_SRC = "synthetic-source-1"
    SYN_CLAIM = "claim.synthetic.test"

    def _registry_file(self, td, commercialUse, derivatives):
        reg = {"sources": [{
            "sourceId": self.SYN_SRC, "status": "active",
            "license": {"status": "see-source-terms",
                        "commercialUse": commercialUse, "derivatives": derivatives},
        }]}
        p = Path(td) / "registry.json"
        p.write_text(json.dumps(reg), encoding="utf-8")
        return p

    def _exception(self, purposes, basis="registry-sanctioned-use", evidence="ref-001"):
        return {"sourceId": self.SYN_SRC, "usage": "fact-extraction-rewrite",
                "reason": "测试例外", "approved_by": "人工审核人（测试占位）",
                "approved_at": "2026-10-14", "scope": "测试",
                "deployment_purposes": purposes,
                "allowed_sample_ids": ["sa1"],
                "allowed_claim_ids": [self.SYN_CLAIM],
                "license_basis": {"basis": basis, "evidence_ref": evidence}}

    def _admit(self, td, commercialUse, derivatives, purposes, basis, evidence,
               purpose="commercial-product"):
        """直接调用 source_admission_issues（合成 registry 注入），返回 (codes, ok)。"""
        sys.path.insert(0, str(SCRIPTS))
        from coffeeai_common import source_admission_issues
        registry = {self.SYN_SRC: {
            "status": "active", "license_status": "see-source-terms",
            "commercialUse": commercialUse, "derivatives": derivatives}}
        exceptions = {self.SYN_SRC: self._exception(purposes, basis, evidence)}
        issues = source_admission_issues(
            [self.SYN_SRC], registry,
            {self.SYN_SRC: "fact-extraction-rewrite"},
            exceptions=exceptions,
            deployment_purpose=purpose,
            sample={"sample_id": "sa1", "topic": "t",
                    "claim_ids": [self.SYN_CLAIM]})
        codes = [i["code"] for i in issues]
        return codes, len(issues) == 0

    def test_commercial_allowed_derivatives_not_allowed_blocks(self):
        codes, ok = self._admit(tempfile.mkdtemp(), "allowed", "not-allowed",
                                ["commercial-product"],
                                "registry-sanctioned-use", "ref-001")
        self.assertFalse(ok)
        self.assertIn("exception-out-of-scope", codes)

    def test_commercial_allowed_derivatives_unclear_blocks_without_grant(self):
        codes, ok = self._admit(tempfile.mkdtemp(), "allowed", "unclear",
                                ["commercial-product"], "internal-review", "ref-001")
        self.assertFalse(ok)
        self.assertIn("exception-out-of-scope", codes)

    def test_unclear_commercial_allowed_derivatives_blocks_without_grant(self):
        codes, ok = self._admit(tempfile.mkdtemp(), "unclear", "allowed",
                                ["commercial-product"], "internal-review", "ref-001")
        self.assertFalse(ok)
        self.assertIn("exception-out-of-scope", codes)

    def test_missing_field_fails_closed(self):
        codes, ok = self._admit(tempfile.mkdtemp(), "allowed", None,
                                ["commercial-product"], "registry-sanctioned-use", "ref-001")
        self.assertFalse(ok)
        self.assertIn("exception-out-of-scope", codes)

    def test_both_restricted_with_licensor_grant_passes_scope(self):
        codes, ok = self._admit(tempfile.mkdtemp(), "not-allowed", "unclear",
                                ["commercial-product"], "licensor-grant",
                                "permissions/grant-2026.pdf")
        self.assertTrue(ok, codes)

    def test_both_allowed_needs_no_grant(self):
        codes, ok = self._admit(tempfile.mkdtemp(), "allowed", "allowed",
                                ["commercial-product"], "registry-sanctioned-use", "ref-001")
        self.assertTrue(ok, codes)

    def test_noncommercial_purpose_unaffected_by_dims(self):
        """非商业用途不触发双维度商业检查（既有政策不变）。"""
        codes, ok = self._admit(tempfile.mkdtemp(), "not-allowed", "not-allowed",
                                ["noncommercial-research"],
                                "registry-sanctioned-use", "ref-001",
                                purpose="noncommercial-research")
        self.assertTrue(ok, codes)

    def test_end_to_end_with_synthetic_registry_file(self):
        """e2e：合成 registry 通过 --registry 注入 CLI 全流程，双维度检查生效。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            reg = self._registry_file(td, "allowed", "not-allowed")
            msgs = [{"role": "user", "content": "问题？"},
                    {"role": "assistant",
                     "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
            write_jsonl(td / "s.jsonl", [{"sample_id": "sa1", "group_id": "g",
                                          "messages": msgs}])
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import (messages_fingerprint,
                                         reviewed_record_sha256)
            meta = {"sample_id": "sa1", "group_id": "g", "topic": "t",
                    "source_doc": "t", "source_ids": [self.SYN_SRC],
                    "claim_ids": [self.SYN_CLAIM],
                    "license_status": "own-original", "review_status": "approved",
                    "data_version": "v", "dedup_fingerprint": "a" * 64,
                    "reviewed_content_sha256": messages_fingerprint(msgs),
                    "source_usage": {self.SYN_SRC: "fact-extraction-rewrite"}}
            meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
            write_jsonl(td / "s.meta.jsonl", [meta])
            exc = td / "exc.json"
            exc.write_text(json.dumps({"exceptions": [self._exception(
                ["noncommercial-research", "commercial-product"])]}), encoding="utf-8")
            # 非商业用途 → 通过
            proc = run_script("validate_data.py", "--corpus", td / "s.jsonl",
                              "--meta", td / "s.meta.jsonl", "--for-training",
                              "--registry", reg, "--source-exceptions", exc,
                              "--deployment-purpose", "noncommercial-research",
                              "--json")
            self._assert_ok_style(proc)
            # 商业用途 + derivatives not-allowed + 内部审批 → 阻断
            proc = run_script("validate_data.py", "--corpus", td / "s.jsonl",
                              "--meta", td / "s.meta.jsonl", "--for-training",
                              "--registry", reg, "--source-exceptions", exc,
                              "--deployment-purpose", "commercial-product",
                              "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("exception-out-of-scope", proc.stdout)
            self.assertIn("licensor-grant", proc.stdout)

    def _assert_ok_style(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual(report["validation"]["errors"], 0)


class RecordBindingTests(unittest.TestCase):
    """阶段四点六：审核记录摘要绑定 messages + 准入元数据；改动任一即阻断。"""

    def _approved_split(self, td):
        return _build_approved_split(td)

    def _tamper_split_meta(self, out, mutate):
        for name in ("train.meta.jsonl", "valid.meta.jsonl", "test.meta.jsonl"):
            p = out / name
            rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines()
                    if l.strip()]
            rows = [mutate(r) for r in rows]
            p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                         encoding="utf-8")

    def test_license_status_tamper_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            self._tamper_split_meta(out, lambda r: {**r, "license_status": "ok"})
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("admission-record-mismatch", proc.stdout)

    def test_source_ids_tamper_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            self._tamper_split_meta(
                out, lambda r: {**r, "source_ids": ["fda-caffeine"]})
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("admission-record-mismatch", proc.stdout)

    def test_topic_tamper_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            self._tamper_split_meta(out, lambda r: {**r, "topic": "changed"})
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("admission-record-mismatch", proc.stdout)

    def test_waiver_removal_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            self._tamper_split_meta(
                out, lambda r: {**r, "source_waiver": "被改过的豁免理由"})
            proc = run_script("validate_data.py", "--check-admission", out, "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("admission-record-mismatch", proc.stdout)

    def test_corpus_level_record_mismatch_blocked(self):
        """corpus 层：审核后改 topic 但保留原审核记录摘要 → for-training 阻断。"""
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            out = self._approved_split(td)
            # 从 splits 取一条 meta，改 topic 后与 jsonl 组成独立 corpus
            meta_row = json.loads((out / "train.meta.jsonl").read_text(
                encoding="utf-8").splitlines()[0])
            jsonl_row = None
            for name in ("train.jsonl", "valid.jsonl", "test.jsonl"):
                for l in (out / name).read_text(encoding="utf-8").splitlines():
                    d = json.loads(l)
                    if d.get("sample_id") == meta_row["sample_id"]:
                        jsonl_row = d
            jsonl_row["messages"][1]["topic_hint"] = "x"  # 保持 messages 不变
            write_jsonl(td / "c.jsonl", [jsonl_row])
            meta_row["topic"] = "changed-after-review"
            write_jsonl(td / "c.meta.jsonl", [meta_row])
            proc = run_script("validate_data.py", "--corpus", td / "c.jsonl",
                              "--meta", td / "c.meta.jsonl", "--for-training",
                              "--json")
            self.assertEqual(proc.returncode, 1)
            self.assertIn("reviewed-record-mismatch", proc.stdout)

    def test_unmodified_samples_pass(self):
        with tempfile.TemporaryDirectory() as td:
            out = self._approved_split(td)
            run_script("validate_data.py", "--check-admission", out, "--json", expect=0)


class ExceptionSchemaTests(unittest.TestCase):
    """阶段四点七：例外 Schema 严格类型校验（加载器单元级 + CLI 端到端）。

    全部使用临时文件与固定 today，不修改正式例外表。
    """

    TODAY = date(2026, 10, 14)

    def _valid_exception(self, **overrides):
        exc = {
            "sourceId": "wcr-varieties-catalog",
            "usage": "fact-extraction-rewrite",
            "reason": "注册表口径：品种知识仅可独立改写",
            "approved_by": "人工审核人（测试占位）",
            "approved_at": "2026-10-14",
            "scope": "仅非商业训练样本",
            "deployment_purposes": ["noncommercial-research"],
            "allowed_sample_ids": ["sa1"],
            "allowed_topics": ["varieties"],
            "allowed_claim_ids": ["claim.varieties.no-absolute-data"],
            "license_basis": {"basis": "registry-sanctioned-use",
                              "evidence_ref": "knowledge/SOURCE_REGISTRY.md §2"},
        }
        exc.update(overrides)
        return exc

    def _load(self, entries, raw=None):
        sys.path.insert(0, str(SCRIPTS))
        from coffeeai_common import load_source_exceptions
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "e.json"
            if raw is not None:
                p.write_text(raw, encoding="utf-8")
            else:
                p.write_text(json.dumps({"exceptions": entries}, ensure_ascii=False),
                             encoding="utf-8")
            return load_source_exceptions(p, today=self.TODAY)

    def _rejected_reasons(self, entries, raw=None):
        _valid, rejected = self._load(entries, raw)
        return " | ".join(r["reason"] for r in rejected)

    # ---- 范围限定器类型绕过
    def test_string_scope_limiter_rejected_even_if_other_valid(self):
        """allowed_sample_ids="sa10" + 合法 allowed_topics → 整条失效（类型绕过封堵）。"""
        reasons = self._rejected_reasons([self._valid_exception(
            allowed_sample_ids="sa10")])
        self.assertIn("范围限定器 allowed_sample_ids", reasons)

    def test_numeric_or_dict_scope_limiter_rejected(self):
        for bad in (123, {"varieties": True}):
            reasons = self._rejected_reasons([self._valid_exception(
                allowed_topics=bad)])
            self.assertIn("范围限定器 allowed_topics", reasons, repr(bad))

    def test_non_string_member_in_claim_limiter_rejected(self):
        reasons = self._rejected_reasons([self._valid_exception(
            allowed_claim_ids=["claim.varieties.no-absolute-data", 123])])
        self.assertIn("范围限定器 allowed_claim_ids", reasons)

    def test_empty_scope_limiter_list_rejected(self):
        reasons = self._rejected_reasons([self._valid_exception(
            allowed_sample_ids=[], allowed_topics=["varieties"])])
        self.assertIn("范围限定器 allowed_sample_ids", reasons)

    # ---- usage 类型绕过
    def test_usage_list_or_dict_gracefully_rejected(self):
        """usage 为列表/字典 → 优雅拒绝，不得抛未处理异常。"""
        for bad in (["fact-extraction-rewrite"], {"usage": "fact-extraction-rewrite"}):
            reasons = self._rejected_reasons([self._valid_exception(usage=bad)])
            self.assertIn("usage 非法", reasons, repr(bad))

    # ---- 字符串字段不得伪装
    def test_non_string_approval_fields_rejected(self):
        for field, bad in (("approved_by", 123), ("reason", ["理由"]),
                           ("scope", {"k": 1})):
            reasons = self._rejected_reasons([self._valid_exception(**{field: bad})])
            self.assertIn(f"{field} 必须为非空字符串", reasons, repr(bad))

    def test_non_string_license_basis_fields_rejected(self):
        for basis, ev in ((123, "ref"), ("licensor-grant", ["x"])):
            reasons = self._rejected_reasons([self._valid_exception(
                license_basis={"basis": basis, "evidence_ref": ev})])
            self.assertIn("license_basis", reasons)

    # ---- valid_until 假值绕过
    def test_falsy_invalid_valid_until_rejected(self):
        for bad in (0, [], {}, False):
            reasons = self._rejected_reasons([self._valid_exception(valid_until=bad)])
            self.assertIn("valid_until", reasons, repr(bad))

    # ---- 重复 sourceId 冲突失效
    def test_duplicate_source_id_invalidates_all(self):
        valid, rejected = self._load([self._valid_exception(), self._valid_exception()])
        self.assertEqual(len(valid), 0, "冲突例外不得有任何一条生效")
        self.assertEqual(len(rejected), 2)
        self.assertTrue(all("重复" in r["reason"] for r in rejected))

    # ---- 正向：完整且范围匹配的例外仍然通过
    def test_valid_exception_still_loads(self):
        valid, rejected = self._load([self._valid_exception()])
        self.assertEqual(len(rejected), 0, rejected)
        self.assertIn("wcr-varieties-catalog", valid)

    # ---- CLI 端到端：类型错误限定器 → 阻断且给出 exception-invalid 提示
    def test_cli_type_error_limiter_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            exc = Path(td) / "e.json"
            exc.write_text(json.dumps({"exceptions": [self._valid_exception(
                allowed_sample_ids="sa10")]}, ensure_ascii=False), encoding="utf-8")
            msgs = [{"role": "user", "content": "问题？"},
                    {"role": "assistant",
                     "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
            write_jsonl(Path(td) / "s.jsonl",
                        [{"sample_id": "sa1", "group_id": "g", "messages": msgs}])
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import (messages_fingerprint,
                                         reviewed_record_sha256)
            meta = {"sample_id": "sa1", "group_id": "g", "topic": "varieties",
                    "source_doc": "t", "source_ids": ["wcr-varieties-catalog"],
                    "claim_ids": ["claim.varieties.no-absolute-data"],
                    "license_status": "own-original", "review_status": "approved",
                    "data_version": "v", "dedup_fingerprint": "a" * 64,
                    "reviewed_content_sha256": messages_fingerprint(msgs),
                    "source_usage": {"wcr-varieties-catalog": "fact-extraction-rewrite"}}
            meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
            write_jsonl(Path(td) / "s.meta.jsonl", [meta])
            proc = run_script("validate_data.py", "--corpus", Path(td) / "s.jsonl",
                              "--meta", Path(td) / "s.meta.jsonl", "--for-training",
                              "--source-exceptions", exc,
                              "--deployment-purpose", "noncommercial-research",
                              "--json")
            self.assertEqual(proc.returncode, 1)
            report = json.loads(proc.stdout)
            codes = {i["code"] for i in report["validation"]["issues"]}
            self.assertIn("source-requires-human-exception", codes)
            self.assertIn("exception-invalid", codes)


class GlobalConflictTests(unittest.TestCase):
    """阶段四点八：重复 sourceId 全局失效（与顺序/字段有效性无关）+ 显式 null 拒绝。"""

    TODAY = date(2026, 10, 14)

    def _valid_exception(self, **overrides):
        exc = {
            "sourceId": "wcr-varieties-catalog",
            "usage": "fact-extraction-rewrite",
            "reason": "注册表口径：品种知识仅可独立改写",
            "approved_by": "人工审核人（测试占位）",
            "approved_at": "2026-10-14",
            "scope": "仅非商业训练样本",
            "deployment_purposes": ["noncommercial-research"],
            "allowed_sample_ids": ["sa1"],
            "allowed_topics": ["varieties"],
            "allowed_claim_ids": ["claim.varieties.no-absolute-data"],
            "license_basis": {"basis": "registry-sanctioned-use",
                              "evidence_ref": "knowledge/SOURCE_REGISTRY.md §2"},
        }
        exc.update(overrides)
        return exc

    def _load(self, entries):
        sys.path.insert(0, str(SCRIPTS))
        from coffeeai_common import load_source_exceptions
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "e.json"
            p.write_text(json.dumps({"exceptions": entries}, ensure_ascii=False),
                         encoding="utf-8")
            return load_source_exceptions(p, today=self.TODAY)

    def _assert_all_conflicted(self, entries, n):
        """sid 不得出现在有效字典中；n 条相关记录每条都有可追溯拒绝原因。"""
        valid, rejected = self._load(entries)
        self.assertNotIn("wcr-varieties-catalog", valid)
        conflict_rows = [r for r in rejected if r["sourceId"] == "wcr-varieties-catalog"]
        self.assertEqual(len(conflict_rows), n,
                         f"应有 {n} 条记录得到拒绝原因: {rejected}")
        for r in conflict_rows:
            self.assertTrue(("重复" in r["reason"]) or ("冲突" in r["reason"]),
                            f"拒绝原因应指向冲突: {r['reason']}")
        return valid, rejected

    def test_valid_then_missing_reason_both_invalid(self):
        entries = [self._valid_exception(),
                   self._valid_exception(reason=None)]
        self._assert_all_conflicted(entries, 2)

    def test_invalid_then_valid_both_invalid(self):
        entries = [self._valid_exception(reason=None),
                   self._valid_exception()]
        self._assert_all_conflicted(entries, 2)

    def test_valid_then_expired_both_invalid(self):
        entries = [self._valid_exception(),
                   self._valid_exception(valid_until="2026-01-02")]
        self._assert_all_conflicted(entries, 2)

    def test_three_mixed_entries_all_invalid(self):
        entries = [self._valid_exception(),
                   self._valid_exception(reason=None),
                   self._valid_exception(valid_until="2026-01-02")]
        self._assert_all_conflicted(entries, 3)

    def test_single_valid_entry_still_loads(self):
        valid, rejected = self._load([self._valid_exception()])
        self.assertIn("wcr-varieties-catalog", valid)
        self.assertEqual(len(rejected), 0)

    def test_type_invalid_source_id_not_in_conflict_scan(self):
        """sourceId 类型非法的记录按 Schema 错误拒绝（保留原始值便于追溯），
        不参与冲突统计，也不影响其他条目。"""
        bad = self._valid_exception(sourceId=123)
        entries = [bad, self._valid_exception()]
        valid, rejected = self._load(entries)
        self.assertIn("wcr-varieties-catalog", valid)
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["sourceId"], 123, "拒绝记录保留原始非法值以便追溯")
        self.assertIn("sourceId", rejected[0]["reason"])

    # ---- P2：显式 null 不是「未提供」
    def test_explicit_null_limiter_rejected(self):
        """三个限定器各自为 null、另一个限定器合法 → 仍整条失效。"""
        cases = [
            {"allowed_sample_ids": None},
            {"allowed_topics": None},
            {"allowed_claim_ids": None},
        ]
        for overrides in cases:
            reasons = None
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import load_source_exceptions as _l
            valid, rejected = self._load([self._valid_exception(**overrides)])
            reasons = " | ".join(r["reason"] for r in rejected)
            self.assertEqual(len(valid), 0, f"{overrides} 不应生效")
            self.assertIn("null", reasons, f"{overrides}: {reasons}")

    def test_scope_check_defensive_null(self):
        """防御层与加载器一致：显式 null 限定器 → out-of-scope，而非视为未提供。"""
        sys.path.insert(0, str(SCRIPTS))
        from coffeeai_common import check_exception_scope
        exc = self._valid_exception(allowed_sample_ids=None)
        ok, reason = check_exception_scope(
            exc, {"status": "active", "license_status": "see-source-terms",
                  "commercialUse": "unclear", "derivatives": "unclear"},
            {"sample_id": "sa1", "topic": "varieties",
             "claim_ids": ["claim.varieties.no-absolute-data"]},
            "noncommercial-research")
        self.assertFalse(ok)
        self.assertIn("null", reason)

    def test_cli_null_limiter_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            exc = Path(td) / "e.json"
            exc.write_text(json.dumps({"exceptions": [self._valid_exception(
                allowed_sample_ids=None)]}, ensure_ascii=False), encoding="utf-8")
            msgs = [{"role": "user", "content": "问题？"},
                    {"role": "assistant",
                     "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
            write_jsonl(Path(td) / "s.jsonl",
                        [{"sample_id": "sa1", "group_id": "g", "messages": msgs}])
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import (messages_fingerprint,
                                         reviewed_record_sha256)
            meta = {"sample_id": "sa1", "group_id": "g", "topic": "varieties",
                    "source_doc": "t", "source_ids": ["wcr-varieties-catalog"],
                    "claim_ids": ["claim.varieties.no-absolute-data"],
                    "license_status": "own-original", "review_status": "approved",
                    "data_version": "v", "dedup_fingerprint": "a" * 64,
                    "reviewed_content_sha256": messages_fingerprint(msgs),
                    "source_usage": {"wcr-varieties-catalog": "fact-extraction-rewrite"}}
            meta["reviewed_record_sha256"] = reviewed_record_sha256(meta, msgs)
            write_jsonl(Path(td) / "s.meta.jsonl", [meta])
            proc = run_script("validate_data.py", "--corpus", Path(td) / "s.jsonl",
                              "--meta", Path(td) / "s.meta.jsonl", "--for-training",
                              "--source-exceptions", exc,
                              "--deployment-purpose", "noncommercial-research",
                              "--json")
            self.assertEqual(proc.returncode, 1)
            report = json.loads(proc.stdout)
            codes = {i["code"] for i in report["validation"]["issues"]}
            self.assertIn("source-requires-human-exception", codes)
            self.assertIn("exception-invalid", codes)


class BoundarySchemaTests(unittest.TestCase):
    """阶段四点九：sourceId 严格规范与 valid_until 严格 Schema 的边界用例。

    全部使用临时文件、合成输入与固定 today；不触碰正式例外表。
    """

    TODAY = date(2026, 10, 14)

    def _valid_exception(self, **overrides):
        exc = {
            "sourceId": "wcr-varieties-catalog",
            "usage": "fact-extraction-rewrite",
            "reason": "注册表口径：品种知识仅可独立改写",
            "approved_by": "人工审核人（测试占位）",
            "approved_at": "2026-10-14",
            "scope": "仅非商业训练样本",
            "deployment_purposes": ["noncommercial-research"],
            "allowed_sample_ids": ["sa1"],
            "allowed_topics": ["varieties"],
            "allowed_claim_ids": ["claim.varieties.no-absolute-data"],
            "license_basis": {"basis": "registry-sanctioned-use",
                              "evidence_ref": "knowledge/SOURCE_REGISTRY.md §2"},
        }
        exc.update(overrides)
        return exc

    def _load(self, entries):
        sys.path.insert(0, str(SCRIPTS))
        from coffeeai_common import load_source_exceptions
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "e.json"
            p.write_text(json.dumps({"exceptions": entries}, ensure_ascii=False),
                         encoding="utf-8")
            return load_source_exceptions(p, today=self.TODAY)

    def _single(self, **overrides):
        """返回 (是否生效, 拒绝原因全文)。"""
        valid, rejected = self._load([self._valid_exception(**overrides)])
        return (len(valid) == 1), " | ".join(r["reason"] for r in rejected)

    # ---- sourceId 严格规范
    def test_source_id_whitespace_only_rejected(self):
        ok, reasons = self._single(sourceId="   ")
        self.assertFalse(ok)
        self.assertIn("纯空白", reasons)

    def test_source_id_padded_whitespace_rejected(self):
        ok, reasons = self._single(sourceId=" wcr-varieties-catalog ")
        self.assertFalse(ok)
        self.assertIn("首尾空白", reasons)

    def test_source_id_unhashable_types_rejected(self):
        for bad in ([], {}, 123):
            ok, reasons = self._single(sourceId=bad)
            self.assertFalse(ok, repr(bad))
            self.assertIn("sourceId 必须为字符串", reasons, repr(bad))

    def test_source_id_valid_unique_loads(self):
        ok, reasons = self._single()
        self.assertTrue(ok, reasons)
        valid, _ = self._load([self._valid_exception()])
        self.assertEqual(valid["wcr-varieties-catalog"]["sourceId"],
                         "wcr-varieties-catalog")

    def test_duplicate_valid_ids_still_all_invalid(self):
        """阶段四点八核心保证不回退：重复合法 ID 全部失效。"""
        valid, rejected = self._load([self._valid_exception(), self._valid_exception()])
        self.assertNotIn("wcr-varieties-catalog", valid)
        self.assertEqual(len(rejected), 2)
        for r in rejected:
            self.assertIn("重复", r["reason"])

    # ---- valid_until 严格 Schema
    def test_valid_until_absent_is_allowed(self):
        """字段缺失允许：先显式加入再删除，验证「未提供」语义。"""
        exc = self._valid_exception(valid_until="2030-01-01")
        exc.pop("valid_until")
        valid, rejected = self._load([exc])
        self.assertEqual(len(valid), 1, rejected)
        self.assertEqual(len(rejected), 0)

    def test_valid_until_null_rejected(self):
        ok, reasons = self._single(valid_until=None)
        self.assertFalse(ok)
        self.assertIn("valid_until", reasons)

    def test_valid_until_empty_string_rejected(self):
        ok, reasons = self._single(valid_until="")
        self.assertFalse(ok)
        self.assertIn("valid_until", reasons)

    def test_valid_until_wrong_types_rejected(self):
        for bad in (123, True, [], {}):
            ok, reasons = self._single(valid_until=bad)
            self.assertFalse(ok, repr(bad))
            self.assertIn("valid_until", reasons, repr(bad))

    def test_valid_until_unparseable_string_rejected(self):
        ok, reasons = self._single(valid_until="not-a-date")
        self.assertFalse(ok)
        self.assertIn("无法解析", reasons)

    def test_valid_until_past_rejected_with_expiry_reason(self):
        ok, reasons = self._single(valid_until="2026-01-02")
        self.assertFalse(ok)
        self.assertIn("过期", reasons)

    def test_valid_until_future_allowed(self):
        ok, reasons = self._single(valid_until="2030-01-01")
        self.assertTrue(ok, reasons)

    def test_valid_until_today_allowed(self):
        ok, reasons = self._single(valid_until="2026-10-14")
        self.assertTrue(ok, reasons)


class QualityGateTests(unittest.TestCase):
    """阶段六点三：候选写作质量门禁（术语冻结/F-P-I/诊断链/数字扫描）。"""

    DRAFT_TOOL = COFFEEAI / "review_queue" / "check_candidate_quality.py"

    def _run_gate(self, rows, expect=None):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "draft.jsonl"
            p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                         encoding="utf-8")
            return self._gate_cmd(p, expect)

    def _gate_cmd(self, input_path, expect=None):
        proc = subprocess.run([PY, str(self.DRAFT_TOOL), "--input", str(input_path), "--json"],
                              capture_output=True, text=True, timeout=120, cwd=str(REPO))
        if expect is not None:
            self.assertEqual(proc.returncode, expect,
                             f"exit={proc.returncode}\n--- STDOUT ---\n{proc.stdout}\n--- STDERR ---\n{proc.stderr}")
        return proc

    def _row(self, **overrides):
        row = {
            "sample_id": "t-001", "topic": "espresso",
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": "q?"},
                {"role": "assistant",
                 "content": "Fellow 官方口径把发苦对应研磨偏细，方向磨粗。验证方法是观察流速。"},
            ],
            "claim_ids": ["rule.fellow.shot-bitter"], "source_ids": ["fellow-espresso-basics"],
            "reasoning_level": "F",
        }
        row.update(overrides)
        return row

    def test_avoid_word_kongdong_fails(self):
        """用例 1：含 avoid 词「空洞」必须失败。"""
        row = self._row()
        row["messages"][-1]["content"] += " 中段空洞通常是萃取不足。"
        proc = self._run_gate([row], expect=1)
        self.assertEqual(proc.returncode, 1)
        report = json.loads(proc.stdout)
        self.assertFalse(report["passed"])
        codes = [i["code"] for s in report["samples"] for i in s["issues"]]
        self.assertIn("term-freeze-violation", codes)
        msg = " ".join(i["message"] for s in report["samples"] for i in s["issues"])
        self.assertIn("空洞", msg)
        self.assertIn("寡淡", msg, "应给出推荐替代表达")

    def test_fase_as_chalky_translation_fails(self):
        """用例 2：chalky 误写成「发涩」（非解释性上下文）必须失败。"""
        row = self._row()
        row["messages"][-1]["content"] += " 这就是发涩的来源。"
        proc = self._run_gate([row], expect=1)
        self.assertEqual(proc.returncode, 1)
        report = json.loads(proc.stdout)
        codes = [i["code"] for s in report["samples"] for i in s["issues"]]
        self.assertIn("term-freeze-violation", codes)

    def test_explanatory_fase_mention_exempt(self):
        """解释性提及（俗称发涩，严格说是粉感）豁免——b1-015 补丁模式。"""
        row = self._row()
        row["messages"][-1]["content"] += " 粉感（原文 chalky，俗称发涩，严格说是干燥粉质口感）。"
        proc = self._run_gate([row])
        self.assertEqual(proc.returncode, 0)
        report = json.loads(proc.stdout)
        self.assertTrue(report["passed"])

    def test_correct_fenggan_passes(self):
        """用例 3：正确使用「粉感」通过。"""
        row = self._row()
        row["messages"][-1]["content"] += " 粉感是干燥粉质口感。"
        proc = self._run_gate([row])
        self.assertEqual(proc.returncode, 0)

    def test_f_without_claim_fails(self):
        """用例 4：reasoning_level 含 F 但 claim_ids 为空必须失败。"""
        row = self._row(claim_ids=[])
        proc = self._run_gate([row], expect=1)
        self.assertEqual(proc.returncode, 1)
        codes = [i["code"] for s in json.loads(proc.stdout)["samples"] for i in s["issues"]]
        self.assertIn("f-without-claim", codes)

    def test_i_without_qualifier_fails(self):
        """用例 5：reasoning_level 含 I 但回答无限定词必须失败。"""
        row = self._row()
        row["reasoning_level"] = "F+I"
        row["messages"][-1]["content"] = "Fellow 官方口径把发苦对应研磨偏细。烘焙度也有关。验证方法是观察流速。"
        proc = self._run_gate([row], expect=1)
        self.assertEqual(proc.returncode, 1)
        codes = [i["code"] for s in json.loads(proc.stdout)["samples"] for i in s["issues"]]
        self.assertIn("i-without-qualifier", codes)

    def test_diagnostic_chain_missing_warning(self):
        """用例 6：诊断类主题回答缺少验证步骤 → warning（不 error）。"""
        row = self._row()
        row["messages"][-1]["content"] = "Fellow 官方口径把发苦对应研磨偏细，方向是磨粗。"
        proc = self._run_gate([row])
        report = json.loads(proc.stdout)
        codes = [i["code"] for s in report["samples"] for i in s["issues"]]
        self.assertIn("diagnostic-chain-incomplete", codes)
        self.assertTrue(report["passed"], "warning 不阻断")
        self.assertEqual(report["errors"], 0)

    def test_numeric_without_claim_fails(self):
        """用例 7：回答含数字但 claim_ids 为空 → error。"""
        row = self._row(claim_ids=[])
        row["messages"][-1]["content"] += " 水温用 92°C 比较稳妥。"
        proc = self._run_gate([row], expect=1)
        self.assertEqual(proc.returncode, 1)
        codes = [i["code"] for s in json.loads(proc.stdout)["samples"] for i in s["issues"]]
        self.assertIn("numeric-claim-missing-context", codes)

    def test_real_batch2a_drafts_pass(self):
        """回归：真实 Batch2a 草稿（b2a-002/003）必须通过门禁。"""
        proc = self._gate_cmd(COFFEEAI / "review_queue" / "batch2a_candidates_draft.jsonl", expect=0)
        report = json.loads(proc.stdout)
        self.assertTrue(report["passed"])
        self.assertEqual(report["errors"], 0)


class TestBatch2bInteractionQuality(unittest.TestCase):
    """阶段六点九-C：Batch2b 行为质量门禁（GPT 指定 7 case + 真实草稿回归）。

    新增检查：missing-information-collection / direct-parameter-answer /
    next-step-missing / uncertainty-expression-missing / health-boundary-missing /
    strong-claim-assertion + strong_claim_contexts 语境判定。
    """

    DRAFT_TOOL = COFFEEAI / "review_queue" / "check_candidate_quality.py"

    def _gate(self, rows, expect=None):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "draft.jsonl"
            p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
                         encoding="utf-8")
            proc = subprocess.run([PY, str(self.DRAFT_TOOL), "--input", str(p), "--json"],
                                  capture_output=True, text=True, timeout=120, cwd=str(REPO))
            if expect is not None:
                self.assertEqual(proc.returncode, expect,
                                 f"exit={proc.returncode}\n{proc.stdout}\n{proc.stderr}")
            return json.loads(proc.stdout)

    def _row(self, *, user="问一下。", assistant="回答。", skill=None, topic="espresso",
             claims=("rule.fellow.shot-bitter",), level="F"):
        row = {
            "sample_id": "t-b2b", "topic": topic,
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "user", "content": user},
                {"role": "assistant", "content": assistant},
            ],
            "claim_ids": list(claims), "source_ids": ["fellow-espresso-basics"],
            "reasoning_level": level,
        }
        if skill:
            row["interaction_skill"] = skill
        return row

    def _codes(self, report):
        return [i["code"] for s in report["samples"] for i in s["issues"]]

    # case1: 缺少追问 → error
    def test_case1_missing_info_collection_error(self):
        """clarification 类样本无信息收集段 → missing-information-collection。"""
        report = self._gate([self._row(
            user="我的咖啡很酸，怎么办？",
            assistant="酸的原因有很多，通常是萃取不足。【I：可能与其他因素有关】",
            skill="clarification")], expect=1)
        self.assertIn("missing-information-collection", self._codes(report))

    # case2: 参数问题直接给答案 → error
    def test_case2_direct_parameter_answer_error(self):
        """用户请求参数、回答无来源语境/条件限制 → direct-parameter-answer。"""
        report = self._gate([self._row(
            user="给我一个黄金比例？",
            assistant="按经验推荐一个通用值即可，稳定后不用再改。",
            claims=("rule.fellow.shot-bitter",))], expect=1)
        self.assertIn("direct-parameter-answer", self._codes(report))

    # case3: 含条件建议 → pass
    def test_case3_condition_advice_pass(self):
        """条件化建议 + 信息收集段 → 无 error。"""
        report = self._gate([self._row(
            user="我的手冲味道不对怎么办？",
            assistant="还需要知道你的研磨刻度与滤杯。如果观察到流速偏快，可以尝试磨细一档"
                      "再对比验证；如果情况不同，需要重新判断。建议的下一步是记录参数。",
            skill="condition_based_advice")])
        self.assertTrue(report["passed"])
        self.assertEqual(report["errors"], 0)

    # case4: 不知道能力表达 → pass
    def test_case4_uncertainty_expression_pass(self):
        """uncertainty_handling + 「当前信息不足」限定表达 + 否定语境强断言 → pass。"""
        report = self._gate([self._row(
            user="这个豆子为什么有茉莉花香？",
            assistant="当前信息不足，无法判断唯一原因，可能与产地和处理法有关，需要进一步确认。"
                      "还需要知道：产地、处理法、烘焙度。",
            skill="uncertainty_handling", topic="sensory")])
        self.assertTrue(report["passed"])
        self.assertEqual(report["errors"], 0)
        ctx = report["samples"][0].get("strong_claim_contexts", [])
        self.assertTrue(any(c["keyword"] == "唯一原因" and c["verdict"] == "negation-context"
                            for c in ctx), f"否定语境应记 pass：{ctx}")

    # case5: 健康回答无医疗边界 → error
    def test_case5_health_boundary_missing_error(self):
        """健康类回答缺非医疗建议边界声明 → health-boundary-missing。"""
        report = self._gate([self._row(
            user="每天喝咖啡健康吗？",
            assistant="对多数成人每天 400 mg 一般没问题，放心喝。",
            topic="health")], expect=1)
        self.assertIn("health-boundary-missing", self._codes(report))

    # case6: 否定黄金参数 → pass
    def test_case6_negated_golden_param_pass(self):
        """「没有适用于所有豆子的黄金参数」是拒绝伪标准，strong_claim_contexts 记 pass。"""
        report = self._gate([self._row(
            user="给我黄金比例？",
            assistant="没有适用于所有豆子的黄金参数，配方取决于豆子与器具；建议的下一步是"
                      "先固定一个起点做基准再调整。",
            skill="boundary_setting")])
        self.assertTrue(report["passed"])
        self.assertEqual(report["errors"], 0)
        ctx = report["samples"][0].get("strong_claim_contexts", [])
        self.assertTrue(any(c["keyword"] == "黄金参数" and c["verdict"] == "negation-context"
                            for c in ctx), f"否定语境应记 pass：{ctx}")

    # case7: 黄金参数作为推荐 → error
    def test_case7_golden_param_assertion_error(self):
        """肯定句式「黄金参数是 X」→ strong-claim-assertion（制造伪标准）。"""
        report = self._gate([self._row(
            user="给我黄金比例？",
            assistant="黄金参数是 1:16，照做即可。")], expect=1)
        self.assertIn("strong-claim-assertion", self._codes(report))

    def test_case8_next_step_missing_warning(self):
        """诊断类回答只解释原因无行动建议 → next-step-missing（warning 不阻断）。"""
        report = self._gate([self._row(
            user="为什么我的浓缩流速慢？",
            assistant="Fellow 官方口径把流速偏慢对应研磨偏细。")])
        self.assertIn("next-step-missing", self._codes(report))
        self.assertTrue(report["passed"], "warning 不阻断")

    def test_case9_real_batch2b_drafts_pass(self):
        """回归：真实 Batch2b 草稿 8 条必须 0 error 通过增强后门禁；禁止肯定式伪标准。"""
        proc = subprocess.run([PY, str(self.DRAFT_TOOL), "--input",
                               str(COFFEEAI / "review_queue" / "batch2b_candidates_draft.jsonl"),
                               "--json"], capture_output=True, text=True, timeout=120, cwd=str(REPO))
        self.assertEqual(proc.returncode, 0, proc.stdout)
        report = json.loads(proc.stdout)
        self.assertTrue(report["passed"])
        self.assertEqual(report["errors"], 0)
        codes = self._codes(report)
        self.assertNotIn("strong-claim-assertion", codes)
        self.assertNotIn("missing-information-collection", codes)
        self.assertNotIn("direct-parameter-answer", codes)
        self.assertNotIn("uncertainty-expression-missing", codes)
        self.assertNotIn("health-boundary-missing", codes)


class ExceptionTopicCoverageTests(unittest.TestCase):
    """阶段六点九-E：多来源样本的例外 allowed_topics 覆盖治理（GPT 指定 3 case）。

    背景：batch2b 落库时发现多来源样本的 topic 必须同时落在每个命中例外的
    allowed_topics 内（check_exception_scope 逐例外独立检查、无并集——fail-closed
    是有意设计，GPT 裁定不改为并集语义）。本测试固化该语义，避免再依赖人工发现。
    """

    @staticmethod
    def _registry(*source_ids):
        return {sid: {"status": "active", "license_status": "see-source-terms",
                      "commercialUse": "unclear", "derivatives": "unclear"}
                for sid in source_ids}

    @staticmethod
    def _exception(source_id, topics, samples):
        return {"sourceId": source_id, "usage": "fact-extraction-rewrite",
                "deployment_purposes": ["noncommercial-research"],
                "allowed_topics": list(topics), "allowed_sample_ids": list(samples),
                "allowed_claim_ids": ["claim.test.generic"]}

    def _admit(self, source_ids, exceptions, topic="brewing"):
        sys.path.insert(0, str(SCRIPTS))
        from coffeeai_common import source_admission_issues
        return source_admission_issues(
            source_ids, self._registry(*source_ids),
            {sid: "fact-extraction-rewrite" for sid in source_ids},
            exceptions=exceptions, deployment_purpose="noncommercial-research",
            sample={"sample_id": "t-multi", "topic": topic, "claim_ids": ["claim.test.generic"]})

    def _exc_map(self, *excs):
        return {e["sourceId"]: e for e in excs}

    def test_case1_intersecting_topics_pass(self):
        """case1：两来源 topics 有交集 → PASS。"""
        excs = self._exc_map(
            self._exception("src-a", ["brewing", "espresso"], ["t-multi"]),
            self._exception("src-b", ["brewing", "health"], ["t-multi"]))
        self.assertEqual(self._admit(["src-a", "src-b"], excs), [])

    def test_case2_disjoint_topics_block(self):
        """case2：两来源 topics 无交集 → BLOCK（fail-closed，不得改并集语义）。"""
        excs = self._exc_map(
            self._exception("src-a", ["brewing"], ["t-multi"]),
            self._exception("src-b", ["health"], ["t-multi"]))
        issues = self._admit(["src-a", "src-b"], excs)
        self.assertTrue(any(i["code"] == "exception-out-of-scope" for i in issues),
                        f"无交集必须 BLOCK：{issues}")

    def test_case3_topic_extension_resolves(self):
        """case3：对齐扩展第二来源 topics 后 → PASS（六点九-E 修正版方案 A 模式）。"""
        excs = self._exc_map(
            self._exception("src-a", ["brewing"], ["t-multi"]),
            self._exception("src-b", ["health", "brewing"], ["t-multi"]))
        self.assertEqual(self._admit(["src-a", "src-b"], excs), [])


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
