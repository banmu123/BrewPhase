# Experiment C Preflight Report（阶段七-G-0，2026-10-15）

> 执行依据：GPT 阶段七-F-4 核验回复（gpt_reply_stage7f4_approved_7g0_prompt.md）
> ——「阶段七-F-4 通过；实验 C 可以继续推进，但先完成 G-0，不要立即启动训练」。
> 本阶段只处理配置可靠性与评测可比性：不训练、不下载模型、不改 approved 数据、
> 不改 source_exceptions.json、不改 train/valid/test 划分、不覆盖历史实验报告。

## 一、修改文件清单

| 文件 | 变更 | 对应 GPT 任务 |
|---|---|---|
| `Tools/CoffeeAI/scripts/run_train.py` | `_scalar()` 数组解析增强：以 `[` 开头的值一律视为数组声明——未闭合/非 JSON 时**明确报错**（带键名上下文），不静默降级为字符串 | G-0① |
| `Tools/CoffeeAI/tests/test_coffeeai.py` | 新增 `TrainConfigYamlTests`（7 用例）+ `EvalPromptConsistencyTests`（6 用例） | G-0①/④ |
| `Tools/CoffeeAI/training/lora_experiment_C_config.yaml` | **新增**：Experiment C 独立配置（不动 lora_dry_run_config.yaml / lora_experiment_B_config.yaml） | G-0② |
| `Tools/CoffeeAI/training/prepare_lora_dataset.py` | 仅改 docstring：「system 不进训练」的旧说法与实现不符（实现保留完整 messages 含 system），按实现修正说明 | G-0③ |
| `Tools/CoffeeAI/training/run_eval_generation_c.py` | **新增**：修复评测输入一致性的评测生成脚本（system-prompt + 显式 ChatML + greedy 显式化 + N5 v2 题面） | G-0④ |
| `Tools/CoffeeAI/training/experiment_C_eval_set.md` | **新增**：Experiment C 评测方案冻结（对照策略/能力覆盖/事实错误专项） | G-0④ |
| `Tools/CoffeeAI/training/evaluation/natural_behavior_eval.md` | 末尾**追加** G-0 追记（N5 题面修正说明），历史表格逐字未动 | G-0④ |
| `Tools/CoffeeAI/review_queue/gpt_replies/gpt_reply_stage7f4_approved_7g0_prompt.md` | **新增**：GPT 回复存档 | 治理 |

## 二、G-0① YAML 数组解析——修复、测试与事实核查

### 事实核查（GPT 要求「如发现 main 与阶段七-D 报告不一致，明确记录」）

- **main 现状与 GPT 静态核验的描述不一致（向 GPT 明确记录）**：GPT 称「_scalar()
  没有明确解析以 [ 开头的数组」，但远程 main 的 `_scalar()` 自阶段七-D（提交
  887ed5c，2026-10-15）起已含 flow 数组分支（`json.loads`）。GPT 读到的可能是
  旧版本缓存。
- **但 GPT 要求的两点此前确实缺失，已按裁定补齐**：
  1. **无任何单元测试**证明「解析→写回→再解析」后 keys 仍是 list（测试覆盖为零）；
  2. **存在静默降级路径**：`keys: ["a", "b"`（缺右括号）会落回字符串分支静默降级；
     `[a, b]`（合法 YAML flow 但非 JSON）裸抛无上下文的 JSONDecodeError。
- **历史证据（runs 产物，未改动）**：`runs/train_20261015_010930/`（阶段七-D 修复
  前的失败运行，无 run_manifest.json）的 effective_config.yaml 里
  `lora_parameters.keys` 是**字符串**——即本缺陷真实发生过一次；实验 A
  （train_20261015_011345，iters=20，exit 0）与实验 B（train_20261015_012812，
  iters=200/lr=2e-5，exit 0）的 manifest 中 keys 均为 **list**——
  **实验 A/B 未受该缺陷影响**（回答 GPT「并不代表已确认实验 B 使用了错误配置」的悬置）。

### 修复内容

- 未闭合数组（`[` 开头无 `]` 结尾）→ `ValueError`（提示写 JSON 风格单行数组）；
- 非 JSON 数组（如 `[a, b]`）→ `ValueError`（带键名上下文 + 修正示例）；
- 块数组（`- 项` 列表）不在支持范围 → 保持显式失败（ValueError），测试锁定无静默路径；
- 解析处传入键名，报错信息可定位到具体键。

### 测试（TrainConfigYamlTests，7 用例全过）

- `test_flow_array_parses_as_list`：真实 lora_dry_run_config.yaml →
  **keys == ["self_attn.q_proj", "self_attn.v_proj"]**（GPT 验收硬性要求）✓
- `test_roundtrip_preserves_all_types`：解析 → dump_yaml → 再解析，全字段相等 ✓
- `test_effective_config_write_keeps_keys_list`：write_effective_config 真实写回
  路径后 keys 仍为 list（正是 010930 失败运行暴露的链路）✓
- 未闭合数组报错 / 非 JSON 数组报错（含键名）/ 块数组显式失败 / 标量行为回归 ✓

## 三、G-0② Experiment C 独立配置

`lora_experiment_C_config.yaml`（与实验 B 仅 iters/lr/adapter_path 不同，其余逐字段
一致以保证可比）：

| 参数 | 值 | 备注 |
|---|---|---|
| model | mlx-community/Qwen2.5-3B-Instruct-4bit | hf-cache 已缓存（3.26GB，阶段七-D 下载） |
| fine_tune_type | lora | 4bit → QLoRA（官方 LORA.md） |
| iters / learning_rate | **100 / 1e-5** | GPT 冻结 |
| batch_size / num_layers | 1 / 8 | 同实验 B |
| lora rank / scale / dropout / keys | 8 / 10.0 / 0.0 / [q_proj, v_proj] | 同实验 B，GPT 未要求改动 |
| max_seq_length | 2048 | 沿用已验证值 |
| data | Tools/CoffeeAI/training/data/lora | 35 条转换产物 |
| adapter_path | Tools/CoffeeAI/runs/lora_experiment_C_adapter | 新目录 |

未改动 lora_dry_run_config.yaml（实验 A 历史）与 lora_experiment_B_config.yaml。

## 四、G-0③ 数据转换文档一致性

- docstring 修正：实现**保留完整 messages（含 system）**（审核指纹绑定 + 行为对齐
  核心），旧文档「system 不进训练」与实现不符——只改文档，未删 system、未重算
  指纹、未动 approved 语料。
- 重跑验证：**35 条（train 28 / valid 4 / test 3）**；全部 35 个 approved 样本覆盖；
  **interaction_skill 映射零不一致**（21 条有值样本 6 类分布：uncertainty_handling 8、
  boundary_setting 4、condition_based_advice 3、knowledge_explanation 2、
  clarification 2、multi_variable_reasoning 2；14 条 b1/b2a 早期样本 meta 无标记，
  转换器输出空串属正确映射语义）。

## 五、G-0④ 评测一致性修复与冻结（GPT 预判命中）

**旧脚本（实验 A/B 用）两处与训练分布不一致**：未传 system-prompt（训练数据 35 条
全部带统一 system）+ 依赖 mlx_lm.generate 隐式 chat template（不可控不可测）；
且 N5 题面「推荐一个 V60 参数」缺手冲语境（实验 B 中 base 答华为耳机、adapterB 答
60Ah 电池，双双跑题）。

修复（run_eval_generation_c.py + experiment_C_eval_set.md）：

1. **system-prompt 一致**：base 与 adapter 传入与训练数据逐字一致的 system
   （测试断言 35 条样本 system 统一且等于常量）；
2. **chat-template 显式**：build_chat_prompt() 构造 Qwen ChatML +
   `--ignore-chat-template`；**tokenizer.apply_chat_template 交叉校验实测 True**
   （与 Qwen2.5-3B-Instruct-4bit 内置模板逐字一致）；结构由单元测试锁定；
3. **推理参数冻结**：greedy（--temp 0 显式）、max_tokens=350、单次生成；
4. **N5 v2**：「手冲咖啡用 Hario V60 滤杯，参数上有什么推荐？」——自然度其余 9 题
   与治理 10 题逐字冻结（测试对比文档）；**N5 新旧题面结果不作严格分数对比**；
5. **对照策略**：严格对比 = 重跑 base（对齐输入）vs adapterC；实验 A/B 的 /tmp
   产物（50 份，仍在）保留不动，仅作趋势参考并注明输入策略差异；
6. **事实错误专项**：gov q8（茉莉花香）与 nat N4（健康/帕金森）保留在集，
   Experiment C 报告须专项核对两项事实错误消失。

## 六、G-0⑤ 只读验证结果（GPT 指定 5 条命令）

| 命令 | 结果 |
|---|---|
| `python3 Tools/CoffeeAI/tests/test_coffeeai.py` | **143 tests OK**（130 + 新增 13），22.6s |
| `python3 Tools/knowledge/build_kb.py --check` | 通过（no file written） |
| `python3 Tools/CoffeeAI/training/prepare_lora_dataset.py` | 35 条（28/4/3），skill 映射零不一致 |
| `python3 Tools/CoffeeAI/training/check_training_leakage.py` | **leakage=0**（train=28/valid=4/test=3） |
| `run_train.py --dry-run --config …/lora_experiment_C_config.yaml --deployment-purpose noncommercial-research` | **Preflight 通过**：模型 hf-cache（3.26GB）、数据 28/4/3、参数 iters=100/lr=1e-5/batch=1/layers=8；**无训练、无下载、无写盘**（dry-run 落在 runs/ 目录之外，未新增运行目录） |

接口说明（GPT 要求核对实际接口）：GPT 命令样例与实际接口一致，全部原样执行；
run_train.py 的 adapter 参数在评测脚本中写全为 `--adapter-path`（旧脚本用 `--adapter`
是 argparse 前缀缩写，新脚本显式写全）。

## 七、验收结论

- [x] YAML 数组解析正确（keys 必为 list，往返一致，非法值明确报错）
- [x] 35 条数据映射完整（28/4/3，skill 全部就位）
- [x] leakage=0
- [x] 训练准入无错误（dry-run Preflight 通过）
- [x] dry-run 不训练、不下载模型
- [x] 全部测试通过（143 OK）
- [x] 评测输入与训练分布一致（system + ChatML + tokenizer 交叉校验 True）

**G-0 全部硬性检查通过——满足启动 Experiment C 的全部条件。**
按 GPT 裁定停止于此，等待负责人确认后执行实验 C（run_train.py --train 入口、
不加 --allow-download、模型已在本地缓存）。
