# BrewPhase Design System v1

**Quiet Coffee Atelier** — A personal space for making, collecting and creating.

BrewPhase 不是一款咖啡管理工具，而是一间属于用户自己的安静、专业、有创造力的
咖啡工作室。这份文档定义 v1 的视觉语言，是 Coffee 首页改版与后续 Records /
Canvas 重设计的唯一权威来源。

代码中的权威实现：`BrewPhase/Shared/Theme.swift`（`Palette` / `TypeScale` /
`Metric` / `Motion` 四个枚举）。本文档与代码同步维护；改 Token 先改代码再改文档。

---

## 1. 设计性格

| 关键词 | 含义 | 在界面上的体现 |
|---|---|---|
| Quiet | 安静、克制 | 大面积中性灰底，色彩只出现在状态与唯一主操作上 |
| Atelier | 私人工作室 | 内容像摆在工作台上的档案，而不是仪表盘上的卡片 |
| Editorial | 编辑式排版 | 衬线品牌字、小号 overline、细分隔线、不对称留白 |
| Precision | 精确专业 | 参数、天数、克数一律等宽数字 |
| Personal | 以用户为中心 | 用户自己的照片与文字是主角，系统不制造内容 |

**禁止清单**（评审时逐条对照）：

- SaaS Dashboard 式布局；首页顶部堆叠统计数字。
- 所有内容套同规格白色卡片；每个功能做成带图标的快捷入口。
- 大面积暖白 / 米黄背景；所有按钮棕色填充。
- 过量阴影与渐变；无意义的装饰图标与动效。
- 为了「高级感」牺牲可读性。

---

## 2. 色彩

六种中性色构成空间，五种咖啡色与四种阶段色只做小剂量点缀。
**色彩保留给状态，永远不做装饰。**

### Space（中性）

| Token | Hex | 用途 |
|---|---|---|
| `paper` | #F7F7F7 | 页面背景（Studio Background） |
| `card` | #FFFFFF | 内容表面（Surface） |
| `well` / `wellDeep` | #F0F0F0 / #E6E6E6 | 次级区域、凹面、轨道（Recessed） |
| `hairline` | #E3E3E3 | 唯一的细分隔线（0.7pt） |
| `ink` / `inkSoft` / `inkFaint` | #2A211A / #6F6A64 / #9E9A94 | 三级文字 |

### Coffee（品牌，小剂量）

| Token | Hex | 用途 |
|---|---|---|
| `espresso` | #3B2A1E | 唯一的实心主按钮、加号按钮；深色文字强调 |
| `roast` | #8A5A34 | 链接、次级强调 |
| `latte` | #C9A27A | 品牌细节：库存条、占位图标、空状态图形 |
| `cream` | #EFE3D2 | 少量柔和选中态（Tab Bar 选中胶囊） |
| `moss` | #6E8A5F | 自然状态 / 峰值阶段 |

### Phase（阶段语义，不可挪用）

`resting` #9A8E80 · `opening` #C08A45 · `peak` #6E8A5F · `declining` #B4705A ·
`priority` #A8503F。只出现在：状态点、阶段轨道分段、状态文字。

规则：不做大面积暖白；Latte 不做控件默认色；文字对比度按 WCAG AA 检查
（ink 系列在 paper/card 上均 ≥ 7:1，inkFaint 仅用于辅助信息）。

---

## 3. 字体

三个角色，一个系统字族。重量表达层级，不用字号堆砌「高级感」。

### Display / Serif（品牌氛围）

- **`brandMark`** — 12pt serif medium：`BREWPHASE / STUDIO` 这类品牌 overline，
  使用时加 `tracking(2.4)`，可配 italic。
- **`signature`** — 12.5pt serif light：结果页的落款、短仪式性文字。
- 只用于拉丁字符的品牌与氛围文字；中文标题一律回到 Sans。

### Interface / Sans（界面）

`display 30` · `beanName 26` · `greeting 27` · `cardTitle 21` · `title 17` ·
`body 15` · `bodyMedium 15 medium` · `callout 13.5` · `caption 12` ·
`micro 11 medium` · `section 11.5 semibold`（SectionLabel 专用，配合 tracking 1.1）·
`emphasis 23 semibold`。

### Data / Monospaced（参数与数字）

- **`numeral`** — 15pt medium monospacedDigit：行内参数。
- **`bigNumeral`** — 24pt semibold monospacedDigit：大数字。
- **`dataSmall`** — 12pt monospacedDigit：天数（Day 16）、日期、指示器 `01 / 06`。

规则：凡是会变化的数字（天数、克数、日期、计数）必须用等宽角色；
`monospacedDigit` 之外不要手工对齐。

---

## 4. 空间与布局

4pt 基准。`Metric` 中的权威值：

| Token | 值 | 用途 |
|---|---|---|
| `spaceXXS / XS / SM` | 4 / 8 / 12 | 元素内间距、图标与文字 |
| `spaceMD / LG` | 16 / 20 | 行间距、卡片内分组 |
| `spaceXL / XXL` | 24 / 32 | 区块间距 |
| `spaceXXXL / XXXXL` | 40 / 48 | 重点展示区上下的呼吸空间 |
| `gutter` | 22 | 页面左右留白 |
| `sectionGap` | 28 | 一级区块之间 |

允许不对称：页头 overline 与标题左对齐，操作按钮绝对右对齐；卡片内部
图片全宽、文字缩进，形成一条清晰的左缘线。

---

## 5. 表面、圆角与层次

三层表面：**Page（paper）→ Surface（card）→ Recessed（well）**。

| Token | 值 | 用途 |
|---|---|---|
| `radiusSmall` | 10 | 小控件：芯片、缩略图、输入框 |
| `radius` | 16 | 普通卡片 |
| `radiusLarge` | 20 | 大型展示区：聚焦豆卡、全屏面板 |

- 边框统一 0.7–0.8pt `hairline`。
- 默认无阴影；**全 App 只允许一处抬升**：首页聚焦豆卡（`liftedShadow` 8%·18）。
- 禁止粗边框 + 强阴影 + 渐变同时出现。

---

## 6. 材质隐喻

三种材质只体现在细节，不做全局纹理：

- **Metal**（精密 / 器具）：冷灰阶、细线、`dataSmall` 等宽数字、轨道与标记。
- **Paper**（笔记 / 记录）：排版、行距、留白、`Hairline` 分隔。
- **Ceramic**（咖啡 / 温度）：`latte` 占位图形、`cream` 选中态、用户照片本身。

禁止：卡片贴纹理图、滥用毛玻璃、大面积内阴影、金属渐变背景。

---

## 7. 动效

全部原生 SwiftUI，统一出自 `Motion`：

| Token | 值 | 用途 |
|---|---|---|
| `quick` | 180ms easeOut | 按压反馈、小状态切换 |
| `standard` | 240ms spring | 控件出现 / 消失 |
| `pop` | 300ms spring(0.70) | 芯片、点标填充 |
| `swipe` | 340ms spring | BeanStack 翻卡 |
| `settle` | 420ms spring(0.86) | sheet、展开、折叠 |
| `glide` | 500ms spring(0.90) | 列表重排、轨道标记 |

规则：动效必须有交互目的；状态没变就不动；BeanStack 的连续手势动画
（`BeanDeck` 数学）是品牌资产，禁止重写。全部动效尊重 Reduce Motion
（系统级缩放，不自建开关）。

---

## 8. 组件规范（v1 已固化）

- **Card**：白面 + 0.7pt 发丝线，默认无阴影；`lifted` 仅限聚焦豆卡。
- **SectionLabel / SectionHeader**：小节标题唯一出处（11.5pt semibold + tracking）。
- **Hairline / CardDivider**：0.7pt；CardDivider 可缩进对齐文字左缘。
- **PrimaryButton**：整屏唯一 espresso 实心块；SecondaryButton：well 胶囊；
  文字级次级操作用 roast 色文本 + 图标。
- **CapsuleTabBar**：白胶囊 + 0.8pt 边 + 14pt 轻阴影；选中 cream 0.55 + espresso；
  未选中 inkFaint；点击区域 ≥ 44pt；通过布局参与安全区，不遮内容。
- **PhaseTrack**：真实天数等比分段 + 「今天」标记 + 图例；阶段色只上轨道与
  状态点；禁止做成经验条。
- **BeanStack / BeanDeck**：连续手势数学是品牌资产，只允许改视觉层
  （`FocusedBeanCard`），禁止改 `BeanDeck` 的算术。
- **EmptyStateView**：一个图形 + 一句标题 + 一句引导 + 至多一个主按钮；
  文案像工作室主人的口吻，禁止营销腔与假数据。

---

## 9. 无障碍与国际化

- 全部文案走 `L()` / `strings.py` 双语表（`generate.py` / `check.py` 把关）。
- 尊重 Dynamic Type（使用语义字体 Token，不写死 CGFloat 文本）。
- VoiceOver：装饰图 `accessibilityHidden`，控件有中文标签，选中态带
  `.isSelected`。
- 触摸区域 ≥ 44×44pt。

---

## 10. 验收基准（每次改版对照）

1. 是否一眼看出「今天最该喝的那包豆」？
2. 信息是否克制但足够专业（参数等宽、状态有色、其余安静）？
3. 用户能否不经思考完成主操作（开始冲煮 / 记一杯）？
4. 页面是否区别于通用 SaaS（留白、衬线 overline、非对称层次）？
5. Coffee 首页能否作为 Records / Canvas 未来重设计的视觉标杆？
