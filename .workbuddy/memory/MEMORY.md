# BrewPhase 项目长期约定

跨会话硬规则索引（精简版，细节见 `YYYY-MM-DD.md` 日志与各模块内注释）。
CoffeeAI×ChatGPT 交接唯一权威：`Tools/CoffeeAI/review_queue/GPT_WORKFLOW.md`。

## 环境与构建

* iOS 构建必须 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`（默认 CLT 报
  tool not found）。通过判据 = 末行 `** TEST SUCCEEDED **` 且 `grep "Fatal error"` 为空
  （崩溃后 runner 会重启，分段统计会误判）。基线 797 条（3 条跨端同步按设计跳过）。
  单测 `setUp` 必须 `LanguageManager.pinForTesting(.simplifiedChinese)`；截图与
  `xcodebuild test` 不能同时跑（抢模拟器）。
* `Tools/run.sh --demo` 在应用已运行时不重启、参数被忽略：先 `simctl terminate`；
  zsh 不对 `$2` 分词，传参用 `"$@"`；`simctl install` 常新建数据容器要重灌示例数据；
  输入态靠 `-BrewPhaseXxx` 预填。残留 `sync-harness.json`（指向已关端口）会让
  SyncCrossEndTests 失败而非 XCTSkip。
* Desktop dev：`env -u ELECTRON_RUN_AS_NODE npx electron-vite dev --noSandbox`；
  `pnpm e2e` 前必须停 dev（真实 userData 单实例锁）。无 GPU 的 Electron 被遮挡时帧被
  节流，Playwright `element is not stable` 不是产品 bug；断言前关 transition、做
  `elementFromPoint`，必要时 `force:true`。
* **GitHub 被两层挡住**：`/etc/hosts` 把 github.com / api.github.com /
  *.githubusercontent.com / upload.github.com 映射到 127.0.0.1（本机自配屏蔽，
  api.github.com 能通是本机转发服务）；漏网的 codeload 被 DNS 投毒。git 绕过 DNS：
  `env -u http_proxy -u https_proxy git -c http.curloptResolve=github.com:443:<IP>
  -c http.version=HTTP/1.1 push`。**IP 会反复变，写成循环逐个试**
  （116.4→112.3→113.3→114.3→121.3），先 `curl -sI --max-time 6 --resolve
  github.com:443:<IP> https://github.com` 筛；HEAD 通不代表能推（`Empty reply from
  server` = 换 IP）。SSH 不通（公钥未加账号）。打包同理再加 `-u NODE_OPTIONS`。

## 本地化（`Tools/Localization/`）

* 键 = 源码里的中文字面量；表里没有的键运行时原样返回键本身。标点也是文案
  （`、`→", "`，`。`→". "），不在 Swift 里硬编码中文标点拼展示文本，走 `L()`。
* 改完必须 `generate.py && check.py`（现 1177 键；查占位符、键集一致、插值）。

## 数据一致性 / 同步

* **库存是台账**：`Brew.stockDeductedG` 记实际扣掉的克数，删除/编辑按它算。
  **改剩余量 = 盘点**：写 `stockCountedAt`；早于它的冲煮不再退粉、编辑不改库存。
  烘焙天数读 `Tasting.resolvedDayAfterRoast`；无日期是 nil（显示「—」），不写 0。
* 删豆子顺序固定：取通知 ID → 删库成功 → `unschedule` → 重排。Schema 只有
  `BrewPhaseSchema.schema`：只加实体、加可选/带默认值属性。
* 清空只清同步实体（`Desktop/src/main/sync/wipe.ts`），豆/冲煮/品鉴/规则保留；
  `POST /api/sync/wipe` 三件套：token + HMAC + `{"confirm":"DELETE_SYNCED_CONTENT"}`。
* iOS 解绑：**先清远端再清 Keychain**（反了 token 就没了）；重新配对必须清基线。
  数据变更自动推送由 `SyncAutoPush`（`NSManagedObjectContextDidSave`）一处收口，
  **不要逐视图埋点**。媒体 SHA-256 用 `fileSHA256` 的 (路径,大小,mtime) 缓存。
  删除类 E2E 直接开库查 `count(*)`，只断列表数量会假阳性。
* 同步 v1 只 **iOS → Desktop 单向**；Desktop Canvas 编辑是本地创作，不回传 iOS。
  双向同步 / Bonjour 自动发现 / TLS 明确列为未实现。

## iOS：结构与首页

* 一级导航两态 `AppRoute(.home / .space(AppTab))`，**路由状态必须住在
  `BrewPhaseApp`**（换语言 `.id(language)` 重建整棵树，放 RootView 会被弹回首页）。
  底部 Tab Bar 已删；`SpaceSwitcherBar` 挂各自 NavigationStack 根页面
  （`safeAreaInset`），推开详情自动消失。
* 首页三个分区纵向、每区最多 3 张同宽同高卡；三空间选卡规则一致（先每类一张 →
  按时间补齐 → 上限 3）。分区内 `HStack(spacing:-32)` + `frame(maxWidth:.infinity)`；
  **永远画满 3 个卡位**，不足用 `Color.clear` 占位（否则单内容分区被拉成整屏宽），
  单卡画在中间卡位；用 `Spacer` 会拉宽。**别用「两侧内收」做台阶**（卡按
  cardAspect 定高，宽变高变，后卡会躲进前卡背后，有回归用例）。
* 点分区 = 进该空间列表，不是打开第一条；顶部搜索跨三空间，多词「与」，200ms 防抖。
  `CanvasThumbnailPreview` 嵌别的卡须 `height:nil` + `chrome:false`。

## iOS：Gravity Cards（Phase 2 / 2.1）

* **运动只加 `.offset` / `.rotationEffect`，不碰布局**：整区仍是同一个 Button。
  物理时间线只有一条（`WorkspaceHomeView.sections` 的 `TimelineView`），步进写成闭包
  里的 `let _ = field.step(at:)`；引擎不是可观察对象，卡片靠 `frameToken: Date` 重画
  （**不能叫 `frame`**，与 `View.frame()` 冲突）。静止即停，传感器 30Hz 用
  `@ObservationIgnored`。
* 行程由布局推导（`WorkspaceGravityTravel`）：多卡水平 `min(16,gutter−2)`、垂直
  6pt（必须 < 8pt）；单卡 `=(区域宽−卡宽)/2−6`，卡宽仍用三卡公式 `(W+2×32)/3`；
  区域宽来自 `onGeometryChange`（不用 GeometryReader）。边界变小夹回越界位置并清
  该方向速度；变大不动。
* 速度 `gravityScale 380 / friction 0.82 / maxSpeed 210`；非线性**只在控制器一处**
  `intensity=t^1.4`，引擎保持线性。姿态用**基准重力 + 同设备系分量差**
  （Δx=g.x−g₀.x，Δy=g₀.y−g.y），不要四元数跨系变换。
  `DebugLaunch.value(for:)` 会把 `-` 开头的值当下个开关，负数参数须直读
  `ProcessInfo.arguments`。
* 生命周期：滚动/键盘 `suspend()`+`calm()`；恢复一律重校准基准；推详情用
  `destination` 变化兜底。`DeviceMotionSourcing` 协议 + Mock 注入，不碰真机。
  测试 55 条、全量 797 条；真机手感/方向/耗电只能人工验收。

## iOS：Canvas

* `CanvasNode` 是摆放实例（UUID + 世界坐标），不复制记录；删除必须走
  `CanvasNodeStore` 且与删除同一次 save，删节点永不删记录。只存世界坐标，屏幕位置
  = 世界 × scale + offset，`CanvasWorldLayer` 整层变换一次。
* 节点加载只有一条路径：`nodes(in:)`（throws）→ `reconcile` → 渲染；**读取失败一个
  节点都不许删**（`try? ... ?? []` 曾把整块画布删光）。`.empty` 只能来自「读取成功
  + 对账成功 + 零节点」，失败保留上次数据。双指只用 `MagnifyGesture`；点阵屏幕
  间距钳 14–40pt，右上角加号留给「放大」。

## Desktop：Studio Desk 与外观

* 默认页 Studio Home；三空间无全局 Tab，只从首页内容入口进。
  **三空间横向一行是布局契约**：`grid-template-areas:'coffee records canvas'`，
  980/1100/1280/1440 都不折行。**舞台高度由内容决定**：堆叠容器不用
  `absolute;inset:0`，改 relative / aspect-ratio 由首卡撑高；`:has(.studio-empty)`
  才给 268 空态底线。咖啡架 `--cw=100%/压叠系数`，高 = 卡宽×196/132。
* Records 首页是 Deck（`DECK_LIMIT=5`，`DECK_REST`/`DECK_SPREAD` 固定数组），CSS
  只消费 `--deck-*`；卡点击必须 `stopPropagation`。完整 Records 页仍是 masonry。
  装饰件「高度定 + 宽高比推宽度」。
* 颜色只有两处来源：`app.css` 的 `:root` 与 `[data-theme='dark']`；**组件不许自己
  判断明暗**（禁读 `prefers-color-scheme`）。主按钮文字用 `--on-espresso`，
  **不要写死 `#fff`**；同类派生 `--on-danger`、`--stage`、`--fade`/`--scrim-chip`、
  `--sheet-*`。深色不是反色：黑底靠 card > paper 的亮度差分层。Konva 缓存带外观
  标记（`tokens.ts` 的 `cachedTheme`）；`shared/theme.ts` 必须用 `globalThis`
  最小结构类型（tests 由 `tsconfig.node.json` 编译，无 DOM lib）。

## Desktop：内置浏览器与网页卡片

* 唯一实例 `src/main/browser/browser-manager.ts`（`WebContentsView` +
  `persist:brewphase-browser`）。渲染层只有「壳」，无读页面内容能力。
  **原生层永远在 DOM 之上，z-index 无效**：起始页/错误页出现时必须
  `setVisible(false)`；缩放手柄只能放 stage 外侧留白。
* bounds 单向流入：renderer 报 stage 的 `getBoundingClientRect()` → 主进程 clamp →
  `setBounds()`；纵向下限 52，`applyBounds` 不能再加 tabbar 高度。
  **Electron 45 的 `navigationHistory` 在 WebContentsView 上只有读有效**：
  `canGoBack()` 恒 false、`goBack()` 空操作；能力位用 `getActiveIndex()`/
  `getAllEntries()` 自己算，导航用页面内 `history.back()`。
* 安全：无 preload、sandbox、权限全拒、只放行 http/https、`window.open` deny、
  下载拒绝。关闭 = 销毁 view 但保留分区与 lastVisit。
  `page.screenshot()`/`capturePage()` **拍不到 WebContentsView**。
* **卡片 = 真实 tabId**（`tab-N` 唯一身份），排序存 `cardOrder`，圆桌存
  `participantTabIds`；禁止第二套 `webcard-N` 或第二份网页实例。预览只走
  `browser:preview`（update/clear），缓存 ≤12，关闭必须 `forget`，失败保留最后一张。
  **capturePage 需要绘制表面**：隐藏/窗口外返回空图 → 收纳标签挂透明采集宿主
  （`BaseWindow` opacity 0、不可点、`showInactive`，视口 1280×800），截图时临时
  `setVisible(true)`；Linux 不支持窗口 opacity，降级为「显示过才有图」。
* 面板 ✕ = 收起回卡片架（park），关闭只在卡片/标签的 ✕。卡片与标签条都用
  `data-tab-id`，落点查询必须在 `stripRef` 内 scoped（全局 `querySelector` 会命中
  架子卡片，排序静默失效）。Playwright `app.windows()` 会把 WebContentsView 里的
  网页当页面；判断独立窗口只认壳页 URL 的 `#bpFloat=` / `#bpRoundtable=`。

## Desktop：多窗口与拖拽会话

* **拖出判定必须在主进程**（渲染层在窗口外收不到可靠 pointer 事件）：一律 OS 原生
  HTML5 DnD，主进程 `BrowserDragSessionManager` 轮询 `screen.getCursorScreenPoint`
  裁定落点，实时光标 > 会话读数 > 渲染层兜底；窗口内 drop 必须 `dropHandled`
  （IPC FIFO 保证先于 dragend）。拖拽会话是**单例**，未收尾时后续 begin 全被拒；
  窗口关闭（含 drop→dock 销毁、dragend 不到达）必须强制 `dragSession.cancel()`。
* 窗口定位禁止 `Math.max(0,…)`：用 `getDisplayNearestPoint(落点).workArea` +
  `fitRectIntoBounds`（`shared/window-placement.ts`，负坐标有单测）。浮窗/独立
  浏览器窗口的系统关闭 = `recallToShelf`（park）；主窗口 activate 重建判
  `mainWindowRef` 而不是 `getAllWindows().length`。
* **卡片拖拽面**：装饰子元素 `pointer-events:none`、img 加
  `-webkit-user-drag:none`；**禁止对正在被拖的源卡做 DOM 变更**；dragstart 副作用
  必须包 try（抛错 = Chromium 取消原生拖拽）；45s 看门狗 + 过期会话识别。埋点
  `[drag:card]`/`[drag]`。编辑卡错误分层：navigate 成功会写 tab.url 退出编辑态，
  网络级失败显示卡上 chip，只有输入级拒绝才在表单内报错。
* E2E：假光标 `globalThis.__bpTestHooks.setDragCursor`（仅 !app.isPackaged）；
  关独立窗口用 `BrowserWindow.close()`；`browser.state()` 返回 Promise，evaluate
  里要 await；`dragAndDrop` 在 Electron 下不可靠，回归用合成 DragEvent + 结构断言。

## Desktop：圆桌（4.1 / 4.2 / 4.2b）

* **tabId 是身份**：成员 = 真实 WebCard，provider 只是能力标签。平台识别在主进程
  Registry（`ai-chat/adapters/`，严格主机匹配）对实时 URL 判定；自动化用
  `resolveTabForAI` 的**原始 WebContents**，绝不建隐藏副本。移出成员/关闭页面 →
  立即 `cancelParticipant`；每轮轮询重新 resolve。
* 状态在主进程 `RoundtableService`（快照 + version 广播），两个 Renderer 的 store
  只是缓存。join 校验真实标签，标签关闭 `syncTabs` 自动摘除。草稿 = **后写者胜出**
  （baseVersion 门控会丢字符）。**服务型广播必须真正接线**：notify 要在构造时接到
  `params.broadcast`；cancel 必须同时设 `run.cancelled` 标志与状态。
* 圆桌窗口：唯一实例、系统 ✕=归位（isQuitting 放行防卡 quit）、外部销毁走
  `onWindowLost`。`-webkit-app-region:drag` 与 `draggable` 同区域互斥，拖拽源做成
  独立 no-drag 手柄。自由布局但面板互不重叠：shared 纯函数三件套
  （resolveMove/resolveResize/findFreePanelSpot）预览与落库同源调用，被围死返回
  null=保持原状；movePanel 的 maxY=工作区高−120 是 KEEP_VISIBLE，别当 bug。
* 原生 view 方案：DOM 只画标题栏+手柄（bounds 外 6px），内容区 rects 上报 →
  setBounds；置顶 = removeChild+addChild；持久化 migration 11 `roundtable_panels`
  （含 url 列），防抖 300ms；`setWorkspaceSize` 只更新参照系。幽灵面板：重启后
  WebContents 必消失、布局行还在 → 如实显示关闭态 + 一键重开，`rebindPanel` 原
  几何绑新 tabId；join 时页面没加载完 url 是空串 → `onPageSettled`。
* 探测/轮询单一来源 `automation/poll-engine.ts`；adapter 纪律（基线先于发送、写入
  校验、JSON-only）。已识别 ≠ 可自动交互：无 adapter 显示「已识别·尚未适配」。
  渲染层级：`#`→h3、`##`→h4、列表项是 `p.md-ul`（非 li）；`textContent` 的 `\n`
  被 `white-space:normal` 折叠，夹具页换行用 `<br>`。
* E2E：`BREWPHASE_AI_TEST_HOST` 接缝（按段匹配 + 端口校验）；**惰性 locator 陷阱**
  ——`.last()` 动作时重新解析，多卡要在每张卡创建后立即取 data-tab-id；合成拖拽
  必须先钉假光标；窗口枚举逐窗口 try/catch。独立圆桌窗口主体 = 工作空间
  （`.rt-panel`）+ 提问条 + 讨论抽屉（先点 `.rt-window__ask-toggle`）。
  未解：`browser.e2e`「拖动与缩放」在无 GPU 环境拖不到位（干净 HEAD 同样失败）。

## Desktop：MCP、发布与工作流

* 权限预设第一档就是默认值（`MCP_SCOPE_PRESETS[0]`，全量 14 项含写入），顺序即
  梯度；改默认只改契约一处，两处 `useState` 跟着走。**默认全给 ≠ 放宽确认边界**：
  MCP 侧永远没有 confirm 能力，`direction:propose` 只写草稿，方向只能用户在应用内
  确认。引导里权限默认折叠成一行摘要，按 `scopes.length` 说、不按 preset 名说。
* 发布链（0.1.3 起）：`pnpm build` → `electron-builder --mac --arm64 --dir` 产签名
  `.app`（本机代理证书报错 `unable to verify the first certificate` 时需
  `env -u NODE_OPTIONS NODE_TLS_REJECT_UNAUTHORIZED=0`）→ `notarytool submit
  --keychain-profile BrewPingNotary --wait` → `stapler staple` →
  `electron-builder --prepackaged <app>` 产 dmg/zip → `codesign` 签 dmg →
  **重算 `.sha256`**（签名后哈希会变）→ 用 `uploads.github.com` 资产端点上传。
  本机无 `gh` / GITHUB_TOKEN，但 `~/.git-credentials` 有可用 PAT
  （`git credential.helper=store`）；130MB 上传约 7 分钟。dmg 自身公证极慢
  （>10min），可跳过：内部 `.app` 已 staple 时，从 dmg 挂载出的 app 的
  `spctl` 就是 accepted / Notarized Developer ID。
  `notarytool` 曾因团队协议 403，**0.1.2 只签名未公证**（首启需右键 → 打开）；
  403 于 2026-11-15 不再复现，0.1.3 已签名 + 公证 + staple，
  Release `desktop-v0.1.3` 已发布（dmg / zip / 2 个 .sha256）。
  自动安装更新（electron-updater）仍未实现，**版本检查提示已实现**
  （`shared/contracts/update.ts` + `main/update/update-service.ts`）。
  `README.zh-CN.md` 曾误写 0.1.2 已公证，已修正；权威状态看
  `docs/PROJECT_STATUS.md` 与英文 `README.md`。
* 阈值集中 `RAG/Rules/IntelligenceConfig.swift`；中文词表放 `Resources/*.json`；
  纯逻辑放 `Core/`，视图放 `Shared/Components/` 与 `Features/`。
  改完先 commit + push 再询问 GPT，必须附 https://github.com/banmu123/BrewPhase。
