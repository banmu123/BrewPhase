# BrewPhase 项目长期约定

跨会话硬规则索引，细节见 `YYYY-MM-DD.md` 日志与代码内注释。
CoffeeAI×ChatGPT 交接唯一权威：`Tools/CoffeeAI/review_queue/GPT_WORKFLOW.md`。

## 环境与构建

* iOS 必须 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`。通过判据 = 末行
  `** TEST SUCCEEDED **` 且无 `Fatal error`（崩溃后 runner 重启，分段统计会误判）。基线 797
  条（3 条跨端同步按设计跳过）。单测 `setUp` 必须 `pinForTesting(.simplifiedChinese)`；截图与
  `xcodebuild test` 不能同时跑。
* `Tools/run.sh --demo` 在应用已运行时忽略参数：先 `simctl terminate`；传参用 `"$@"`；`simctl
  install` 常新建数据容器要重灌示例；输入态用 `-BrewPhaseXxx` 预填。残留
  `sync-harness.json` 会让 SyncCrossEndTests 失败而非 XCTSkip。
* Desktop dev：`env -u ELECTRON_RUN_AS_NODE npx electron-vite dev --noSandbox`；`pnpm e2e` 前
  必须停 dev（userData 单实例锁）。无 GPU 时被遮挡的 Electron 帧被节流，Playwright
  `element is not stable` 不是产品 bug：关 transition、做 `elementFromPoint`、必要时 `force`。
* **GitHub 两层封锁**：`/etc/hosts` 把 github.com / api.github.com / *.githubusercontent.com /
  uploads.github.com 指到 127.0.0.1（Steam++/WattToolkit 接管 `:443`），codeload 被 DNS 投毒。
  git push 绕 DNS：`git -c http.curloptResolve=github.com:443:<IP> -c http.version=HTTP/1.1`，
  **IP 写循环逐个试**；HEAD 通不代表能推（`Empty reply` = 换 IP）。SSH 不通。
  **zsh 不给字符串变量分词**：IP 列表用数组。打包/公证加 `-u NODE_OPTIONS
  NODE_TLS_REJECT_UNAUTHORIZED=0`。

## 本地化（`Tools/Localization/`）

* 键 = 源码里的中文字面量，表里没有就原样返回键。标点也是文案（`、`→", "`，`。`→". "），
  不在 Swift 里拼中文标点，走 `L()`。
* 改完必须 `generate.py && check.py`（现 1177 键：占位符、键集、插值）。

## 数据一致性 / 同步

* **库存是台账**：`Brew.stockDeductedG` 记实际扣掉的克数，删除/编辑按它算。**改剩余量 = 盘点**：
  写 `stockCountedAt`，早于它的冲煮不再退粉、编辑不改库存。烘焙天数读
  `Tasting.resolvedDayAfterRoast`，无日期是 nil（显示「—」），不写 0。
* 删豆子：取通知 ID → 删库成功 → `unschedule` → 重排。Schema 只有
  `BrewPhaseSchema.schema`：只加实体、加可选/带默认值属性。
* 清空只清同步实体（`Desktop/src/main/sync/wipe.ts`），豆/冲煮/品鉴/规则保留；
  `POST /api/sync/wipe` = token + HMAC + `{"confirm":"DELETE_SYNCED_CONTENT"}`。
* iOS 解绑**先清远端再清 Keychain**（反了 token 就没了）；重新配对必须清基线。自动推送由
  `SyncAutoPush` 一处收口，**不要逐视图埋点**。媒体 SHA-256 用 `fileSHA256` 的
  (路径,大小,mtime) 缓存。删除类 E2E 直接开库查 `count(*)`。
* 同步 v1 只 **iOS → Desktop 单向**；Desktop Canvas 编辑不回传。双向同步 / Bonjour 自动发现 /
  TLS 明确未实现。

## iOS：结构与首页

* 一级导航两态 `AppRoute(.home / .space(AppTab))`，**路由状态必须住在 `BrewPhaseApp`**（换语言
  `.id(language)` 重建整棵树，放 RootView 会被弹回首页）。底部 Tab Bar 已删；
  `SpaceSwitcherBar` 挂各自 NavigationStack 根（`safeAreaInset`），推开详情自动消失。
* 首页三分区纵向、每区最多 3 张同宽同高卡；选卡规则一致（先每类一张 → 按时间补齐 → 上限 3）。
  `HStack(spacing:-32)` + `frame(maxWidth:.infinity)`；**永远画满 3 个卡位**，不足用
  `Color.clear` 占位（否则单内容分区被拉成整屏宽），单卡画在中间卡位；`Spacer` 会拉宽。
  **别用「两侧内收」做台阶**（卡按 cardAspect 定高，后卡会躲进前卡背后，有回归用例）。
* 点分区 = 进该空间列表，不是打开第一条；搜索跨三空间，多词「与」，200ms 防抖。
  `CanvasThumbnailPreview` 嵌别的卡须 `height:nil` + `chrome:false`。

## iOS：Gravity Cards（Phase 2 / 2.1）

* **运动只加 `.offset` / `.rotationEffect`，不碰布局**，整区仍是同一个 Button。物理时间线只有
  一条（`WorkspaceHomeView.sections` 的 `TimelineView`），步进写成闭包里的
  `let _ = field.step(at:)`；引擎不可观察，卡片靠 `frameToken: Date` 重画（**不能叫 `frame`**）。
  静止即停，传感器 30Hz 用 `@ObservationIgnored`。
* 行程由布局推导（`WorkspaceGravityTravel`）：多卡水平 `min(16,gutter−2)`、垂直 6pt；单卡
  `=(区域宽−卡宽)/2−6`，卡宽仍用三卡公式；区域宽来自 `onGeometryChange`。边界变小夹回越界位置
  并清该方向速度，变大不动。
* 非线性**只在控制器一处**（`t^1.4`），引擎保持线性。姿态用**基准重力 + 同设备系分量差**，
  不要四元数跨系变换。`DebugLaunch.value(for:)` 把 `-` 开头的值当下个开关，负数参数直读
  `ProcessInfo.arguments`。滚动/键盘 `suspend()`+`calm()`，恢复一律重校准；`DeviceMotionSourcing`
  协议 + Mock 注入。真机手感/方向/耗电只能人工验收。

## iOS：Canvas

* `CanvasNode` 是摆放实例（UUID + 世界坐标），不复制记录；删除必须走 `CanvasNodeStore` 且与
  删除同一次 save，删节点永不删记录。屏幕位置 = 世界 × scale + offset，`CanvasWorldLayer` 整层
  变换一次。
* 节点加载只有一条路径：`nodes(in:)`（throws）→ `reconcile` → 渲染；**读取失败一个节点都不许
  删**（`try? ... ?? []` 曾把画布删光）。`.empty` 只能来自「读取成功 + 对账成功 + 零节点」。
  双指只用 `MagnifyGesture`；点阵间距钳 14–40pt，右上角加号留给「放大」。

## Desktop：Studio Desk 与外观

* 默认页 Studio Home，三空间无全局 Tab，只从首页内容入口进。**三空间横向一行是布局契约**：
  `grid-template-areas:'coffee records canvas'`，980/1100/1280/1440 都不折行。**舞台高度由内容
  决定**：堆叠容器不用 `absolute;inset:0`，改 relative / aspect-ratio 由首卡撑高；
  `:has(.studio-empty)` 才给 268 空态底线。咖啡架高 = 卡宽×196/132。
* Records 首页是 Deck（`DECK_LIMIT=5`），CSS 只消费 `--deck-*`；卡点击必须 `stopPropagation`。
  完整 Records 页仍是 masonry。
* 颜色只有两处来源：`app.css` 的 `:root` 与 `[data-theme='dark']`；**组件不许自己判断明暗**
  （禁读 `prefers-color-scheme`）。主按钮文字用 `--on-espresso`，**不要写死 `#fff`**；同类派生
  `--on-danger`、`--stage`、`--fade`/`--scrim-chip`、`--sheet-*`。深色不是反色：黑底靠
  card > paper 的亮度差分层。Konva 缓存带外观标记（`tokens.ts`）；`shared/theme.ts` 用
  `globalThis` 最小结构类型（tests 由 `tsconfig.node.json` 编译，无 DOM lib）。

## Desktop：内置浏览器与网页卡片

* 唯一实例 `browser-manager.ts`（`WebContentsView` + `persist:brewphase-browser`），渲染层只有
  「壳」。**原生层永远在 DOM 之上，z-index 无效**：起始页/错误页必须 `setVisible(false)`；
  缩放手柄只能放 stage 外侧留白。
* bounds 单向流入：renderer 报 stage `getBoundingClientRect()` → 主进程 clamp → `setBounds()`；
  纵向下限 52。**Electron 45 的 `navigationHistory` 在 WebContentsView 上只有读有效**：
  `canGoBack()` 恒 false、`goBack()` 空操作；能力位用 `getActiveIndex()`/`getAllEntries()` 自算，
  导航用页面内 `history.back()`。
* 安全：无 preload、sandbox、权限全拒、只放行 http/https、`window.open` deny、下载拒绝。关闭 =
  销毁 view 但保留分区与 lastVisit。`capturePage()` **拍不到 WebContentsView**。
* **卡片 = 真实 tabId**（`tab-N` 唯一身份），排序 `cardOrder`，圆桌 `participantTabIds`；禁止第二
  套 `webcard-N`。预览只走 `browser:preview`（update/clear），缓存 ≤12，关闭必须 `forget`，失败
  保留最后一张。**capturePage 需要绘制表面**：隐藏/窗口外返回空图 → 收纳标签挂透明采集宿主
  （`showInactive`，1280×800），截图时临时 `setVisible(true)`；Linux 降级为「显示过才有图」。
* 面板 ✕ = 收起（park），关闭只在卡片/标签 ✕。卡片与标签条都用 `data-tab-id`，落点查询必须在
  `stripRef` 内 scoped（全局 `querySelector` 会命中架子卡片，排序静默失效）。Playwright
  `app.windows()` 会把 WebContentsView 里的网页当页面；独立窗口只认壳页 `#bpFloat=` /
  `#bpRoundtable=`。

## Desktop：多窗口与拖拽会话

* **拖出判定必须在主进程**：OS 原生 HTML5 DnD，`BrowserDragSessionManager` 轮询
  `screen.getCursorScreenPoint` 裁定落点（实时光标 > 会话读数 > 渲染层兜底）；窗口内 drop 必须
  `dropHandled`（IPC FIFO 保证先于 dragend）。会话是**单例**；窗口关闭（含 dragend 不到达）必须
  强制 `dragSession.cancel()`。
* 窗口定位禁止 `Math.max(0,…)`：用 `getDisplayNearestPoint(落点).workArea` + `fitRectIntoBounds`
  （负坐标有单测）。系统关闭 = `recallToShelf`（park）；主窗口 activate 重建判 `mainWindowRef`。
* **卡片拖拽面**：装饰子元素 `pointer-events:none`、img 加 `-webkit-user-drag:none`；**禁止对
  正在被拖的源卡做 DOM 变更**；dragstart 副作用必须包 try（抛错 = Chromium 取消拖拽）。编辑卡
  错误分层：navigate 成功会写 tab.url 退出编辑态，网络级失败显示卡上 chip，输入级拒绝才在表单
  内报错。
* E2E：假光标 `__bpTestHooks.setDragCursor`（仅 !app.isPackaged）；`browser.state()` 是
  Promise；`dragAndDrop` 不可靠，回归用合成 DragEvent + 结构断言。

## Desktop：圆桌（4.1 / 4.2 / 4.2b）

* **tabId 是身份**：成员 = 真实 WebCard，provider 只是能力标签。平台识别在主进程 Registry
  （严格主机匹配）对实时 URL 判定；自动化用 `resolveTabForAI` 的**原始 WebContents**，绝不建
  隐藏副本。移出成员/关闭页面 → 立即 `cancelParticipant`；每轮重新 resolve。
* 状态在主进程 `RoundtableService`（快照 + version 广播），Renderer store 只是缓存。join 校验
  真实标签，标签关闭 `syncTabs` 自动摘除。草稿 = **后写者胜出**（baseVersion 门控会丢字符）。
  **服务型广播必须真正接线**：notify 在构造时接 `params.broadcast`；cancel 同时设
  `run.cancelled` 与状态。
* 圆桌窗口：唯一实例、系统 ✕=归位（isQuitting 放行防卡 quit）、外部销毁走 `onWindowLost`。
  `-webkit-app-region:drag` 与 `draggable` 同区域互斥，拖拽源做成独立 no-drag 手柄。自由布局但
  面板互不重叠：shared 纯函数三件套（resolveMove/resolveResize/findFreePanelSpot）预览与落库
  同源，被围死返回 null=保持原状；maxY=工作区高−120 是 KEEP_VISIBLE。
* 原生 view：DOM 只画标题栏+手柄（bounds 外 6px），内容区 rects 上报 → setBounds；置顶 =
  removeChild+addChild；持久化 migration 11 `roundtable_panels`（含 url），防抖 300ms。幽灵面板：
  重启后 WebContents 必消失、布局行还在 → 如实显示关闭态 + 一键重开，`rebindPanel` 原几何绑新
  tabId；join 时页面没加载完 url 是空串 → `onPageSettled`。
* 探测/轮询单一来源 `poll-engine.ts`；adapter 纪律（基线先于发送、写入校验、JSON-only）。
  已识别 ≠ 可自动交互。渲染层级：`#`→h3、`##`→h4、列表项是 `p.md-ul`；`textContent` 的 `\n`
  被 `white-space:normal` 折叠，夹具页换行用 `<br>`。
* E2E：`BREWPHASE_AI_TEST_HOST` 接缝；**惰性 locator 陷阱**——`.last()` 动作时重新解析，多卡要在
  每张卡创建后立即取 data-tab-id。独立圆桌窗口主体 = `.rt-panel` + 提问条 + 讨论抽屉（先点
  `.rt-window__ask-toggle`）。未解：`browser.e2e`「拖动与缩放」在无 GPU 环境拖不到位。

## Desktop：工作区与回复智能（0.1.4）

* 每张 AI 卡片的本地工作区在右侧竖栏（`CardWorkspaceToolbar.tsx`，独立圆桌窗口同款）：笔记 /
  参考文件 / 上下文构建都在卡内完成；契约 `shared/contracts/local-workspace.ts`、
  `reply-intelligence.ts`，落库 `database/repositories/reply-intelligence.ts`。
* 回复智能是**本地**分类 + 操作草稿：先导入再分类，草稿只在应用内确认，不经 MCP 写回。

## Desktop：MCP、发布与工作流

* 权限预设第一档就是默认值（`MCP_SCOPE_PRESETS[0]`，14 项含写入），顺序即梯度；改默认只改契约
  一处，两处 `useState` 跟着走。**默认全给 ≠ 放宽确认边界**：MCP 侧没有 confirm 能力，
  `direction:propose` 只写草稿。引导里权限折叠成一行摘要，按 `scopes.length` 说。
* 发布链：`pnpm build` → `electron-builder --mac --arm64 --dir` 产签名 `.app` → `notarytool
  submit --keychain-profile BrewPingNotary --wait` → `stapler staple` → `--prepackaged <app>` 产
  dmg/zip → `codesign` 签 dmg → **重算 `.sha256`**（签名后哈希变）→ API 建 release + 传资产。
  **公证/签名必须临时关系统代理**（都指 127.0.0.1:7897 时撞 MITM 证书报 SSL -1200；`env -u`
  不够，要 `networksetup -set*proxystate Wi-Fi off` 并用 `trap` 恢复）。
* **uploads.github.com 真实 IP = `20.205.243.161`**（CNAME `alambic-origin.githubusercontent.com`，
  DoH 可查）；140.82.x.x 是 web 前端，打资产端点会 301 到 `github.com/repos/...`。直连该 IP
  130MB 约 30 秒。API 返回的 asset `digest` 可跟本地 sha256 直接对比。本机无 `gh`，用
  `~/.git-credentials` 的 PAT。
* dmg 自身公证极慢（>10min）可跳过：内部 `.app` 已 staple 时，挂载出的 app `spctl` 就是
  `accepted / Notarized Developer ID`。electron-updater 未实现，版本检查提示已实现。权威状态看
  `docs/PROJECT_STATUS.md` 与英文 `README.md`。
* 阈值集中 `RAG/Rules/IntelligenceConfig.swift`；中文词表放 `Resources/*.json`；纯逻辑放
  `Core/`，视图放 `Shared/Components/` 与 `Features/`。改完先 commit + push 再询问 GPT，必须附
  https://github.com/banmu123/BrewPhase。
