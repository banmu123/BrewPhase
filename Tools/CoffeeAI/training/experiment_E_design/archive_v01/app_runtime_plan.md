# Experiment E 交付物⑦：目标 App 运行方案

> 依据：负责人决策修订（端侧优先）+ GPT Q4（先评测达标再集成）+ Q1/E-7a（fail-closed
> + 方案②编排）。v0.1 草案——**仅在 Product Eval v1 全门线通过后启动执行**。

## 一、端侧约束

| 项 | 约束 | 依据 |
|---|---|---|
| 运行时 | MLX（Apple silicon），模型随 App 分发或按需下载（分发方式待许可证核验结论） | Q2 许可证前置 |
| 内存 | 3B-4bit ≈ 2GB / 4B-4bit ≈ 2.5GB / 7B-4bit ≈ 4.5GB 量级——**7B 候选必须真机内存+延迟实测**，低端机型直接排除 | Q2 |
| 延迟 | 两段式（决策+正文）端到端 P50/P95 实测；决策 JSON 生成应显著快于正文（短输出） | Q4 含延迟维度 |
| 电量/发热 | 批量评测时记录；回归到 C/D 时代的设备性能测试清单 | 既有惯例 |

## 二、集成架构（E-7a 方案②的产品落点）

```
用户输入 → ConversationState（既有对话状态机制）
  → [决策调用] MLX 生成决策 JSON
  → DecisionParser（新）：语法→schema→注册表→applicable_methods 四步校验
     ├─ 通过+clarify → UI 呈现注册表渲染的标准问题 → 等待用户补充（记录 pending_variable_id）
     ├─ 通过+answer  → [回答调用] 组装历史+补充+RAG 上下文 → 正文（F/P/I 渲染沿用 DocumentBuilder）
     └─ 任一失败     → fail-closed：现行直答 RAG 流程 + OSLog 异常记录（App 不崩不空白）
```

- 新增组件：`DecisionParser`、`DecisionVariableRegistry`（①的定义）、决策 JSON 的
  OSLog 埋点；`IntelligenceConfig` 仅增 `clarifyEnabled` 开关。
- UI：追问以单问题+可选快捷输入呈现（如研磨度档位 chip）；**不自动展开多问**。

## 三、交付验收序列（Q4：评测达标才集成）

1. Product Eval v1 全门线通过（E2 产物）
2. adapter 导出与量化：MLX-LM fuse/quantize → 端侧格式；与训练侧逐位校验（同输入同输出）
3. 真机测试：内存/延迟/电量 + 全部 12 变量的追问路径 + fail-closed 路径（人为喂坏 JSON）
4. 本地化：决策相关 UI 文案走 L() 管线（generate.py + check.py，815 键口径更新）
5. 发布边界：训练线冻结状态下不上架新模型——**每次端侧模型更新需 GPT 确认 + 负责人拍板**

## 四、回退与灰度

- `clarifyEnabled` 远程可关：模型行为异常时产品可整体退回一问一答（fail-closed 的产品级开关）。
- 版本并行：新模型卡（版本号、训练配置摘要、评测结果摘要、已知边界）随发布归档——模型卡是 Q4「资产化」要求的载体。
