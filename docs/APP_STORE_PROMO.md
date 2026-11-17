# App Store 推广文案（iOS 2.0）

按 App Store Connect 的字段拆好，直接复制粘贴。每段后面标了实测字数与上限。

对应版本：`main` 的 iOS 工程，MARKETING_VERSION = **2.0**，bundle `com.brewphase.ios`，
iOS 18.0+，仅 iPhone。文案只写证得出的东西——三个空间、库存台账、本机存储、无账号；
不写云同步、不写 AI 自动整理（都没做）。

App Review 的说明（怎么打开示例数据、为什么不需要账号）在
[`APP_STORE_REVIEW.md`](./APP_STORE_REVIEW.md)，那份是给审核员看的，不是推广。

---

## 1. 推广文本 Promotional Text

> **上限 170 字符。** 显示在描述最上方。**改了不需要重新提审**，所以这里适合放
> 临时活动、新版本一句话、季节性的话。三个中文版本可以轮着用。

### 中文 A｜时间感（95 字符）

```
咖啡豆有自己的时间：刚烘好要等几天，最好喝的窗口也就那几天。BrewPhase 把豆子、冲煮和日常记录放进三个空间——咖啡、记录、画布。全部存在这台 iPhone 上，没有账号，断网也能记。
```

### 中文 B｜记录完整（74 字符）

```
一包豆从养豆到喝完，值得完整记一遍。咖啡管豆与冲煮，记录收链接、图片、视频和文字，画布把它们摆到一起，看出只翻列表看不出的东西。本地优先，没有账号。
```

### 中文 C｜不只记参数（74 字符）

```
不只记参数，也记当时想到什么。三个空间各管一件事：咖啡记豆与冲煮，记录收你收集的东西，画布把它们摊开重排。数据留在这台 iPhone 上，没有账号。
```

### English A（153 字符）

```
Coffee has its own clock: rest a few days, then a short window at its best. BrewPhase keeps bags, brews and notes in three spaces. On-device. No account.
```

### English B（153 字符）

```
A bag worth recording: rest, window, last cup. Coffee tracks bags and brews, Records keeps links and images, Canvas lays it out. Local-first, no account.
```

---

## 2. 副标题 Subtitle

> **上限 30 字符。** 和名称一起出现在搜索结果的第二行，权重仅次于名称。

中文（11 字符）：

```
本地优先的咖啡与记录本
```

English（24 字符）：

```
Coffee notes, kept local
```

备选：

- 中文：`豆子、冲煮与画布`（8）
- 中文：`自己的咖啡记录，不联网`（11）
- English：`Coffee, records, canvas`（23）

---

## 3. 关键词 Keywords

> **上限 100 字符**，逗号分隔，**不要空格**（空格也算字符）。不要重复品牌名，不要堆竞品名。

中文（38 字符）：

```
咖啡,手冲,咖啡豆,冲煮,风味,品鉴,咖啡日记,记录,笔记,画布,离线,本地
```

English（96 字符）：

```
coffee,pourover,espresso,coffeebeans,brewing,flavor,coffeelog,journal,notes,canvas,offline,local
```

留给下一版的候选词（换掉低效词时用）：`养豆,烘焙日期,粉水比,库存,标签,收藏`

---

## 4. 描述 Description

> **上限 4000 字符。** 改了要重新提审。

### 中文（728 字符）

```
BrewPhase 是一本本地优先的咖啡记录本。它不要求你注册，也不把你的数据放到别人的服务器上——打开就能记，断网也能记。

2.0 把内容分成三个空间，各管一件事。

咖啡
记下每一包豆：烘焙商、产地、处理法、烘焙度、烘焙与开封日期、剩余克数。库存是台账，按每次冲煮实际用掉的克数扣减，不是估个大概。
烘焙日期会推导出养豆期、最好喝的窗口和之后的衰退期。这些规则可以自己改，也可以在你定义的好窗口里提醒你——它们是冲煮建议，不是保质期。
冲煮可以记手法、粉量、水量、水温、时间、研磨、粉水比、评分和笔记。30 秒快速记录留给不想填表的时候。

记录
四种载体：链接、图片、视频、文字。导入的图片和视频存在本机。
多对多标签与全文搜索，也能按载体和标签筛选。GitHub、YouTube、B 站、X 和普通网页各有自己的卡片样式；抓不到元数据就如实留空，不编造。

画布
一块可以平移缩放的无限画布。把记录摆上去，拖动、选中、写备注。
节点保存的是世界坐标，缩放不会改掉你的布局。同一条记录可以同时出现在几块画布上——节点是一次摆放，不是副本。

关于数据
所有内容存在这台 iPhone 上，没有账号，没有云端数据库，也没有我们运营的同步服务器。
可以导出 JSON / CSV，也可以做含图片的完整备份并整机恢复，备份带完整性校验。
没有遥测。

关于「问一问」
它在你自己的记录和内置的咖啡知识库里检索，回答在本机生成，不需要联网，也不需要任何密钥。

需要说明的是：本地优先不等于完全不联网。添加链接记录时会访问目标网站抓标题和封面；这一步可以不做，其他功能不受影响。

BrewPhase 不做的事：账号与云同步、社交信息流、替你自动整理数据。
```

### English（2010 字符）

```
BrewPhase is a local-first coffee notebook. No sign-up, no account, no server of ours holding your data. Open it and start writing. It works offline.

Version 2.0 splits content into three spaces, each answering a different question.

COFFEE
Log every bag: roaster, origin, process, roast level, roast and open dates, grams left. Stock is a ledger — each brew deducts the grams it actually used, not an estimate.
The roast date drives a resting period, a best-drinking window and the decline after it. Those rules are editable, and you can be reminded when a bag enters the window you defined. They are brewing suggestions, not expiry dates.
Brews record method, dose, water, temperature, time, grind, ratio, score and notes. A 30-second quick log exists for the days you don't want a form.

RECORDS
Four carriers: link, image, video, text. Imported media stays on the device.
Many-to-many tags, full-text search, and filtering by carrier or tag. GitHub, YouTube, Bilibili, X and plain web pages each get their own card; when metadata can't be fetched the card says so instead of inventing it.

CANVAS
An infinite canvas you can pan and zoom. Place records on it, drag them, select them, annotate them.
Nodes store world coordinates, so zooming never rearranges your layout. The same record can appear on several canvases — a node is a placement, not a copy.

ABOUT YOUR DATA
Everything lives on this iPhone. No account, no hosted database, no sync server run by us.
Export to JSON or CSV, or take a complete backup including images and restore it on another device; backups are checksummed.
No telemetry.

ABOUT ASK
It searches your own records and a built-in coffee reference, and the answer is composed on device. No network, no API key.

To be precise: local-first does not mean never online. Adding a link record fetches the page title and cover from that site. You can skip it; nothing else depends on it.

WHAT BREWPHASE DOESN'T DO
Accounts and cloud sync. A social feed. Reorganising your data for you.
```

---

## 5. 新功能说明 What's New

> **上限 4000 字符。** 每次提审必填，会推送给已安装的用户。

### 中文（327 字符）

```
这一版把 BrewPhase 从「咖啡笔记本」扩成三个空间。

新增
· 记录：链接、图片、视频、文字四种载体，多对多标签，全文搜索，按载体与标签筛选。
· 画布：可平移缩放的无限画布，把记录摆上去、拖动、写备注；同一条记录可以出现在多块画布上。
· 首页改成三空间竖排，点开任一空间直达内容；顶部搜索跨三个空间。
· 库存改成台账，按每次冲煮实际用掉的克数扣减；改剩余量算一次盘点。
· 30 秒快速记录，以及豆子页的本次表现与下一杯建议。

改进
· 风味时间线区分「冲煮带出的」和「吧台手动记的」，两种来源不再混在一起。
· 导出与完整备份（含图片、带完整性校验）都可以整机还原。
· 首页卡片会跟着设备轻微倾斜滑动，可在「更多 → 应用」里关掉。
```

### English

```
BrewPhase grows from a coffee notebook into three spaces.

NEW
· Records: four carriers — link, image, video, text — with many-to-many tags, full-text search and filtering.
· Canvas: a pannable, zoomable board. Place records, drag them, annotate them; the same record can sit on several canvases.
· The home screen is now three stacked spaces; the search field spans all three.
· Stock is a ledger: each brew deducts the grams it actually used, and editing the remaining weight counts as a stock-take.
· A 30-second quick log, plus a per-bag "this cup / next cup" read on the detail page.

IMPROVED
· The flavour timeline now separates notes that came from a brew from notes typed at the bar.
· Export and a complete backup (images included, checksummed) that restores on another device.
· Home cards drift slightly with the device; turn it off under More → App.
```

---

## 6. 短文案（站外推广）

### 小红书（377 字符，正文可直接发）

```
用了两年手冲，我最后留下的记录方式是这样

不是表格，也不是笔记本，是三个分开的空间。

咖啡：一包豆记一次。烘焙日期、开封日期、剩多少克。它会自己算出养豆期和最好喝的那几天。库存是按每次冲煮真实扣掉的克数走的，改剩余量等于做一次盘点——这个细节我很在意，因为大部分记录工具都做得含糊。

记录：链接、图片、视频、文字都能收进来。看到一篇讲浅烘的文章、一个豆子产区的视频、随手拍的一张吧台照片，都放在这里，可以打标签，也能搜。

画布：把上面这些摆到一块可以缩放的空间里。同一条记录可以同时出现在几块画布上，因为节点只是一次摆放，不是复制一份。翻列表看不出来的东西，摊开就有了。

让我决定一直用下去的原因很简单：没有账号。打开就能记，断网也能记。数据在这台手机上，可以导出，也可以整个备份出来。

它不替你整理，也不给你推信息流。这一点对我来说是优点。
```

标题备选：`记录一杯咖啡，我不用表格也不用笔记` / `咖啡记录 app 我为什么选没账号的那个`

### 微博（95 字符）

```
做了一杯好咖啡，三个月后还记得它为什么好喝吗？

BrewPhase 2.0：三个空间分开装——咖啡记豆与冲煮，记录收链接图片文字，画布把它们摊开重排。没有账号，数据留在手机上，断网也能记。
```

### X / 即刻（英文，512 字符）

```
Most coffee apps ask you to sign up before you can log a single cup.

BrewPhase 2.0 doesn't. Three spaces: Coffee for bags and brews, Records for links/images/video/text, Canvas to lay them out and rearrange. Everything stays on your iPhone. No account, no cloud database, works offline.

The part I care about: stock is a ledger. Every brew deducts the grams it actually used. Editing the remaining weight counts as a stock-take, and brews before it stop being refundable. Most apps guess; this one keeps books.
```

### 一句话版（群公告 / 签名档）

```
BrewPhase：本地优先的咖啡记录本。豆子、冲煮、收集的东西分三个空间装，没有账号，断网也能记。
```

---

## 7. 这些地方别写

写的时候踩到就是白改一遍，提前列清楚：

| 别写 | 原因 |
|---|---|
| 「云同步」「多设备自动同步」 | 没有云端。iOS 只能通过局域网把数据送到 Mac 端，而 Mac 端是 GitHub 上的 prerelease |
| 「AI 自动整理你的记录」 | 没做。问一问是本地检索 + 抽取式回答，不生成、不改数据 |
| 「最专业的咖啡记录」「第一」 | 绝对化用语，中国广告法不允许；App Store 也容易被拒 |
| 「Mac 版请到 GitHub 下载」 | App Store 描述里引导到站外下载其他平台客户端，容易被 2.3.10 盯上。要提就只说「可配合 Mac 端使用」，别放链接 |
| 「免费」「限时」 | 现在是免费，但这类词写进描述，之后改价格要连描述一起改 |
| 具体门店/品牌名 | 示例数据里出现的「启程咖啡」「M2M」是虚构或第三方，不进商品页 |

## 8. 两个可选项，看你

1. **要不要提桌面协同**。iOS 2.0 源码里有局域网同步（iPhone → Mac），但 Mac 端是
   `desktop-v0.1.4` 的 prerelease。**建议不提**：一提，审核可能要求说明配套应用怎么获取，
   而你没法在描述里放下载链接。等桌面端正式发布再加一句。
2. **要不要 A/B 推广文本**。App Store Connect 现在支持 Product Page Optimization，
   可以把上面 A/B/C 三个推广文本做成三个 treatment 跑一轮。字符都够，直接能用。

## 9. 还需要你确认

- 名称是否仍是 `BrewPhase`（副标题与关键词都没重复它，符合规则）。
- 主分类建议 `Food & Drink`，次分类可留空；如果选了 `Lifestyle`，副标题里的「记录本」会更贴。
- 年龄分级：**「无限制网页访问」（Unrestricted Web Access）填「否」**，这是查过代码的结论：
  应用内唯一的 `WKWebView` 是 `ExternalMediaPlayer`，它只播放**适配器拼出来的**地址
  （YouTube / B 站 / X 的官方 embed），不接收用户提供的 URL，主框架里越界的跳转一律交给
  系统浏览器（出了应用就不算应用内访问）。其余分级按内容如实答即可，全是自己记的咖啡数据，
  没有社交、没有用户生成内容分发，4+ 站得住。

---

## 10. 文案里每个说法在哪里核过

改文案前想确认某句话还成不成立，照这张表回代码里看：

| 说法 | 依据 |
|---|---|
| 库存是台账、按实际克数扣减 | `Brew.stockDeductedG`（7 处引用） |
| 改剩余量 = 盘点 | `stockCountedAt`（9 处引用，早于它的冲煮不再退粉） |
| 养豆期 / 窗口 / 衰退期由烘焙日期推导 | `Models/BeanPhase.swift`、`PhaseRuleBook.swift`、`RAG/Rules/IntelligenceConfig.swift` |
| 记录每页 20 条 | `Features/Records/RecordsDataSource.swift` 的 `pageSize = 20` |
| 四种载体与差异化卡片 | `RecordCarrier.allCases`、`Services/Link/*Adapter.swift` |
| 画布用世界坐标、节点是摆放不是副本 | `Models/CanvasNode.swift`、`Features/Canvas/CanvasPlacement.swift`、`CanvasNodeStore` |
| 风味来源分「冲煮带出 / 吧台手动」 | `Tasting.source`（`.brew` / `.manual`） |
| 30 秒快记 | `Features/Brew/QuickBrewLogView.swift`（沿用上次参数，折叠更多参数） |
| 本次表现 / 下一杯建议 | `Features/Brew/BrewDiagnosticCard.swift`，挂在豆子详情页 |
| 问一问在本机生成、不需要密钥 | `RAG/Core/RAGSettings.swift` 把 `preferredEngine` 固定为 `.onDeviceSummary` |
| 应用内网页只到白名单 | `Features/Records/ExternalMediaPlayer.swift`（只接 `LinkEmbed`，越界跳转交系统浏览器） |
