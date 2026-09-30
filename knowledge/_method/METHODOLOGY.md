# METHODOLOGY — 采集、验证、改写、归档的固定流程

> 对应规格 §62（Web Research 工作流）、§66（Source Priority）、§67（建议 ≠ 科学事实）、§68（每条知识带范围）、§75（数据原则）。

## 1. 采集工作流（每一步都不许跳过）

```
1  找到候选来源        WebSearch，保留原始 URL
2  检查页面是否真实存在 WebFetch 打开；打不开 → status 降级或 pending
3  检查是否官方域名     品牌域/机构域，且非第三方聚合站
4  确认发布/更新时间    页面有则记，没有则 null（不猜）
5  确认适用范围         型号 / 代际 / 烘焙 / 配方 / 实验设计
6  提取事实             只取事实点，不取营销辞令
7  检查冲突来源         有分歧 → 建 Conflict Record，不选边
8  记录 license         来源没写 → unknown，不默认可复制
9  独立改写             用自己的话，不复制段落
10 生成 Knowledge Document（§55 chunk 结构）
11 写入 Source Registry
12 标记需人工复核项     → REVIEW_QUEUE.md
```

## 2. 来源优先级（§66）

**设备问题（「我的机器怎么操作/清洁/报错」）**

```
该型号官方手册
  > 该品牌官方支持页
  > 同产品线其它型号（仅作参考，须降级）
  > SCA/CQI 等行业标准（不解决机型问题）
  > 第三方教程
  > 社区
```

**科学问题（「为什么水温会影响萃取」）**

```
学术 / SCA / CQI / WCR / 政府机构
  > 专业教育机构
  > 博主 / 博客
  > 社区
```

**冲煮技巧**

```
官方 recipe
  + 专业教育
  + 实操指南
（三者并列，带 author/equipment/context）
```

**用户历史问题**

```
用户自己的数据优先
```

## 3. 权威等级 → 证据类型映射

| authorityTier | 典型 evidenceType |
|---|---|
| 1 | standard / academic / research |
| 2 | manufacturer |
| 3 | expert_education / professional_practice |
| 4 | community / anecdotal |

`evidenceType` 与 `authorityTier` **不得互相冒名**：把博客当 academic 是本知识库明令禁止的行为。

## 4. 「建议」与「事实」的写法红线（§67）

| 禁止 | 允许 |
|---|---|
| 92°C 就是最佳温度 | 92°C 是某些配方中常见的起点之一；适用温度受豆子、烘焙度、研磨、设备与目标风味影响 |
| 浅烘一定酸、深烘一定苦 | 烘焙度与酸苦的相关性受产地、处理法、烘焙曲线、冲煮方式共同影响（§07） |
| 某处理法必然产生某风味 | 某处理法在某些区域/参数下**常常**与某类感官描述相关联 |
| Ethiopia = floral | 埃塞俄比亚部分产区/品种/处理法**常见**花香描述，非必然 |

**例外（可以写确定的场景）：** 当**设备厂商官方明确规定**某数值时，可以写「该型号默认设置为 X」——这是有来源的机型事实，不是普适科学结论。

## 5. 每条知识必须自带的「范围」（§68）

```yaml
claim:       # 事实
context:     # 在什么条件下
appliesTo:   # 适用于
doesNotApplyTo: # 不适用于
exceptions:  # 例外
source:      # 来源
```

缺 `appliesTo` / `doesNotApplyTo` 的条目，一律标 `confidence: low` 并进 REVIEW_QUEUE。

## 6. 文档状态标记

本知识库每个 `.md` 顶部有一行状态：

| 状态 | 含义 |
|---|---|
| `status: filled` | 核心事实均有已核验来源支撑 |
| `status: partial` | 部分事实有来源，部分留空待补 |
| `status: skeleton` | 只确立主题骨架与所需来源，**不含未经核验的数字** |

`status: skeleton` 不是失败——它是诚实：规格 §77 明确禁止编造数据。

## 7. 未来检索对齐（§59/§60）

检索链：`Query → Intent → Entity → Metadata Filter → Semantic Retrieval → Authority Ranking → Applicability Ranking → Evidence`。

因此每条 claim/document 的 `applicability` 与 `sourceIds` 是**一等字段**，不是备注。这样「我的 Breville Barista Express 怎么除垢」才能优先命中 `specific_model`，而不是 `generic espresso machine`。

## 8. 更新周期（§61）

| 领域 | 频率 | 机制 |
|---|---|---|
| 咖啡植物学 / 品种 | 低 | 跟随 WCR catalog 版本（当前 2025-09-04） |
| 冲煮科学 | 中 | 跟随 UC Davis / SCA 新发表 |
| 设备手册 | 高（重要性高） | 逐型号核验，记 `lastChecked` |
| 产品型号 | 高 | 品牌页变动即更新 |
| 健康信息 | 高 | 跟随 FDA / EFSA 更新 |

所有条目保存 `lastVerified`；本轮为 **2026-09-30**。
