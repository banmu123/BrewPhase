# REVIEW_QUEUE — 待验证队列

> 规格 §73。规则：**没有来源的知识不进知识库，进这里。** 本文件是本项目「诚实边界」的清单。
>
> 优先级：
> - **P0** = Safety / Health / Dangerous Equipment
> - **P1** = Machine Operation / Core Coffee Science
> - **P2** = Brewing Advice
> - **P3** = Expert Opinions
> - **P4** = Community Tips
>
> 状态图例：`open`（未处理）｜ `blocked`（需付费/权限）｜ `partial`（部分完成）

---

## P0 — 安全 / 健康 / 危险设备

| # | claim / 缺口 | reason | conflictingSources | missingEvidence | suggestedSource | status |
|---|---|---|---|---|---|---|
| P0-1 | 各机型**错误代码（error codes）**的逐条含义 | 错误码可能与安全相关；猜测代价高 | — | 逐型号官方错误码表 | `philips-saeco-support`（各型号页）、`jura-product-support`、`delonghi-manuals`、`nespresso-faq` | open |
| P0-2 | 冷萃的**食品安全参数**（冷藏温度、储存时长、微生物风险） | 食品安全属 P0；研究入口已知但未取到阈值 | — | 具体温度/时长/微生物阈值 | `ucdavis-coffee-center`（food safety, especially cold brew）、FDA 相关材料 | open |
| P0-3 | 各机型**拆机类维护**的边界（哪些必须专业服务） | 触电/带压风险 | — | 各厂商保修与维修政策条款页 | 各厂商 official warranty/terms 页 | open |
| P0-4 | 摩卡壶**安全阀**与压力相关操作 | 带压设备安全 | — | 官方说明 | Bialetti 官方（未核验） | open |
| P0-5 | 「意式最佳水温」类表述的官方依据 | 现仅有机型默认值，缺标准/学术侧的可引用数字 | `conflict.espresso.brew-temperature-defaults` | SCA / 学术侧温度建议 | `sca-digital-store`（Coffee Brewing Handbook，付费）、`ucdavis-research-index` | blocked |

## P1 — 机器操作 / 核心咖啡科学

| # | claim / 缺口 | reason | conflictingSources | missingEvidence | suggestedSource | status |
|---|---|---|---|---|---|---|
| P1-1 | 逐厂商**除垢/清洁的完整步骤**（不止周期） | 已核验周期，未核验完整步骤 | `conflict.descaling.no-universal-cycle` | 各机型除垢分步（稀释、接触时间、冲洗次数） | 各厂商手册（Sage 已有 ~25s/13s/8s 分段；其余待补） | partial |
| P1-2 | 咖啡水**目标区间**（TDS / GH / KH / pH） | 风味与防垢的关键参数 | — | 具体区间 | `sca-digital-store`（2018 Water Quality Handbook，付费）、`barista-hustle`（The Water Course，订阅） | blocked |
| P1-3 | 萃取科学**机制与定量关系**（diffusion / 接触时间 / 温度） | 现有来源仅支持主题 | — | 定量关系 + 新版 Brewing Control Chart 内容 | `ucdavis-research-index`、`barista-hustle`（Advanced Coffee Making） | open |
| P1-4 | **烘焙**关键事件定义（一爆/二爆、charge temp、development ratio） | 规格 §07 要求，当前无来源 | — | 定义与典型区间 | `barista-hustle`（Roasting Science）、SCA-131（制定中） | open |
| P1-5 | **发酵**机制（pH/温度/时间/微生物） | 当前为 skeleton | — | 机制与阈值 | `cqi-php`、`ucdavis-coffee-center` | open |
| P1-6 | 绿咖啡**分级数值**（水分/密度/筛网/缺陷计数） | SCA-110 未发布 | — | 标准数值 | `sca-coffee-standards`（SCA-110）、`cqi-home` | blocked |
| P1-7 | 各机型**规格表**（锅炉容量、泵型、功率） | 设备知识完整性 | — | 逐型号 spec sheet | `lamarzocco-home-service`（已见 Spec Sheet 条目）、各厂商 | partial |
| P1-8 | Rancilio Silvia「泵压调整」的**具体值** | 手册有章节，未取正文数值 | — | 目标压力值 | `rancilio-silvia-manual` 正文 | open |

## P2 — 冲煮建议

| # | claim / 缺口 | reason | conflictingSources | missingEvidence | suggestedSource | status |
|---|---|---|---|---|---|---|
| P2-1 | 各**处理法**的定义与关键变量 | §04 要求逐条 | — | 逐处理法定义表 | `cqi-php` 公开材料 | open |
| P2-2 | French Press / Clever / Switch / Siphon 的**官方配方** | 器具覆盖缺口 | — | 逐器配方 | 各器具官方（Hario Siphon 已在配方卡出现） | partial |
| P2-3 | **器具覆盖率**：Origami / Orea / Tricolate / April / Kono / Melitta / Bee House / Chemex | §15 清单缺口 | — | 官方几何与配方 | 各品牌官方（未核验） | open |
| P2-4 | 滤杯**材料**（塑料/陶瓷/玻璃）对温度的影响 | §16 明确要求 | — | 对照数据 | 厂商 / 教育资料 | open |
| P2-5 | 磨豆机 **seasoning / alignment / RPM / 静电** | §10 清单缺口 | — | 定量影响 | `baratza-documents`、`comandante-official` 支持页 | open |
| P2-6 | WDT / puck screen / bottomless 的**实际效果** | §19 清单缺口 | — | 对照证据 | 厂商或教育资料 | open |
| P2-7 | 「酸/涩/苦/淡/浓/干/空洞」的**多因解释树** | §13/§40 明确要求，当前只有研磨一支 | — | 完整因果树 | `barista-hustle`（Advanced Coffee Making） | open |

## P3 — 专家观点

| # | claim / 缺口 | reason | conflictingSources | missingEvidence | suggestedSource | status |
|---|---|---|---|---|---|---|
| P3-1 | 「烘焙度决定酸苦」的**修正表述** | 需引用研究而非经验 | `conflict.espresso.brew-temperature-defaults` 类比 | 研究性表述 | `ucdavis-research-index` | partial |
| P3-2 | James Hoffmann 等署名专家的**其它配方** | 仅取到 1 条 V60 | — | 更多署名配方 | `hario-v60-hoffmann` 等官方站署名内容 | open |
| P3-3 | Barista Hustle 各课程的**可公开引用的结论** | 订阅制，只能取主题 | — | 公开摘要/免费课 | `barista-hustle`（免费试看部分） | blocked |

## P4 — 社区经验

| # | claim / 缺口 | reason | conflictingSources | missingEvidence | suggestedSource | status |
|---|---|---|---|---|---|---|
| P4-1 | 社区对**倒置法**的实践共识 | 与官方立场并列呈现 | `conflict.aeropress.inverted-method` | 需要可靠的一手社区来源 | `home-barista-forum`、`reddit-r-coffee`（均 pending-verification） | open |
| P4-2 | 各机型**常见故障的实际发生率/主因** | 仅官方列举，缺用户侧分布 | — | 用户数据 | BrewPhase 自己的用户数据（将来） | open |

## 品牌/型号待验证清单（与 §64 相关）

29 项设备品牌/型号挂起（Rocket、ECM、Profitec、Lelit、Nuova Simonelli、Victoria Arduino、Ascaso、Flair、Cafelat、Timemore、1Zpresso、Kalita 原厂、Chemex、Origami、Orea、Tricolate、April、Kono、Melitta、Bee House、Clever、Hario Switch/Mugen 型号级、Bialetti 摩卡壶、Gaggia 自动线、De'Longhi 具体型号、Philips 其它型号、Baratza Vario/Sette、Fellow Ode/Opus/Aiden/Stagg、Nespresso 机型手册）。见 `equipment/equipment.json` 的 `pendingEquipment`。

> 处理这些条目的前置动作是**同一个**：访问官方域 → 确认页面存在 → 确认许可 → 事实提取 → 独立改写 → 写入注册表。工具已就位：`Tools/knowledge/build_kb.py --check` 会在引用未注册/待验证来源时报错。
