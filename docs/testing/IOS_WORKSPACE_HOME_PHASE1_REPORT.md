# BrewPhase iOS — Phase 1：三空间卡片堆叠首页

**范围**：首页、一级导航，以及为这两处直接服务的展示组件。
**不做**：任何业务逻辑、数据模型、同步、备份、Records / Canvas / Coffee 的内部页。

**结论先说**：三空间首页与顶部空间切换已经落地；底部 Tab Bar 已删除；
`xcodebuild test` 全绿（735 条，3 条按设计跳过）。**但本轮没有做真人手指点击验收**
——模拟器无法点按，交互链路只经过代码审查与结构测量，逐项见 §10。

---

## 1. 原有首页与导航结构

改造前的一级导航是 `RootView` 里的一层 `VStack`：

```text
RootView
└── VStack(spacing: 0)
    ├── TabView(selection:)              // 三个页面，tabBar 已隐藏
    │   ├── CoffeeHomeView()   .tag(.coffee)   // 各自内嵌 NavigationStack
    │   ├── RecordsView()      .tag(.records)
    │   └── CanvasListView()   .tag(.canvas)
    └── CapsuleTabBar(selection:)        // 自绘底部胶囊，三枚图标 + 文字
```

几个与本次改造直接相关的事实：

| 事实 | 影响 |
|---|---|
| 三个模块页各自**内嵌** `NavigationStack` | 不能再在外面套一层栈；一级导航只能是「换页」，不能是「push」 |
| 三个模块页都 `.toolbar(.hidden, for: .navigationBar)`，标题画在滚动内容里 | 顶部切换条必须自己占位，不能借系统导航栏 |
| `selection` 放在 `BrewPhaseApp` 而非 `RootView` | 换语言时 `.id(language)` 重建视图树，选中态不能丢——路由状态也必须提到这一层 |
| 首页原本就是 Coffee | 「Coffee 是主体」这件事在代码层就成立：启动即咖啡 |
| 测试不引用 `AppTab` / `CapsuleTabBar` / `RootView` | 导航类型可以安全重构，不会牵动既有用例 |

## 2. 修改的文件清单

**新增（7）**

| 文件 | 职责 |
|---|---|
| `BrewPhase/Core/WorkspaceStackLayout.swift` | 堆叠几何：可见张数、重叠宽度、下沉、透明度（纯值，可单测） |
| `BrewPhase/Features/Home/WorkspaceHomeFeed.swift` | 卡片投影 + 选卡规则 + 问候语（纯值，可单测） |
| `BrewPhase/Features/Home/WorkspaceHomeView.swift` | 首页容器：页头、桌面同步入口、搜索、三个纵向分区、详情跳转 |
| `BrewPhase/Features/Home/WorkspaceCardStackView.swift` | 一个分区：空间名 + 横向叠放的三张卡（整行即按钮） |
| `BrewPhase/Features/Home/WorkspaceCardView.swift` | 单张卡：真实缩略图 / 色块 + 标题 |
| `BrewPhase/Features/Home/SpaceSwitcherBar.swift` | 模块顶部切换条 + `SpaceNavigation` |
| `BrewPhaseTests/WorkspaceHomeTests.swift` | 26 条用例（几何、选卡、搜索、投影、路由、问候） |

**修改（8）**

| 文件 | 改了什么 |
|---|---|
| `BrewPhase/App/BrewPhaseApp.swift` | `TabView` + `CapsuleTabBar` → 路由切换；新增 `AppRoute`；`AppTab` 去掉 `symbol` |
| `BrewPhase/Features/Coffee/CoffeeHomeView.swift` | 加 `navigation` 参数 + 顶部切换条（`safeAreaInset`） |
| `BrewPhase/Features/Records/RecordsView.swift` | 同上 |
| `BrewPhase/Features/Canvas/CanvasListView.swift` | 同上 |
| `BrewPhase/Features/Canvas/CanvasThumbnailPreview.swift` | `height` 改为可空、新增 `chrome` 开关（默认值不变，旧调用点零改动），供首页卡片内嵌 |
| `BrewPhase/Shared/Theme.swift` | 新增 `Palette.sage` / `Palette.lilac`；删除死值 `Metric.tabBarInset` |
| `Tools/Localization/strings.py` | 13 条新文案 |
| `docs/design/BrewPhase-Design-System-v1.md` | §8 组件契约：`CapsuleTabBar` → `WorkspaceCardStack` + `SpaceSwitcherBar`；§10 验收基准 |

**删除（1）**：`BrewPhase/Shared/Components/CapsuleTabBar.swift`（唯一的调用方已随 TabView 一起移除）。

`en.lproj` / `zh-Hans.lproj` 由 `generate.py` 重写，未手改。

## 3. 新首页的组件结构

```text
WorkspaceHomeView (NavigationStack)
├── header                      BREWPHASE / STUDIO · 问候 · 日期
├── DesktopSyncEntryRow         桌面配对状态行（从咖啡页搬来）
├── searchField                 胶囊搜索框（跨三个空间）
└── VStack(spacing: 20)         三个分区纵向排列
    ├── WorkspaceCardStackView(.coffee)   ─┐
    ├── WorkspaceCardStackView(.records)   ├── 每区：空间名 + HStack(间距 -32, ≤3 张卡)
    └── WorkspaceCardStackView(.canvas)   ─┘
```

**点击只有一层**：整个分区是一个 `Button`，点卡片、点标题、点空白都进这个空间的
**列表**。首页卡片只是预览，不承担「打开某一条」的职责——要直接打开某一条，用顶部
搜索（结果行点开才是详情）。这条是 13:20 修订的：最初点最前那张卡会直接进详情，
用户指出应该先进列表。

## 4. 三空间真实数据怎么接

全部来自现有的 SwiftData 查询，没有新表、没有新字段、没有假数据：

| 空间 | 候选来源 | 卡片标题 | 卡片小数据 |
|---|---|---|---|
| Coffee | `Bean`（createdAt）、`Brew`（date）、`Tasting`（date） | 豆名 / 「一杯咖啡」/「风味记录」 | 剩余克数 / 评分 / 粉水比 |
| Records | `Record`（createdAt） | `displayTitle`（空则「未命名记录」） | 记录日期 |
| Canvas | `Canvas`（updatedAt） | `displayName` | 更新日期 |

**图片**：记录用 `mediaPath`（图片）/ `previewPath`（视频、链接），豆子用 `imagePath`，
一律走 `ImageStore.image(named:thumbnail:true)` 的 400px 缩略图；画布用
`CanvasThumbnailPreview` 画真实节点分布。没有图的内容不编图——给一层与空间色同源的
极浅色块，加标题首字，**不使用咖啡杯/咖啡豆插画**。

**选卡规则（三个空间完全一致）**：

1. 先按「种类」各取一张（时间最新的那张）。Coffee 因此总能看到一包豆，
   Records 会横跨图片/链接/文字，而不是被同一种载体占满；
2. 再按时间补齐；
3. 上限 3 张，与列里画几张是同一个常量（`WorkspaceStackLayout.visibleLimit`）。

排序值来自各自的真实时间线，同一时刻用 id 兜底，保证每次刷新顺序不变。

## 5. 卡片堆叠与点击区域怎么实现

几何全部收在 `WorkspaceStackLayout`（纯值，26 条用例里 6 条钉它）：

| 参数 | 值 | 说明 |
|---|---|---|
| `visibleLimit` | 3 | 一个分区最多三张 |
| `cardOverlap` | 32pt | 相邻两张的重叠宽度；负间距实现 |
| `depthLift` | 3pt | 每往后一张下沉多少 |
| `cardAspect` | 0.9 | 宽 ÷ 高；卡片宽度由行宽均分 |
| `opacity` | 1 / 0.9 / 0.78 | 后卡退后但可读 |

**这里踩过两个真实的坑**（都已修，并写成回归用例）：

1. 最初是「三个空间三列并排」，每列内收 4pt 做台阶。卡片按宽高比定高，内收会让后卡
   比前卡**矮 13pt**，而它只下探 7pt——后卡整张躲进前卡背后，截图上每列只剩一张卡。
2. 三列并排在手机上把内容挤在上半屏，下半屏整片空白（用户实测指出）。改成三个分区
   **纵向**排列、每个分区内**横向**叠放，页面才铺满。

点击：整个分区是一个 `Button`（`.contentShape(Rectangle())`），点卡片/标题/空白都进
该空间的列表；后卡只做纵深，不单独响应点击。卡片本体 ≥ 44pt 见方。

## 5.1 顶部搜索

- 胶囊输入框（与 Records 同款），带 200ms 防抖；`-BrewPhaseSearch` 可预填用于截图。
- 匹配范围：豆名/烘焙商/产区/处理法/备注/风味标签、冲煮方式/磨豆机/备注、
  风味记录备注/标签、记录标题/正文/摘要/作者/标签/URL、画布名/说明。
- 多词为「与」：每个词都要在任一字段命中，顺序不限。
- 候选池每类 200 条，结果上限 30 行；点结果行进**那一条**的详情。
- 无结果时给 `EmptyStateView`（一个图形 + 一句「没有找到」+ 清空搜索）。

## 6. 底部导航换成了什么

- `RootView` 不再有 `TabView`，也没有底部胶囊；底部区域现在是页面自己的留白。
- 一级导航变成两态 `AppRoute = .home | .space(AppTab)`，状态住在 `BrewPhaseApp`
  （和原来的 `selection` 同一层，换语言不会把人弹回首页）。
- 每个模块页顶部有 44pt 的 `SpaceSwitcherBar`：左「‹ 工作台」，右三枚空间名胶囊，
  选中态 `cream` + `ink`，长在模块 `NavigationStack` 的**根页面**上（`safeAreaInset`）。
  推开一包豆 / 一条记录 / 一块画布时，它随根页面一起离开，详情页只剩系统返回按钮。
- 模块之间的切换是换页，不是 push：三个模块各自持有 `NavigationStack`，再套一层会变成
  嵌套栈。代价见 §9 第一条。

## 7. 凭什么说原有功能没被破坏

| 面 | 依据 |
|---|---|
| Coffee | 只加了一个 `navigation` 参数和一条 `safeAreaInset`；`CoffeeHomeView` 的 `@Query`、豆仓 deck、冲煮区、已喝完区、四个 sheet、`navigationDestination` 一行未动 |
| Records | 同上；搜索防抖、瀑布流分页、下落动画、删除确认全部原样 |
| Canvas | 同上；画布创建、节点、拖动、缩放、删除路径未触碰 |
| 数据 | 没有改 `BrewPhaseSchema`、没有加实体/字段/迁移；`WorkspaceCard` 是投影，点开仍回原件 |
| 同步 / 备份 | 未触碰 `Sync*`、`Backup*` 任何文件 |
| 测试 | 既有 716 条一条未删、未改；新增 19 条，合计 735 条 0 失败 |

数据库落库与读取的口径也没变：首页新增的 `@Query` 只读不写，候选池上限 24 条，
不为看不见的卡片建对象。

## 8. 编译与测试结果

```text
xcodebuild build  -scheme BrewPhase -destination 'iPhone 16 Pro (18.6)'   → BUILD SUCCEEDED
xcodebuild test   -scheme BrewPhase -destination 'iPhone 16 Pro (18.6)'   → TEST SUCCEEDED
    Executed 735 tests, with 3 tests skipped and 0 failures
```

- 3 条跳过是 `SyncCrossEndTests`：需要桌面端 `sync-harness.ts` 起真服务并写
  `sync-harness.json` 才能跑，属设计内跳过（`XCTSkip`），不是被本次改动弱化。
  顺手清理了模拟器里 134 份指向已关闭端口的**过期**夹具，否则它们会让这 3 条用例
  以「连接被拒」失败，而不是跳过。
- 本地化：`generate.py` → 1170 键；`check.py` → `Localisation check passed`。

**跨进程对照**：把本次改动 `git stash -u` 后在干净 HEAD 上跑同一套测试 = 716 条 0 失败；
恢复改动后 735 条 0 失败。两次都干净，说明新增用例没有污染既有用例的语言/顺序状态。

## 9. 尚未完成 / 已知取舍

1. **换空间会重建模块视图**。原来 `TabView` 保活三个页面，现在离开再回来，
   Records 的滚动位置与已加载分页会重置（数据在库里，不会丢）。要保活得把三个页面
   重新常驻，代价是与「删掉 TabView」直接冲突，本阶段没做。
2. **首页下半屏是留白**。三列 × 三张卡在 iPhone 上到 420pt 左右结束，下方是页面的
   静默区。规格的结构示意也是「标题 → 三列」，所以没有把内容居中或塞第四行；
   如果后续想填满，需要新增内容模块，不属于本阶段。
3. **冲煮 / 风味卡点开的是那包豆的档案**，不是独立详情页——它们本来就没有独立详情页
   （App 里冲煮与风味是豆子档案的一部分）。这是「不新增业务页面」的取舍。
4. **iPad 只做了宽度上限（760pt 居中）**，没有在 iPad 模拟器上截图验收。
5. 首页三列的辅助色新增了 `sage` / `lilac` 两枚 token。它们不是阶段色
   （`moss` 已被 peak 占用，不能挪用），对比度按小字 ≥ 4.5:1 选的，但**没有做
   色盲模拟与暗色模式的实机核对**。

## 10. 需要人工在真机/模拟器确认的项目

自动化只能证明「结构对」，下面这些必须有人点一遍：

- [ ] 点 Coffee / Records / Canvas 三个分区（卡片上、标题上、空白处都试）都进入对应**列表**
- [ ] 顶部搜索输入关键词：结果行出现，点开是**这一条**的详情；清空后回到三个分区
- [ ] 进模块后点「‹ 工作台」回到三空间首页
- [ ] 在 Coffee 里点「记录」直接换空间，不必先回首页
- [ ] 推开详情后，顶部切换条消失、系统返回手势正常
- [ ] 空空间：删光某类内容后，该分区显示同尺寸空态卡，点击进入该空间
- [ ] VoiceOver：三个空间名可读、选中态朗读为「已选中」、后卡不被聚焦
- [ ] Dynamic Type 拉到最大字号：卡片标题只留一行、不撑破卡片
- [ ] 打开「减弱动态效果」：新增内容时堆叠用淡入而不是弹入
- [ ] 深色模式：首页与模块页的纸面、卡片、发丝线对比正常（本次未在深色下截图）
- [ ] iPad：三个分区不被拉得过宽（内容上限 760pt）

---

**截图位置**（本轮验收用，未入库）：`/tmp/bp-phase1/`
`home-v5.png`（竖排首页，16 Pro）、`home-search.png`（搜索「咖啡」的结果）、
`home-search-empty.png`（无结果空态）、`coffee/records/canvas.png`（带顶部切换条的模块页）。

**竖排后的结构测量**（像素扫描，非目测，iPhone 16 Pro 402×874pt）：

| 量 | 实测 |
|---|---|
| 卡片行横向 | 22 → 380pt 铺满内容宽；三张卡各 141pt，重叠 32pt（边界在 22 / 131 / 240 / 380） |
| 分区纵向 | Coffee 卡片 312.7–471.7、Records 525–684、Canvas 737 起（首屏可见约 2/3，余下滚动） |
| 页面元素顺序 | 页头 → 桌面同步行 169–201 → 搜索框 219–258 → 分区标题 ~288 |
| 搜索态 | 结果行 34pt 图标 + 两行文字，行高 52pt，行间 0.7pt 发丝线；无结果时给 EmptyState |
| 底部导航 | 780–868pt 内没有任何宽于 200pt 的白色块（底部胶囊确已删除） |

三列并排版本的旧测量（每列 112.3pt、缝 10.4pt）随 13:20 改版作废，保留在提交
`915e0d8` 的截图记录里。
