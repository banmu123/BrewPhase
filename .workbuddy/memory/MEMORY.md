# BrewPhase 长期约定（压缩索引）

细节见 `YYYY-MM-DD.md` 日志与代码注释。CoffeeAI×ChatGPT 交接权威：`Tools/CoffeeAI/review_queue/GPT_WORKFLOW.md`。

## 环境 / 构建 / Git

* iOS 必须 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`；通过判据 = 末行 `** TEST SUCCEEDED **` 且无 `Fatal error`（崩溃后 runner 重启，分段统计会误判）；基线 797 条（3 条跨端同步按设计跳过）。单测 `setUp` 必须 `pinForTesting(.simplifiedChinese)`；截图与 `xcodebuild test` 不同时跑。
* `Tools/run.sh --demo` 应用在跑时忽略参数：先 `simctl terminate`；传参用 `"$@"`；重装常新建容器要重灌示例；输入态 `-BrewPhaseXxx`。残留 `sync-harness.json` 会让 SyncCrossEndTests 失败而非 XCTSkip。
* Desktop dev：`env -u ELECTRON_RUN_AS_NODE npx electron-vite dev --noSandbox`；`pnpm e2e` 前必须停 dev（单实例锁）。无 GPU 时遮挡帧被节流，`element is not stable` 不是产品 bug：关 transition、`elementFromPoint`、必要时 `force`。
* **push（mac）**：hosts 已不劫持 github，元凶是环境代理 `127.0.0.1:62371`（502/CONNECT）。可用：`HTTPS_PROXY=http://127.0.0.1:7900 HTTP_PROXY=http://127.0.0.1:7900 NO_PROXY=127.0.0.1,localhost git push`。`credential storage lock` 仅告警。打包公证加 `-u NODE_OPTIONS NODE_TLS_REJECT_UNAUTHORIZED=0`。
* **push（czk win）**：`git -c http.sslVerify=false -c http.version=HTTP/1.1 push`（schannel 吊销检查关不掉）。

## 本地化 `Tools/Localization/`

* 键 = 源码中文串（含标点），表里没有就原样返回；不在 Swift 里拼中文标点，走 `L()`。改完必须 `generate.py && check.py`（1177 键）。

## 数据一致性 / 同步

* 库存是台账：`Brew.stockDeductedG`；改剩余量=盘点（写 `stockCountedAt`，更早的冲煮不退粉）。烘焙天数读 `Tasting.resolvedDayAfterRoast`，无日期 nil 显示「—」不写 0。
* Schema 只有 `BrewPhaseSchema.schema`，只加实体/可选或有默认值属性。删豆子：取通知 ID → 删库成功 → `unschedule` → 重排。
* 清空只清同步实体（`Desktop/src/main/sync/wipe.ts`）；`POST /api/sync/wipe` = token + HMAC + `{"confirm":"DELETE_SYNCED_CONTENT"}`。
* iOS 解绑**先清远端再清 Keychain**；重新配对清基线。自动推送收口在 `SyncAutoPush`，不要逐视图埋点。媒体 SHA-256 用 `fileSHA256` 的 (路径,大小,mtime) 缓存。
* 同步 v1 只 **iOS → Desktop 单向**；Desktop Canvas 编辑不回传；双向同步 / Bonjour / TLS 未实现。

## iOS：结构与首页

* 路由两态 `AppRoute(.home/.space)`，**状态必须住在 `BrewPhaseApp`**（换语言 `.id(language)` 重建树）。无底部 Tab；`SpaceSwitcherBar` 挂各 NavigationStack 根（`safeAreaInset`）。
* 首页三分区，每区最多 3 张同宽同高卡；`HStack(spacing:-32)`，**永远画满 3 个卡位**（不足 `Color.clear`，否则单卡分区拉满屏），单卡画中间位。**别用「两侧内收」做台阶**（有回归用例）。
* 点分区=进该空间列表；搜索跨三空间，多词「与」，200ms 防抖。

## iOS：Gravity Cards

* 运动只加 `.offset`/`.rotationEffect`，不碰布局。时间线唯一（`WorkspaceHomeView` 的 `TimelineView`），步进 `let _ = field.step(at:)`；卡片靠 `frameToken: Date` 重画（**不能叫 `frame`**）。静止即停，传感器 30Hz `@ObservationIgnored`。
* 行程由布局推导 `WorkspaceGravityTravel`（多卡水平 `min(16,gutter−2)`、垂直 6；单卡 `(宽−卡宽)/2−6`）；区域变小夹回并清速度。非线性只在控制器（`t^1.4`）。姿态用基准重力+同设备系分量差，不用四元数。滚动/键盘 `suspend()`+`calm()`，恢复必重校准。

## iOS：Canvas

* `CanvasNode` 是摆放实例（UUID + 世界坐标），不复制记录；删除必须走 `CanvasNodeStore` 且与删除同一次 save。屏幕位置 = 世界×scale+offset。
* 节点加载唯一路径：`nodes(in:)`(throws) → `reconcile` → 渲染；**读取失败一个节点都不许删**（`try? ?? []` 曾删光画布）。双指只用 `MagnifyGesture`。

## Cloud 本地联调 `cloud/`

* `.env` 必须经 `src/env-file.ts`（进程环境优先、production 跳过、不打印内容），新入口都要调用。
* `BASE_URL` 决定 Provider 回调，必须与控制台登记逐字符一致（`localhost`≠`127.0.0.1`）；Desktop 回调固定 `http://127.0.0.1:<port>/callback`。
* 本机 3000 常被 `/Users/banmu/productPage` 占用（**不要杀**）；验证用 `PORT=3100 BASE_URL=http://127.0.0.1:3100 pnpm dev`。
* **Node 直连 Google 不通**（token/JWKS timeout），GitHub 正常；系统代理 7900 对 Google 可用但 Node env-proxy 不行。本地 DB `brewphase-cloud-pg`(5432)，测试 `brewphase-cloud-test-pg`(54329)；迁移幂等。
* Provider 出网走 `src/net/proxy-fetch.ts`（自建 CONNECT，**不用** Node env-proxy——那套在 7900 下全超时）。

## Desktop：Cloud 账号（`src/main/account/`）

* 服务端 `isValidLocalCallbackUri` 只认 `http://127.0.0.1:<port>/callback`：必须起一次性回环 HTTP 服务，**没有深链**，也别碰 `brewphase://pair`。
* 四个模块分工：`credentials.ts`（safeStorage 密文，外层只有 version/alg/payload；加密不可用则拒绝落盘，绝不退化明文）／`oauth-callback-server.ts`（只 `GET /callback`、Host 必须 `127.0.0.1:<port>` 防 rebinding、state 常量时间比对且不匹配继续等）／`cloud-client.ts`（注入 FetchLike、AbortController 超时、`redirect:'manual'`）／`account-service.ts`（唯一状态机：generation 丢弃过期异步结果、refresh 单飞、**网络失败 ≠ 会话失效**，只有 401 才清凭据）。
* 凭据放 `userData/account/`（不是业务数据目录，换数据目录不复制）；本地库零新增表。`signOut()` 先清本地再尽力撤销服务端。
* IPC：`account:status/login/cancel-login/refresh/sign-out` + `account:changed`；`login` 只收 provider 名，没有「提交 code/token」通道。

## Desktop：Studio Desk / 外观

* 三空间横向一行是布局契约（`grid-template-areas:'coffee records canvas'`，980–1440 不折行）。舞台高由内容决定（不用 `absolute;inset:0`）；`:has(.studio-empty)` 才给 268 空态。咖啡架高 = 卡宽×196/132。
* Records 首页 Deck（`DECK_LIMIT=5`），CSS 只消费 `--deck-*`；卡点击必须 `stopPropagation`。
* 颜色只有 `app.css` 的 `:root` / `[data-theme='dark']` 两处；组件禁判明暗。主按钮用 `--on-espresso`，**不写死 `#fff`**；同类派生 `--on-danger`、`--stage`、`--fade`/`--scrim-chip`、`--sheet-*`。

## Desktop：内置浏览器 / 网页卡片

* 唯一实例 `browser-manager.ts`（`WebContentsView` + `persist:brewphase-browser`）。**原生层永远在 DOM 之上，z-index 无效**：起始页/错误页必须 `setVisible(false)`。
* bounds 单向：renderer 报 stage rect → 主进程 clamp → `setBounds()`（纵向下限 52）。**Electron 45 的 `navigationHistory` 在 WebContentsView 上只有读有效**（`canGoBack` 恒 false），导航用页面内 `history.back()`。
* 安全：无 preload、sandbox、权限全拒、只放行 http/https、`window.open` deny、下载拒绝。`capturePage()` **拍不到 WebContentsView**。
* **卡片 = 真实 tabId**，排序 `cardOrder`，圆桌 `participantTabIds`；禁止第二套 `webcard-N`。预览只走 `browser:preview`，缓存 ≤12，关闭 `forget`。**截图需要绘制表面**：收纳标签挂透明采集宿主（`showInactive` 1280×800）。
* 面板 ✕ = 收起（park），关闭只在卡片/标签 ✕。落点查询必须 `stripRef` 内 scoped（全局 querySelector 会命中架子卡，排序静默失效）。独立窗口只认壳页 `#bpFloat=` / `#bpRoundtable=`。

## Desktop：多窗口 / 拖拽

* **拖出判定必须在主进程**：`BrowserDragSessionManager` 轮询 `screen.getCursorScreenPoint`；窗口内 drop 必须 `dropHandled`。会话单例，窗口关闭必须 `dragSession.cancel()`。
* 窗口定位禁 `Math.max(0,…)`：用 `getDisplayNearestPoint(落点).workArea` + `fitRectIntoBounds`。系统关闭 = `recallToShelf`。
* 卡片拖拽面：装饰子元素 `pointer-events:none`、img `-webkit-user-drag:none`；禁止对源卡做 DOM 变更；dragstart 副作用包 try（抛错=取消拖拽）。
* E2E：假光标 `__bpTestHooks.setDragCursor`（仅 !isPackaged）；`dragAndDrop` 不可靠，用合成 DragEvent。

## Desktop：圆桌

* **tabId 是身份**，provider 只是能力标签；平台识别在主进程 Registry。自动化用 `resolveTabForAI` 的原始 WebContents，绝不建隐藏副本。移出成员/关页 → `cancelParticipant`；每轮重新 resolve。
* 状态在主进程 `RoundtableService`（快照+version 广播），Renderer store 只是缓存。草稿 = 后写者胜出。服务型广播必须真正接线（notify 在构造时接 `params.broadcast`）。
* 圆桌窗口：唯一实例、系统 ✕=归位、外部销毁走 `onWindowLost`；`-webkit-app-region:drag` 与 `draggable` 互斥，拖拽源做独立 no-drag 手柄。面板不重叠：shared 纯函数三件套预览与落库同源，被围死返回 null。原生 view 只画标题栏+手柄，rects 上报 → setBounds；持久化 migration 11 `roundtable_panels`。幽灵面板：显示关闭态 + 一键重开 `rebindPanel`；join 时 url 空 → `onPageSettled`。
* 探测单一来源 `poll-engine.ts`；渲染层级：`#`→h3、`##`→h4、列表项 `p.md-ul`；夹具换行用 `<br>`（`\n` 被折叠）。
* E2E：`BREWPHASE_AI_TEST_HOST` 接缝；**惰性 locator 陷阱**——多卡要在每张卡创建后立即取 data-tab-id。

## Desktop：工作区 / 回复智能

* 每张 AI 卡工作区在右侧竖栏（`CardWorkspaceToolbar.tsx`）；契约 `shared/contracts/local-workspace.ts`、`reply-intelligence.ts`。回复智能是本地分类 + 草稿，草稿只在应用内确认，不经 MCP 写回。

## Desktop：MCP / 发布

* 权限预设 `MCP_SCOPE_PRESETS[0]`（14 项含写入）即默认值，顺序即梯度；改默认只改契约一处。**默认全给 ≠ 放宽确认边界**：MCP 无 confirm 能力。
* 发布链：`pnpm build` → `electron-builder --mac --arm64 --dir` → `notarytool submit --keychain-profile BrewPingNotary --wait` → `stapler staple` → `--prepackaged` 产 dmg/zip → `codesign` dmg → **重算 `.sha256`** → API 建 release。**公证/签名必须临时关系统代理**（`networksetup -set*proxystate Wi-Fi off` + `trap` 恢复）。
* **uploads.github.com 真实 IP `20.205.243.161`**（140.82.x.x 是 web 前端会 301）；本机无 `gh`，用 `~/.git-credentials` 的 PAT。dmg 公证可跳过（内部 app 已 staple）。
* 阈值集中 `RAG/Rules/IntelligenceConfig.swift`；中文词表 `Resources/*.json`；纯逻辑 `Core/`，视图 `Shared/Components/`、`Features/`。
