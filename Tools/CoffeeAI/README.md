# CommitBrew Coffee AI V1 — 自研咖啡领域模型微调工程

> 目标：把通用开源大模型（起步：Qwen3-4B-Instruct-2507 4bit / MLX-LM QLoRA）逐步微调为
> 可靠、知边界、不编造来源的咖啡领域助手。
>
> **当前状态（2026-10-14）：训练基础设施与验证流程已就绪并通过 22 项自动化测试；
> 真实训练数据尚未准备好**（`data/corpus/` 里只有 10 条标记为 `unreviewed` 的示例，
> 默认不会、也不允许进入训练）。
>
> **阶段二（2026-10-14）**：新增 `review_queue/` —— 30 条新候选（`b1-001`~`b1-030`，
> 全部锚定真实 claim/rule/conflict ID）+ 存量 10 条示例的审查结论 + 逐条人工审核清单。
> 候选池共 40 条，全部 `unreviewed`，与正式语料目录隔离。审核流程见
> `review_queue/batch1_review_report.md` 与 `review_queue/COVERAGE_REPORT.md`。
>
> **阶段三（2026-10-14）**：训练安全修复 —— ① 正式训练/烟测前对划分产物做**独立准入复查**
> （重读 meta，未审核/许可不明/来源不合规一律阻断，`--include-unreviewed` 产物不再可能
> 进入训练）；② 来源级准入政策落地（pending-verification/付费墙/受限资产阻断训练，
> 外部来源必须声明 `fact-extraction-rewrite` 用法并提供 claim 关联）；③ `--allow-download`
> 仅对 `--train` 生效，烟测与 dry-run 绝不下载；④ 评测改用模型聊天模板
> （`--system-prompt` + 默认模板，双模型参数一致）。测试 27 → **41 项**。
>
> **阶段四（2026-10-14）**：关闭训练安全缺口 —— ① **来源默认拒绝**：仅 public-domain 且
> commercialUse/derivatives 均 allowed 的 active 来源自动准入；其余来源需在
> `source_exceptions.json` 登记有效人工例外（审批人/日期/范围，fail-closed），
> `wcr-varieties-catalog` 默认阻断（有回归测试）；② **有效配置唯一化**：`--model`/
> `--data-dir` 覆盖统一写入 effective_config，preflight/显示/smoke/正式训练执行同一份
> 配置，manifest 记录配置摘要；③ **审核内容绑定**：approved 样本必须携带
> `reviewed_content_sha256`，准入复查重算实际 messages 摘要逐条比对，篡改即阻断。
> 测试 41 → **53 项**。影响通告见 `review_queue/batch1_review_report.md` 阶段四节。

## 0. 红线（先读）

1. **未经人工审核（`review_status: approved`）的样本，任何脚本都不会放进训练集**——
   这是硬编码行为，不是约定：划分脚本默认排除；即使有人用 `--include-unreviewed`
   生成划分，`run_train.py` 在正式训练/烟测前会**独立重读划分产物元数据做准入复查**
   （`validate_data.check_training_admission`），发现任何未审核/许可不明/来源不合规/
   元数据不全的样本即拒绝启动。
2. 许可纪律沿用 `knowledge/SOURCE_REGISTRY.md`，并在阶段四升级为**来源默认拒绝**：
   仅 public-domain 且 commercialUse/derivatives 均 allowed 的 active 来源（当前只有
   `fda-caffeine`）可自动用于「事实提取+独立改写」；pending-verification / 付费墙 /
   restricted / unknown 一律阻断；其余来源必须在 `Tools/CoffeeAI/source_exceptions.json`
   登记有效人工例外（审批人/日期/范围必填，fail-closed）。本检查执行项目自身政策，
   不构成法律意见。
3. 不上传、不采集 BrewPhase 用户的豆子/冲煮/品鉴数据；用户 JSON 备份不得当语料。
4. 本工程不提交模型权重、训练缓存、派生 splits 与评测输出（见仓库根 `.gitignore`）。
5. 不自动下载模型、不自动训练；下载与训练都需要你显式执行命令。
6. 与 BrewPhase iOS 产品、`FlavorWindowPredictor`/XGBoost、知识检索架构完全隔离。

## 1. 目录结构

```
Tools/CoffeeAI/
├── README.md                     本文件
├── configs/
│   ├── m2_16gb_qwen3_4b_qlora.yaml   正式训练配置（官方 lora_config 字段，QLoRA 保守参数）
│   └── smoke.yaml                    烟测配置（2 iters，只验证管线）
├── data/
│   ├── corpus/examples_unreviewed.jsonl   10 条示例样本（messages，unreviewed）
│   ├── meta/examples_unreviewed.meta.jsonl 对应元数据（来源/许可/审核状态/指纹）
│   └── splits/                            划分产物（gitignore，可随时重新生成）
├── scripts/
│   ├── coffeeai_common.py        共享库（加载/指纹/相似度/注册表核对）
│   ├── env_check.py              环境检测（芯片/内存/磁盘/Python/mlx/HF 缓存）
│   ├── validate_data.py          数据验证（单条/训练前置/跨集合泄漏）
│   ├── split_dataset.py          数据集划分（按题组、可复现、防泄漏）
│   ├── make_train_config.py      生成 MLX-LM YAML 配置（官方 schema 自检）
│   ├── run_train.py              preflight + dry-run / smoke / train + run manifest
│   └── evaluate.py               基础模型 vs 微调模型对比评测（待人工审核）
├── tests/
│   ├── fixtures/                 10 条 approved 夹具（仅用于测试，不是训练数据）
│   └── test_coffeeai.py          22 项自动化测试（unittest，仅标准库）
└── runs/                         训练/评测输出（gitignore）
```

## 2. 数据规范

每条样本 = **语料行（训练内容） + 元数据行（来源与许可）**，两个文件、`sample_id` 关联：

```jsonl
// corpus: 训练内容，MLX-LM chat 格式
{"sample_id": "coffee-001", "group_id": "g-rest", "messages": [
  {"role": "system", "content": "你是咖啡领域助手。回答需区分事实与推断，资料不足时明确说明，不编造来源。"},
  {"role": "user", "content": "浅烘咖啡为什么需要养豆？"},
  {"role": "assistant", "content": "……"}]}

// meta: 模型永远看不到这些字段
{"sample_id": "coffee-001", "topic": "freshness-rest", "source_doc": "...",
 "source_ids": ["wcr-varieties-catalog"], "claim_ids": [],
 "license_status": "own-original", "review_status": "unreviewed",
 "data_version": "v0.1", "dedup_fingerprint": "<sha256(messages)>"}
```

字段含义：

| 字段 | 约束 |
|---|---|
| `sample_id` | 全局唯一 |
| `group_id` | **同题组（含近似改写）必须同组**，划分按组整体分配，杜绝泄漏 |
| `license_status` | 允许训练：`own-original / approved / ok / public-domain / cc-by / cc-by-sa`；`unknown / see-source-terms / paywalled / restricted / cc-by-nc*` 一律拒绝 |
| `review_status` | `approved` 才可训练；**审核由人完成，脚本不得自封**（有测试盯着） |
| `dedup_fingerprint` | `sha256(messages)`，`Tools/CoffeeAI/scripts` 里的工具会核对其一致性 |
| `source_ids` | 必须已注册于 `knowledge/SOURCE_REGISTRY.json`；`pending-verification` 来源会被警告 |

**如何准备第一批真实数据（建议顺序）**：

1. 从 `knowledge/` 中挑 3–5 个 `status: filled` 的主题（如萃取诊断、养豆、感官 vs 喜好）；
2. 依据知识文档**独立撰写**问答对（不复制任何来源正文；写成「常见线索 + 适用范围 + 不确定性」的口径，对齐 `knowledge/_method/METHODOLOGY.md` §4）；
3. `license_status` 用 `own-original`（原创）；若依据某个已注册来源的事实，把 `source_ids` 填上；
4. 人工逐条审阅事实准确性与口径，把 `review_status` 改为 `approved` 并签名（`notes` 里记审核人/日期）；
5. 跑 `validate_data.py` → `split_dataset.py` → `run_train.py --dry-run` 复查。

## 3. 命令参考

```bash
# 0) 环境（本机实测通过，见 §5）
python3 Tools/CoffeeAI/scripts/env_check.py --check-model mlx-community/Qwen3-4B-Instruct-2507-4bit

# 1) 验证数据（默认扫 data/corpus + data/meta）
python3 Tools/CoffeeAI/scripts/validate_data.py
python3 Tools/CoffeeAI/scripts/validate_data.py --for-training   # 训练前置严格模式

# 2) 划分（只吃 approved 样本；同 seed 结果逐字节一致）
python3 Tools/CoffeeAI/scripts/split_dataset.py [--seed 42] [--train 0.8 --valid 0.1 --test 0.1]

# 3) 配置 / 预览
python3 Tools/CoffeeAI/scripts/make_train_config.py --dry-run
python3 Tools/CoffeeAI/scripts/run_train.py --dry-run            # 只预览，不训练不下载

# 4) 安装依赖（需要联网，你手动执行；依赖约 0.3–0.6GB）
pip install "mlx-lm[train]"

# 5) 下载模型（需要联网，约 2.4–2.6GB，以模型卡为准；推荐先手动下载）
huggingface-cli download mlx-community/Qwen3-4B-Instruct-2507-4bit
#   或正式训练时显式允许下载： run_train.py --train --allow-download
#   （--allow-download 仅对 --train 生效；--dry-run 与 --smoke 即使传入也绝不下载）

# 6) 烟测（2 iters，只验证管线，不代表质量）
python3 Tools/CoffeeAI/scripts/run_train.py --smoke --config Tools/CoffeeAI/configs/smoke.yaml

# 7) 正式训练（preflight 全过后才启动；结束后写 runs/<run_id>/run_manifest.json）
python3 Tools/CoffeeAI/scripts/run_train.py --train --config Tools/CoffeeAI/configs/m2_16gb_qwen3_4b_qlora.yaml

# 8) 对比评测（基础 vs 微调；system+user 经模型聊天模板渲染，双模型参数一致）
python3 Tools/CoffeeAI/scripts/evaluate.py \
  --base-model mlx-community/Qwen3-4B-Instruct-2507-4bit \
  --adapter-path Tools/CoffeeAI/runs/adapters \
  --questions Tools/CoffeeAI/data/splits/test.jsonl --limit 10

# 9) 划分产物准入复查（正式训练前会被 run_train 自动执行，也可手动跑）
python3 Tools/CoffeeAI/scripts/validate_data.py --check-admission Tools/CoffeeAI/data/splits
```

训练配置严格落在当前版本 MLX-LM 官方 `examples/lora_config.yaml` 字段内
（`model / fine_tune_type / data / iters / batch_size / num_layers / learning_rate /
max_seq_length / grad_checkpoint / lora_parameters / …`，有测试逐字段校验，出现
schema 外字段会直接报错）。量化模型官方按 QLoRA 训练，无需额外开关。

## 4. 模型选择与理由（本机 Apple M2 / 16GB 实测）

| 项 | 结论 |
|---|---|
| 芯片 | Apple M2 (arm64) —— MLX 路线可用 |
| 统一内存 | 16.0 GB —— 按任务规则走 4B 4bit 方案 |
| 可用磁盘 | 153.6 GB（2026-10-14 实测） |
| Python | 3.13.12（managed）；mlx/mlx-lm **尚未安装**（如实报告，见下） |
| 选型 | `mlx-community/Qwen3-4B-Instruct-2507-4bit`（QLoRA） |

理由：16GB 内存下 4B@4bit 权重约 2.4–2.6GB，配 batch_size=1、num_layers=8、
grad_checkpoint 的保守配置余量充足；1B–2B 模型只作为内存不足时的降级备选。

**如实说明**：本次会话中 HuggingFace 网络不可达（API 返回 406），模型卡的
确切大小与许可证未能在线复核——脚本已在运行时如实标注「以模型卡为准」，
且任何下载动作都被设计为需要你显式批准。安装 mlx-lm 后请先跑
`env_check.py` 与 `run_train.py --dry-run` 复核再继续。

## 5. 验收结果（真实执行，2026-10-14）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | 验证脚本能发现无效 JSONL/缺字段/空回答 | ✅ `test_bad_jsonl_and_missing_fields` 等 |
| 2 | 划分可复现，题组/高相似不跨集合泄漏 | ✅ `test_deterministic` / `test_no_leakage`（同 seed 逐字节一致；曾实测抓到同组改写被拆开的 bug 并已修复） |
| 3 | 未审核/许可不明数据默认不进训练 | ✅ `test_unreviewed_excluded_by_default` / `test_default_examples_are_rejected_for_training`；无 approved 数据时划分直接拒绝 |
| 4 | 环境检测识别 Apple Silicon/内存/磁盘不足 | ✅ `test_env_detects_insufficient_mem_and_disk`（阈值模拟触发 exit 1） |
| 5 | 训练配置与当前版 MLX-LM 参数一致 | ✅ `test_config_fields_match_official_schema`（字段对照官方 lora_config.yaml） |
| 6 | dry-run 显示模型/数据/配置/输出且不训练 | ✅ `test_dry_run_no_training_no_download`；阻断项会如实列出 |
| 7 | smoke/ train 仅显式执行；不擅自下载 | ✅ `test_train_requires_model_and_real_data`（模型不在本地时拒绝，提示 --allow-download） |
| 8 | 评测读独立测试集并保存待审核回答 | ✅ `test_evaluate_refuses_without_mlx_or_model`（守卫生效；生成部分待装 mlx 后运行） |
| 9 | 不影响 iOS 工程与现有测试 | ✅ `test_existing_kb_build_check_still_passes`（`build_kb.py --check` 通过）；未改动 `BrewPhase/` 任何文件 |
| 10 | README 结果对应真实执行 | 本表全部来自上面实际运行的测试与命令 |

**测试汇总**：阶段一 22 项 → 阶段二 27 项 → 阶段三 41 项 → **阶段四 53 项（2026-10-14 实测：Ran 53 tests, OK，Python 3.13.12）**。阶段四新增：`wcr-varieties-catalog` 默认阻断、有效/缺失/过期人工例外、public-domain 自动准入、篡改训练文本阻断（admission-content-mismatch）、缺审核指纹阻断、跨集合重复、有效配置覆盖与往返一致性、dry-run 展示有效配置。

## 6. 已知限制

- mlx-lm 未安装、模型未下载——训练/评测的**运行时**路径（真实微调、生成回答）尚未在真机上跑过；管线正确性由 dry-run、配置 schema 校验与守卫测试覆盖。
- HuggingFace 本次不可达：模型大小/许可证需在下载前按模型卡人工复核。
- 高相似扫描基于 `difflib.SequenceMatcher`，>3000 条样本会跳过全量对比（有明确警告）；后续可换 embedding 去重。
- 训练数据为 0：当前所有"训练产物"都只能从 fixture 演练获得。
- 评测为人工审核口径：自动指标（如 loss/BLEU）刻意不作为质量结论依据。

## 7. 接入 BrewPhase 问答的下一步（V1 之后）

1. 用 `evaluate.py` 的回答对 + 人工审核确定微调确实带来价值后，`mlx_lm.fuse` 合并适配器（本地，不发布）；
2. 评估 iOS 侧推理路线：MLX 不直接跑在 iOS 上，可走 `mlx_lm.fuse --export-gguf` → llama.cpp/MLC 在端侧量化推理（GGUF 导出对 Qwen 类模型的支持需届时实测）；
3. 端侧只放 fuse 后的量化权重 + 系统提示词；检索仍走现有 `knowledge/` RAG 管线，微调模型只负责「口径与表达」，不负责「事实存储」——这样知识更新不需要重训模型。
