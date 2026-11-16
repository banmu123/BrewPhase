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
