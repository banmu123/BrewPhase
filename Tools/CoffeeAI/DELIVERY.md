# CommitBrew Coffee AI V1 — 交付说明文档

> 日期：2026-10-14 ｜ 状态：训练基础设施就绪，停在可审查的 dry-run 阶段
> 项目手册（长期维护）：同目录 `README.md` ｜ 本文是本次工作的交付记录与使用指南

---

## 一、本次做了什么

在 BrewPhase 仓库中新建了**自研咖啡领域大模型微调工程** `Tools/CoffeeAI/`，
与 iOS 产品、`FlavorWindowPredictor`/XGBoost、知识检索架构完全隔离。具体包括：

1. **检查了仓库与环境**：Git 状态（main 分支，除 `.DS_Store` 外干净）、知识库来源与
   许可纪律（`knowledge/SOURCE_REGISTRY.md`，51 条来源）、`Tools/Models/`（XGBoost
   mlpackage，未触碰）、发现仓库原本**没有 `.gitignore`**。
2. **核对了 MLX-LM 官方微调规范**（main 分支 `mlx_lm/LORA.md` + `examples/lora_config.yaml`）：
   `chat` 数据格式、`train/valid/test.jsonl` 约定、YAML 字段名、QLoRA 行为、fuse 命令。
   所有配置字段严格取自官方 schema，禁止自造字段（有测试盯着）。
3. **搭建了六个工具脚本**（详见第三节），覆盖 环境检测 → 数据验证 → 数据集划分 →
   配置生成 → 训练启动（preflight + dry-run/smoke/train）→ 对比评测 全链路。
4. **准备了示例数据**：10 条明确标记 `unreviewed` 的咖啡问答示例（原创、未复制任何
   来源正文），以及 10 条仅供自动化测试的 `approved` 夹具。
5. **新建了仓库根 `.gitignore`**：模型权重、训练输出、派生 splits、Python 缓存不入库。
6. **跑了 22 项自动化测试，全部通过**；未改动 `BrewPhase/` 任何 iOS 文件
   （`Tools/knowledge/build_kb.py --check` 复验通过）。

**没有做的事（刻意停下）**：未安装 mlx-lm、未下载模型、未执行任何训练——按任务要求
停在 dry-run 可审查阶段；下载与训练都需要你显式执行命令。

## 二、环境检测结论（真实执行结果）

| 项 | 结果 | 对选型的含义 |
|---|---|---|
| 芯片 | Apple M2（arm64） | MLX 路线可用 |
| 统一内存 | 16.0 GB | 按规则走 4B 4bit 方案 |
| 可用磁盘 | 153.6 GB | 余量充足 |
| Python | 3.13.12 | 满足要求 |
| mlx / mlx-lm | **未安装** | 脚本如实报告，给出安装命令 |
| HuggingFace | 本次会话不可达（API 406） | 模型大小/许可证标注「以模型卡为准」，需下载前人工复核 |

**模型选型**：`mlx-community/Qwen3-4B-Instruct-2507-4bit`（QLoRA，权重约 2.4–2.6GB，
以模型卡为准）。训练配置采用保守起点：`batch_size=1、num_layers=8、max_seq_length=1024、
grad_checkpoint=true、iters=300、lr=1e-4、LoRA rank=8`。

## 三、新建/修改文件清单

```
.gitignore                                      [新建] 排除权重/训练输出/缓存
Tools/CoffeeAI/
├── README.md                                   项目手册：数据规范、命令、许可红线、验收表
├── DELIVERY.md                                 本文件
├── configs/
│   ├── m2_16gb_qwen3_4b_qlora.yaml             正式训练配置（官方 schema 字段）
│   └── smoke.yaml                              烟测配置（2 iters，只验证管线）
├── data/
│   ├── README.md                               数据目录说明
│   ├── corpus/examples_unreviewed.jsonl        10 条示例（训练内容，unreviewed，禁训练）
│   └── meta/examples_unreviewed.meta.jsonl     对应元数据（来源/许可/审核状态/指纹）
├── scripts/
│   ├── coffeeai_common.py                      共享库：JSONL 加载、指纹、相似度、注册表核对
│   ├── env_check.py                            环境检测（芯片/内存/磁盘/Python/mlx/HF 缓存）
│   ├── validate_data.py                        数据验证（单条结构 / --for-training 严格模式 / 跨集合泄漏）
│   ├── split_dataset.py                        数据集划分（按题组+高相似并组、固定种子可复现、不足即拒绝）
│   ├── make_train_config.py                    生成 MLX-LM YAML（字段越界即报错）
│   ├── run_train.py                            preflight + dry-run / smoke / train + run_manifest.json
│   └── evaluate.py                             基础 vs 微调对比评测（产出待人工审核的回答对）
├── tests/
│   ├── fixtures/fixture_approved.jsonl(+meta)  10 条 approved 夹具（仅供测试，不是训练数据）
│   └── test_coffeeai.py                        22 项自动化测试（unittest，仅标准库）
└── runs/                                       训练/评测输出目录（空，已 gitignore）
```

## 四、工程如何运转（数据流）

```
knowledge/（检索资料，不直接进训练）
        │  人工撰写 + 人工审核
        ▼
data/corpus/*.jsonl  +  data/meta/*.meta.jsonl      ← messages 与元数据分文件
        │
        ├─→ validate_data.py                        抓坏 JSONL/缺字段/空回答/重复/许可问题
        │        └─ --for-training：非 approved 一律拒绝
        ▼
split_dataset.py  ──→  data/splits/{train,valid,test}.jsonl + split_report.json
        │        （按 group_id 整组划分 + 高相似自动并组；同 seed 逐字节可复现；
        │          有效数据不足时明确拒绝，不伪造比例）
        ▼
make_train_config.py → configs/*.yaml（字段严格 = MLX-LM 官方 schema）
        ▼
run_train.py --dry-run   → 只打印模型/数据/配置/输出，不训练不下载
run_train.py --smoke     → 2 iters 管线验证（需模型已在本地，绝不擅自下载）
run_train.py --train     → preflight 全过后调官方 mlx_lm.lora，写 run_manifest.json
        ▼
evaluate.py  → 同一批独立测试题，基础模型 vs 基础+适配器 双路回答
              → answers_*.jsonl + eval_report.md（人工审核六维度，不做自动打分）
```

## 五、硬性红线（脚本强制，非口头约定）

1. `review_status != approved` 的样本**进不了训练集**；许可不在白名单
   （`own-original/approved/ok/public-domain/cc-by/cc-by-sa`）同样拒绝。
2. 任何脚本都**不自动下载模型、不自动开始训练**；`--allow-download` 必须显式传入。
3. NC-ND（WCR/SCA 风味轮）、付费墙（SCA Handbooks、Barista Hustle）、
   `license: unknown` 的内容不可复制改编为语料（沿用 `SOURCE_REGISTRY.md` 纪律）。
4. 不采集、不上传 BrewPhase 用户数据；用户 JSON 备份不得当语料。
5. 模型权重、训练缓存、派生 splits、评测输出不入 Git。
6. 测试会检查正式数据目录里**不允许出现脚本自封的 approved 样本**——审核是人做的事。

## 六、验收结果（真实执行，2026-10-14）

`python3 Tools/CoffeeAI/tests/test_coffeeai.py` → **Ran 22 tests, OK**

| 验收项 | 结果 |
|---|---|
| 验证脚本抓无效 JSONL/缺字段/空回答/完全重复 | ✅（`test_bad_jsonl_and_missing_fields` 等） |
| 划分可复现、题组与高相似样本不跨集合 | ✅（同 seed 逐字节一致；期间实测抓到并修复一个真 bug） |
| 未审核/许可不明数据默认不进训练 | ✅（无 approved 数据时划分直接拒绝并明确提示） |
| 环境检测识别 Apple Silicon/内存/磁盘不足 | ✅（阈值模拟触发 exit 1） |
| 训练配置与当前版 MLX-LM 参数一致 | ✅（逐字段对照官方 lora_config.yaml） |
| dry-run 显示模型/数据/配置/输出且不执行 | ✅（阻断项如实列出，exit code 诚实） |
| smoke/train 仅显式执行、不擅自下载 | ✅（模型不在本地时拒绝并提示 --allow-download） |
| 评测守卫（无 mlx/无模型 → 拒绝而非假装成功） | ✅（生成路径待装 mlx 后真机验证） |
| 不影响 iOS 工程与现有测试 | ✅（`build_kb.py --check` 通过；未改 `BrewPhase/`） |
| 文档结果对应真实执行 | 本表全部来自实际运行 |

## 七、已知限制（诚实清单）

- **训练数据为 0**：`data/corpus/` 只有 10 条 unreviewed 示例。当前任何"训练成果"都
  不存在，也没有可宣称的质量提升。
- **运行时路径未真机跑过**：mlx-lm 未安装、模型未下载；`--smoke/--train/evaluate` 的
  真实执行效果待装好依赖后验证（正确性目前由 dry-run、schema 校验与守卫测试覆盖）。
- **HuggingFace 当日不可达**：模型确切大小与许可证需在下载前按模型卡人工复核。
- 高相似扫描基于 `difflib`（O(n²)），>3000 条样本自动跳过全量对比（有明确警告）；
  后续可升级为 embedding 去重。
- 评测是人工审核口径：训练损失与自动指标刻意不作为"模型变好"的证据。

## 八、你接下来要做的事（按顺序）

```bash
# 1) 准备真实数据（核心工作，README §2 有完整流程）
#    从 knowledge/ 的 filled 主题独立撰写问答对 → 人工审核 → 置 approved
#    产出: data/corpus/coffee_v1.jsonl + data/meta/coffee_v1.meta.jsonl

# 2) 验证与划分
python3 Tools/CoffeeAI/scripts/validate_data.py --for-training
python3 Tools/CoffeeAI/scripts/split_dataset.py

# 3) 安装依赖（联网，约 0.3–0.6GB）
pip install "mlx-lm[train]"

# 4) 复核环境与配置
python3 Tools/CoffeeAI/scripts/env_check.py
python3 Tools/CoffeeAI/scripts/run_train.py --dry-run     # 不下载不训练

# 5) 下载模型（联网，约 2.4–2.6GB，先人工核对模型卡的许可证与大小）
huggingface-cli download mlx-community/Qwen3-4B-Instruct-2507-4bit

# 6) 烟测 → 正式训练 → 评测
python3 Tools/CoffeeAI/scripts/run_train.py --smoke --config Tools/CoffeeAI/configs/smoke.yaml
python3 Tools/CoffeeAI/scripts/run_train.py --train --config Tools/CoffeeAI/configs/m2_16gb_qwen3_4b_qlora.yaml
python3 Tools/CoffeeAI/scripts/evaluate.py \
  --base-model mlx-community/Qwen3-4B-Instruct-2507-4bit \
  --adapter-path Tools/CoffeeAI/runs/adapters \
  --questions Tools/CoffeeAI/data/splits/test.jsonl --limit 10
```

训练完成后：`runs/<run_id>/run_manifest.json` 记录基础模型、来源、配置、数据版本、
日志与输出位置；评测报告（`runs/eval_*/eval_report.md`）供人工审核"是否真的更好"。

## 九、常见问题

**Q：示例样本为什么不直接拿来训练？**
它们是未经人工审核的草稿。工程质量约束（验收标准 3）要求未经审核数据不得默认进入
训练——脚本会直接拒绝，测试也覆盖了这一行为。请人工审核后再置 `approved`。

**Q：如何审核一条样本？**
核对四点：① 事实与可靠资料一致；② 口径符合 `knowledge/_method/METHODOLOGY.md` §4
（不写死"一定/必然"，给出适用范围）；③ 不复制任何来源正文；④ 回答示范了
"区分事实/经验/推断、证据不足时承认不确定"。通过后在 `notes` 里记审核人与日期，
`review_status` 改为 `approved`。

**Q：想改划分比例或随机种子？**
`split_dataset.py --seed 123 --train 0.7 --valid 0.15 --test 0.15`（比例和必须为 1）。

**Q：训练放在哪个目录、占多少磁盘？**
适配器输出 `Tools/CoffeeAI/runs/adapters`，日志 `runs/logs/`，manifest
`runs/<run_id>/`。模型本体在 HuggingFace 缓存（`~/.cache/huggingface`），训练期间
额外内存占用主要来自权重 + 激活，16GB 内存下保守配置可行。
