# App Review 说明（iOS）

App Store Connect → App Information → **App Review Information → Notes** 直接贴下面
对应语言的段落。中文给中文审核区，英文给英文审核区；两边内容一致。

版本对应：`main` 的 iOS 工程（MARKETING_VERSION = 2.0），bundle `com.brewphase.ios`。
1.1 是已在 App Store 的 Coffee 单册版本；本次提交是加入 Records / Canvas / 本地智能的 2.0。

## 一、审核员最需要的三句话

1. **不需要账号，也不需要登录。** 应用没有注册、没有后端、没有内购；首次打开即可用。
2. **示例数据在这里**：首页右上角齿轮 → **更多** → **数据** → **示例数据** 开关。
   打开后会写入 7 包演示豆、21 条记录（文字 / 图片 / 视频 / 链接）与 2 块已摆好节点的画布。
   关掉开关整批移除，只删带 `isSample` 标记的内容，用户自己记的东西不受影响。
3. **不联网也能看完整功能。**「问一问」用的是本机抽取式回答（不调用任何 LLM，不需要
   API key）。唯一需要网络的路径是给链接记录抓标题/封面，失败会明确显示失败态。

## 二、中文（贴 App Review Information → Notes）

```
BrewPhase 是一本本地优先的咖啡记录本，2.0 把内容分成三个空间：咖啡（豆子与冲煮）、
记录（文字 / 图片 / 视频 / 链接）、画布（把记录摆到一块可缩放的空间里）。

无需登录，也没有任何内购或订阅。所有数据保存在设备本地（SwiftData + 应用沙盒内的图片），
应用不会把内容上传到任何服务器。唯一会主动联网的操作是「链接」记录在抓取网页标题与封面时
访问目标网站本身；失败会显示失败态，不影响其他功能。

如何查看示例数据（这是查看完整界面最快的方式）：
1. 打开 App，停在首页。
2. 点右上角的齿轮 →「更多」。
3. 找到「数据」分组 → 打开「示例数据」开关（会二次确认）。
4. 回到首页，三个空间都有内容了：咖啡 7 包豆（含已过养豆期、已喝完、缺烘焙日期各一种）、
   记录 21 条（第一页 20 条、第二页 1 条，可下滑验证分页）、画布 2 块（节点已摆好）。
5. 想清空：同一开关关掉即可，只会删除带示例标记的内容。

其他说明：
- 「问一问」与豆子页的建议都在本机计算（抽取式回答，不调用大语言模型、不需要网络与密钥）。
- 通知是可选功能，用于提醒养豆期与最佳饮用窗口；不允许通知不影响记录与浏览。
- 「桌面同步」需要 macOS 端 BrewPhase 与同一局域网，审核不需要用到；不配对也能使用
  手机端全部功能。
- 「重力卡片」会读取设备姿态（CoreMotion）让首页卡片轻微滑动，可在
  「更多 → 应用 → 重力卡片」关闭；姿态数据不保存、不上传。
- 应用内可切换中文 / English（更多 → 应用 → 语言）。
- 没有任何账号体系，因此不涉及「Sign in with Apple」审核项。
```

## 三、English（paste into App Review Information → Notes）

```
BrewPhase is a local-first coffee notebook. Version 2.0 splits content into three spaces:
Coffee (bags and brews), Records (text / image / video / link), and Canvas (records placed on a
zoomable board).

There is no sign-in and no account of any kind, and no in-app purchases or subscriptions. All
data is stored on the device (SwiftData plus images inside the app sandbox); nothing is uploaded
to a server. The only outbound request is when a Link record fetches the page title and cover
image from the site itself; if that fails the card shows a failure state and the rest of the app
keeps working.

Fastest way to see a populated app (sample data):
1. Launch and stay on the home screen.
2. Tap the gear icon at the top right -> "More".
3. Find the "Data" section -> turn on "Sample data" (there is a confirmation step).
4. Go back home: all three spaces now have content — 7 coffee bags (including one past its
   resting window, one finished bag, and one with no roast date), 21 records (20 on the first
   page, 1 on the second, so scrolling to the end shows pagination), and 2 canvases with cards
   already placed.
5. Turn the same switch off to remove everything again — only items marked as samples are
   deleted; anything the reviewer created is untouched.

Other notes:
- "Ask" and the per-bag suggestions run entirely on device (extractive answers; no LLM, no
  network, no API key).
- Notifications are optional (resting window and best-drinking reminders). Declining them does
  not limit recording or browsing.
- "Desktop sync" needs the macOS BrewPhase app on the same LAN and is not required for review;
  every phone feature works without pairing.
- "Gravity cards" reads device motion (CoreMotion) so home cards drift slightly; it can be turned
  off in More -> App -> Gravity cards. Motion data is never stored or uploaded.
- Language can be switched between Chinese and English inside the app (More -> App -> Language).
- There is no account system, so no "Sign in with Apple" requirements apply.
```

## 四、备查：这套示例数据到底包含什么

代码在 `BrewPhase/Services/DemoData.swift`，入口是 `更多 → 数据 → 示例数据`（同一函数
也支持启动参数 `-BrewPhaseDemo yes`，只用于模拟器）。全部内容带 `isSample` 标记，
`DemoData.removeInstalled` 是唯一的删除路径。

| 空间 | 内容 | 覆盖到的界面 |
|---|---|---|
| 咖啡 | 7 包豆：Ethiopia Guji（养豆中、剩余 86g）、Colombia Pink Bourbon（刚出排气期）、Kenya AA（仍在养）、Brazil Cerrado（过期且剩 210g）、House Espresso（意式拼配 1kg）、Panama Geisha（**无烘焙日期**）、Rwanda Nyungwe（**已喝完**） | 阶段排序、今日推荐、库存与盘点、已喝完分组与恢复 |
| 咖啡 · 冲煮 | Guji 上 4 次冲煮（含 1 次刻意「不太好喝」的：2:08、酸高甜低）＋ Brazil 上 1 次意式 | 冲煮历史、本次表现 / 下一杯建议、诊断（萃取不足 → 磨细一档） |
| 咖啡 · 风味 | 6 条（5 条来自冲煮、1 条吧台手动） | 风味时间线、来源区分 |
| 记录 | 21 条：6 条链接（GitHub 仓库 ×2、YouTube、B 站、X、Standart 杂志）、10 条文字、4 张本机生成的图片、1 条视频（只有封面，详情页会说明）、6 个标签 | 两列瀑布流、翻页、搜索、标签筛选、链接卡片与详情 |
| 画布 | 2 块，7 个节点：4 种载体各一条（仓库卡 / 视频卡 / 图片卡 / 文字卡）+ 3 条想法 | 画布缩放平移、节点拖动、空态对照 |

维护约束（改示例数据时要一起看）：

- `SampleDataTests` 钉住四件事：每块示例画布**必须有节点**、四种载体都要出现、
  记录数要**超过 `RecordsDataSource.pageSize`**、关掉开关后节点与画布一起清空。
- 示例画布的节点走 `CanvasNodeStore.add`（与用户手动添加同一条路径），不是写死坐标。
- 新增文案要登记到 `Tools/Localization/strings.py`，然后
  `python3 Tools/Localization/generate.py && python3 Tools/Localization/check.py`。

---

## 五、桌面同步的演示视频（需要录）

### 为什么必须录

iOS 端的配对**只有扫二维码一条路**，没有手输配对码。桌面端生成的码
`PAIRING_TTL_MS = 120_000`（两分钟）且**一次性**（验证成功即把 hash 置空），
二维码里还带着 Mac 在局域网里的地址。这意味着审核员要复现必须同时具备：

1. 一台装了 BrewPhase Desktop 的 Mac（`desktop-v0.1.4`，GitHub 上的 prerelease）；
2. 和 iPhone 在**同一个局域网**；
3. 在两分钟内完成扫码。

这三条在 Apple 的审核环境里都不成立。按 2.1 App Completeness 的通行做法，
**功能依赖第二台设备或无法复现的环境时，要在审核备注里附一段演示视频**，
否则很容易收到「we were unable to review this feature」并要求补充材料，
白耗一轮队列。

### 录多长、录什么

**40–55 秒，一条不剪辑的连续录屏即可，不要配乐、不要做宣传片。** 审核要看的是
「这个功能真的能跑」，不是好看。

建议按这个顺序录（时长是目标值，不是硬要求）：

| 时间 | 画面 | 要让人看到什么 |
|---|---|---|
| 0:00–0:05 | Mac：设置 → 设备同步 → 启用局域网同步 → 连接新设备 | 二维码出现，页面上有「2 分钟后失效」 |
| 0:05–0:10 | iPhone：首页「桌面空间」卡片（副标题「尚未配对 · 连接桌面端」）→ 点「扫描二维码」 | 权限提示（相机）正常弹出并允许 |
| 0:10–0:18 | 相机对准 Mac 屏幕 | 扫码成功 → 「已读取二维码」→「正在验证桌面端信息并保存连接…」 |
| 0:18–0:24 | iPhone 配对完成 | 设备面板出现（Mac 名称 / 上次同步） |
| 0:24–0:32 | iPhone 上新建一条记录，再点「立即同步」 | 同步统计数字变化（记录数 / 媒体数） |
| 0:32–0:44 | 切到 Mac，打开 Records（或画布） | 刚在 iPhone 上记的那条**真的出现在 Mac 上**；画布上节点也在 |
| 0:44–0:50 | 可留：iPhone 解除配对，选「只解除配对」 | 说明两种解除后果的差别 |

**关键的一镜是 0:32–0:44**：必须在 Mac 上看到 iPhone 刚写的那条内容。没有这一镜，
视频就只是「配上了」，证明不了同步。

### 录制时的几个具体建议

- **把两端界面都切到英文再录**：应用内就能切（更多 → 应用 → 语言；Mac 端同样有语言项）。
  审核员多数看英文，省掉一道翻译。
- **手机用真机，不要模拟器**：模拟器没有摄像头，扫码这一步过不去。
- Mac 端用**已公证的 0.1.4 官方包**录，不要用 dev 模式（窗口标题会带 dev 字样，
  看起来不像正式版本）。
- 先打开示例数据（更多 → 数据 → 示例数据），这样记录页不是空的，0:32 那一镜有东西可看。
- 录之前把 Mac 的**防火墙询问**和 iPhone 的**本地网络权限**都先点过一次，
  免得录制中弹出系统弹窗耽误时间。
- 屏幕录制用系统自带的 `Cmd+Shift+5` 就够；分辨率 1080p，H.264，文件控制在几十 MB。

### 视频放哪里

两种都行，建议**两个都做**：

1. **直接当附件传**：App Store Connect → App Review Information → 附件区，放 `.mp4`/`.mov`。
   审核员不用点外链，最不容易出岔子。
2. **再补一个链接**贴在 Notes 里：YouTube 设为 **Unlisted**（不是 Private），或 Vimeo
   无密码链接。**不要用**需要登录或有区域限制的网盘、视频号——审核员打不开会直接问你要。

### 配套要写进 Notes 的话

视频之外，用一句话把边界说清楚，避免审核员以为功能缺失：

```
Desktop sync is optional. Every feature described in the app — Coffee, Records, Canvas,
sample data, Ask, export and backup — works without pairing. The sync entry only appears
under More → Data → Desktop sync and on the home screen; it requires the macOS companion
app on the same local network. A short demo video is attached showing pairing and a record
syncing from iPhone to Mac.
```

中文版：

```
桌面同步是可选的。应用内的全部功能——咖啡、记录、画布、示例数据、问一问、导出与备份——
不配对也能完整使用。同步入口只出现在「更多 → 数据 → 桌面同步」和首页；它需要同一局域网内
装有 macOS 端。附件是一段演示视频，包含配对与一条记录从 iPhone 同步到 Mac 的过程。
```

### 顺带一个风险点

iOS 端「还没有安装？下载桌面端」这一行指向
`https://github.com/banmu123/BrewPhase/releases`（`AppLinks.desktopDownload`）。
它链的是**另一个平台的桌面软件**，不是 iOS 应用，通常不会被当成 2.3.10 处理；
但如果审核对「引导站外下载」敏感，这是页面上唯一一处外部跳转。

三个选项，按保守程度排：

1. **保留**（现状）。多数带桌面客户端的应用都这么做，风险低。
2. **改成纯文字**，只写「可在电脑上配合 BrewPhase Desktop 使用」，不放链接。
3. **这版先隐藏**这一行（保留配对功能），等桌面端正式发布再放回来。

如果这版想尽量一次过，选 2 的成本最低：一句话的事，不影响功能。
