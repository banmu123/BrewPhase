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
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import messages_fingerprint
            tiny_msgs = [{"role": "user", "content": "q?"},
                         {"role": "assistant",
                          "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
            write_jsonl(m, [{"sample_id": "t1", "topic": "t", "license_status": "own-original",
                             "review_status": "approved", "data_version": "v",
                             "dedup_fingerprint": "a" * 64,
                             "reviewed_content_sha256": messages_fingerprint(tiny_msgs),
                             "source_waiver": "测试样本：无外部事实来源。"}])
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
                # 阶段四：approved 样本必须绑定审核内容指纹
                sys.path.insert(0, str(SCRIPTS))
                from coffeeai_common import messages_fingerprint
                meta["reviewed_content_sha256"] = messages_fingerprint(msgs)
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
                              "--data-dir", out)
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
                    review="approved", license_status="own-original"):
        c = Path(td) / "s.jsonl"
        m = Path(td) / "s.meta.jsonl"
        msgs = [{"role": "user", "content": "问题？"},
                {"role": "assistant", "content": "足够长的回答内容，用来通过最短长度检查的全部要求。"}]
        write_jsonl(c, [{"sample_id": "sa1", "group_id": "g-sa", "messages": msgs}])
        meta = {"sample_id": "sa1", "group_id": "g-sa", "topic": "t", "source_doc": "t",
                "source_ids": source_ids, "claim_ids": claim_ids,
                "license_status": license_status, "review_status": review,
                "data_version": "v", "dedup_fingerprint": "a" * 64}
        if review == "approved":
            sys.path.insert(0, str(SCRIPTS))
            from coffeeai_common import messages_fingerprint
            meta["reviewed_content_sha256"] = messages_fingerprint(msgs)
        if usage is not None:
            meta["source_usage"] = usage
        if waiver is not None:
            meta["source_waiver"] = waiver
        write_jsonl(m, [meta])
        return c, m

    def _for_training(self, c, m, exceptions=None):
        args = ["validate_data.py", "--corpus", c, "--meta", m, "--for-training"]
        if exceptions is not None:
            exc = Path(exceptions)
            if not exc.is_absolute():
                exc = Path.cwd() / exc
            args += ["--source-exceptions", exc]
        return run_script(*args)

    def _write_exceptions(self, td, entries):
        p = Path(td) / "exceptions.json"
        p.write_text(json.dumps({"schemaVersion": 1, "exceptions": entries},
                                ensure_ascii=False, indent=2), encoding="utf-8")
        return p

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
        """有效人工例外（审批人/日期/范围齐全）才放行，且范围限定为 fact-extraction-rewrite。"""
        with tempfile.TemporaryDirectory() as td:
            exc = self._write_exceptions(td, [{
                "sourceId": "wcr-varieties-catalog", "usage": "fact-extraction-rewrite",
                "reason": "注册表口径：品种知识仅可独立改写，禁止复制目录表格",
                "approved_by": "人工审核人（测试占位）", "approved_at": "2026-10-14",
                "scope": "仅非商业训练样本；逐条人工审核；不复制原文",
            }])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._for_training(c, m, exceptions=exc)
            self.assertNotIn("source-requires-human-exception", proc.stdout)

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
        with tempfile.TemporaryDirectory() as td:
            exc = self._write_exceptions(td, [{
                "sourceId": "wcr-varieties-catalog", "usage": "fact-extraction-rewrite",
                "reason": "已过期", "approved_by": "人工审核人", "approved_at": "2026-01-01",
                "scope": "n/a", "valid_until": "2026-01-02",
            }])
            c, m = self._one_sample(td, ["wcr-varieties-catalog"],
                                    ["claim.varieties.no-absolute-data"],
                                    {"wcr-varieties-catalog": "fact-extraction-rewrite"})
            proc = self._for_training(c, m, exceptions=exc)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("source-requires-human-exception", proc.stdout)

    def test_public_domain_auto_allowed(self):
        """fda-caffeine（public-domain + allowed/allowed）无需例外即可自动准入。"""
        with tempfile.TemporaryDirectory() as td:
            c, m = self._one_sample(td, ["fda-caffeine"], ["claim.health.fda-400"],
                                    {"fda-caffeine": "fact-extraction-rewrite"})
            proc = self._for_training(c, m)
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
            proc = self._for_training(c, m)
            self.assertNotIn("missing-source-waiver", proc.stdout)

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
                          "--allow-download")
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
                          "--config", COFFEEAI / "configs" / "smoke.yaml")
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
    from coffeeai_common import messages_fingerprint
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
        rows_m.append({"sample_id": f"cb-{i}", "group_id": f"g-cb-{i}", "topic": "t",
                       "source_doc": "t", "source_ids": [], "claim_ids": [],
                       "license_status": "own-original", "review_status": "approved",
                       "data_version": "v", "dedup_fingerprint": messages_fingerprint(msgs),
                       "reviewed_content_sha256": messages_fingerprint(msgs),
                       "source_waiver": "测试样本：无外部事实来源。"})
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
