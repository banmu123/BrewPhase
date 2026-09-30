# BrewPhase Coffee Knowledge Base

> 结构化、可追溯、可更新、适合本地语义检索的咖啡知识库。
> 建立日期 **2026-09-30** ｜ 编制方式：来源核验 → 事实提取 → 独立改写 → 结构化归档。

## 这是什么

不是「一堆文章」，而是一条流水线：

```text
权威来源
  ↓  WebSearch 定位 + WebFetch 核验（步骤见 _method/METHODOLOGY.md）
事实提取
  ↓
来源验证（真实存在？官方域？许可？）
  ↓
结构化知识
  ↓
知识实体 / 事实 / 方法 / 参数 / 故障
  ↓
可检索文档（_build/documents.json，§55 chunk 结构）
  ↓
Embedding（Phase 10，仅准备，未执行）
  ↓
BrewPhase Knowledge Base
```

**每个重要知识点都知道它从哪里来。** 每条都带 `sourceId` → `SOURCE_REGISTRY.json`。

## 目录导航

| 路径 | 内容 |
|---|---|
| `SOURCE_REGISTRY.json` / `.md` | **来源注册表**（51 条，含许可与状态） |
| `CONFLICTS.md` | **来源冲突登记**（7 条，不抹平冲突） |
| `REVIEW_QUEUE.md` | **待验证队列**（P0–P4） |
| `STATS.md` | 规模统计 |
| `REPORT.md` | 最终交付报告 |
| `_schema/` | 7 份 JSON Schema |
| `_method/METHODOLOGY.md` | 采集/验证/改写/引用的固定流程 |
| `_build/documents.json` | Embedding 准备的富文档集（双语） |
| `_build/knowledge_base.v2.json` | 编译产物（App 格式，**尚未接入**） |
| `fundamentals/ … terminology/` | 各领域知识文档 |
| `terminology/terminology.json` | 47 条三语术语 |
| `recipes/recipes.json` | 14 条带来源的配方 |
| `equipment/equipment.json` | 21 个已核验型号 + 29 个挂起项 |
| `troubleshooting/troubleshooting.json` | 20 条结构化故障规则 |

## 两条铁律

1. **没有来源，不写事实。** 没核验到的东西进 `REVIEW_QUEUE.md`，不编数字。
2. **不抹平冲突。** 来源不一致时建 Conflict Record，说明各自适用范围。

推论：`status: skeleton` 的文档（fermentation / extraction-science / brew-methods-moka）**是刻意的诚实**，不是半成品——它们只确立主题骨架与所需来源，不含未经核验的数字。

## 许可纪律（最容易被忽略的部分）

| 来源 | 许可 | 允许 / 禁止 |
|---|---|---|
| WCR 品种目录 | CC BY-NC-ND 4.0 | 可分享；**禁改编、禁商用** |
| SCA Flavor Wheel | CC BY-NC-ND 4.0 | 可展示；**禁改编、禁商用**（不得把原始数字文件改造成产品资产） |
| SCA Handbooks（Water/Freshness/Brewing/…） | 付费 | 只记书目，**不复制正文** |
| Barista Hustle 课程 | 订阅制 | 只取主题骨架 |
| 各厂商手册 | 免费下载但版权归厂商 | 事实提取 + 独立改写 + 标型号 |
| 许可未知的来源 | unknown | **不默认可复制** |

## 与 BrewPhase 代码的对接

现有 RAG 管线（`BrewPhase/RAG/`）消费 `BrewPhase/Resources/knowledge_base.json`，格式为：

```json
{ "revision": 1, "provenance": {...},
  "documents": [ { "id", "category", "source", "title": {"zh-Hans","en"},
                   "content": {"zh-Hans","en"} } ] }
```

解析器 `RAG/Indexing/KnowledgeBase.swift` **忽略额外字段**，所以编译产物可以携带富元数据而不破坏现有代码：

```bash
# 校验 + 编译（不覆盖 app 资源）
python Tools/knowledge/build_kb.py

# 只校验
python Tools/knowledge/build_kb.py --check
```

编译会**强制**校验：每个文档引用的 `sourceId` 必须已注册，且**不得**引用 `pending-verification` 来源。这是把「不许编造来源」变成机器可执行的检查。

产物写到 `_build/knowledge_base.v2.json`；**是否替换 app 资源是一个显式的产品决策**（见 `REPORT.md` 的「下一步」）。

## 检索对齐（规格 §59/§60/§61）

```text
Query → Intent → Entity → Metadata Filter → Semantic Retrieval
      → Authority Ranking → Applicability Ranking → Evidence
```

因此每条知识都带 `applicability`（generic / espresso / pour_over / specific_brand / **specific_model** / …）。这样：

- 「我的 Breville Barista Express 怎么除垢？」→ 命中 `specific_model`
- 「为什么水温会影响萃取？」→ 命中 `academic/standard` 而非 `manufacturer`

## 更新

- 每条的 `lastVerified` 当前为 **2026-09-30**。
- 不同领域更新频率不同（设备/健康高，植物学低），见 `_method/METHODOLOGY.md` §8。
- 新增来源 → 先写 `SOURCE_REGISTRY.json` → 再写文档 → 跑 `--check`。
