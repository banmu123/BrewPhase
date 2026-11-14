# BrewPhase 项目长期约定

跨会话硬规则。日常流水在 `YYYY-MM-DD.md`；CoffeeAI×ChatGPT 交接看
`Tools/CoffeeAI/review_queue/GPT_WORKFLOW.md`（唯一权威）。

## 构建与测试

* iOS 全量：`xcodebuild test` + 模拟器 `C7C7F583-310C-43CE-B6ED-D4915F465154`；
  `grep "Fatal error"` 必须为空且末行是 `** TEST SUCCEEDED **`（进程崩溃会被
  runner 重启，分段统计会误判）。当前基线 625 条。
* 单测 `setUp` 必须 `LanguageManager.pinForTesting(.simplifiedChinese)`。
* 截图与 `xcodebuild test` 不能同时跑（测试宿主抢模拟器）。
* Desktop dev：`env -u ELECTRON_RUN_AS_NODE npx electron-vite dev --noSandbox`。
* Desktop `pnpm e2e` 前必须停 dev：真实 userData 的单实例锁会让新实例直接退出。
* 无 GPU 的 Electron 被遮挡时**帧会被节流**：Playwright `element is not stable`
  超时不是产品 bug；断言前 `addStyleTag` 关 transition，做 `elementFromPoint`
  命中测试，必要时 `click({force:true})`。

## 本地化（`Tools/Localization/`）

* 键 = 源码里的中文字面量；**表里没有的键运行时原样返回键本身**。
* 标点也是文案（`、`→`", "`，`。`→`". "`）。不要在 Swift 里硬编码中文标点拼展示
  文本，走 `L()`；落点是 `DocumentBuilder` / `BeanKnowledgeInsight` / `DiagnosticResult`。
* 改完必须 `generate.py && check.py`（1068 键；查占位符、键集一致、插值不可翻译）。

## 数据一致性

* **库存是台账**：`Brew.stockDeductedG` 记实际扣掉的克数，删除/编辑按它算。
* **改剩余量 = 盘点**：写 `stockCountedAt`；早于它的冲煮不再退粉、编辑不改库存。
* 烘焙天数读 `Tasting.resolvedDayAfterRoast`；没有烘焙日期是 nil（显示「—」），不写 0。
* 删豆子顺序固定：取通知 ID → 删库成功 → `unschedule` → 重排。
* Schema 只有 `BrewPhaseSchema.schema`：只加实体、加可选/带默认值属性。

## 同步

* 清空只清同步实体（`Desktop/src/main/sync/wipe.ts`）；豆子/冲煮/品鉴/阶段规则保留。
* `POST /api/sync/wipe` 三件套：token + HMAC + `{"confirm":"DELETE_SYNCED_CONTENT"}`。
* iOS 解绑：**先清远端再清 Keychain**（反了 token 就没了）。
* 重新配对必须清基线，否则首次只发增量。
* 数据变更自动推送由 `SyncAutoPush`（`NSManagedObjectContextDidSave`）一处收口，
  **不要逐视图埋点**。媒体 SHA-256 必须走 `fileSHA256` 的 (路径,大小,mtime) 缓存。
* 删除类 E2E 直接开库查 `count(*)`，只断列表数量会假阳性。

## Desktop：Studio Desk

* 默认页 Studio Home；三空间无全局 Tab，只从首页内容入口进。
* **三空间横向一行是布局契约**：`grid-template-areas: 'coffee records canvas'`，
  980 / 1100 / 1280 / 1440 都不折行、不溢出。别再加回两列两行或 canvas 缩进。
* **舞台高度由内容决定**（Phase 1.3）：三个堆叠容器不再 `absolute; inset:0`，
  改为 relative / aspect-ratio 并由第一张卡撑高；`:has(.studio-empty)` 才给 268 的
  空态底线。曾经固定 286 的结果是咖啡上方空 169px、记录下方空 160px。
  咖啡架按 `--cw = 100%/压叠系数` 铺满列宽，高度 = 卡宽×196/132。
* Records 首页是 **Deck**（`DECK_LIMIT=5`，`DECK_REST`/`DECK_SPREAD` 固定数组），
  CSS 只消费 `--deck-*`；卡片点击必须 `stopPropagation`，否则被外层「进入空间」抢走。
  完整 Records 页仍是 masonry，两者不互相替代。
* 三个空状态各一个组件（`empty-states.tsx`），入口只调 `requestCreate`；
  装饰件「高度定 + 宽高比推宽度」，否则窄窗向上溢出压住标题。

## Desktop：外观（浅色 / 深色）

* 颜色只有两处来源：`app.css` 的 `:root` 与 `[data-theme='dark']`；**组件不许
  自己判断明暗**（不许读 `prefers-color-scheme`），否则必然半深半浅。
* 主按钮文字是 `--on-espresso`，**不要写死 `#fff`**：深色下 espresso 翻转成
  暖亮色，白字会消失。同类派生变量：`--on-danger`、`--stage`（永远深底）、
  `--fade` / `--scrim-chip`（压图上的渐隐与圆钮）、`--sheet-*`（纸面）。
* 深色不是反色：浅色靠投影分层，黑底投影看不见，改成 card > paper 的亮度差。
* Konva 缓存自带外观标记（`tokens.ts` 的 `cachedTheme`），切主题自动失效；
  调用点不要再手动 `refreshThemeColors()` 之外加逻辑。
* `shared/theme.ts` 必须用 `globalThis` 最小结构类型，不能用 `document` /
  `MediaQueryListEvent`——tests 被 `tsconfig.node.json` 编译，那里没有 DOM lib。

## Desktop：内置浏览器（Phase 1）

* 唯一实例 `src/main/browser/browser-manager.ts`（`WebContentsView` +
  `persist:brewphase-browser`）。渲染层只有「壳」，没有任何读页面内容的能力。
* **原生层永远在 DOM 之上，z-index 无效**：起始页/错误页出现时必须
  `setVisible(false)`；缩放手柄只能放在 stage 外侧的留白里。
* bounds 单向流入：renderer 报 stage 的 `getBoundingClientRect()` → 主进程 clamp
  → `setBounds()`。纵向下限 52（不盖顶栏）。
* **Electron 45 的 `navigationHistory` 在 WebContentsView 上只有「读」有效**：
  `canGoBack()` 恒 false、`goBack()` 是空操作。能力位用
  `getActiveIndex()`/`getAllEntries()` 自己算，导航用页面内 `history.back()`。
* 安全：无 preload、sandbox、权限全拒、只放行 http/https、`window.open` deny、
  下载拒绝。初始页不预建 view；关闭 = 销毁 view 但保留分区与 lastVisit。
* `page.screenshot()` / `webContents.capturePage()` **拍不到 WebContentsView**，
  只能对浏览器自己的 webContents 单独截图。

## Canvas

* `CanvasNode` 是摆放实例（UUID + 世界坐标），不复制记录；删除必须走
  `CanvasNodeStore`，与删除同一次 save，删节点永不删记录。
* 只存世界坐标；屏幕位置 = 世界 × scale + offset，`CanvasWorldLayer` 整层变换一次。
* 节点加载只有一条路径：`nodes(in:)`（throws）→ `reconcile` → 渲染；
  **读取失败一个节点都不许删**（`try? ... ?? []` 曾把整块画布删光）。
* `.empty` 只能来自「读取成功 + 对账成功 + 零节点」；失败保留上一次数据。
* 双指只用 `MagnifyGesture`；换 UIKit 手势层会抢走捏合（真机实测）。
* 点阵屏幕间距钳 14–40pt，不能按比例隐藏；右上角加号必须留给「放大」。

## Desktop：MCP 与接入引导

* 权限预设第一档就是默认值（`MCP_SCOPE_PRESETS[0]`，全量 14 项含写入），
  顺序即梯度；改默认只改契约一处，两处 `useState` 都跟着走。
* **默认全给 ≠ 放宽确认边界**：MCP 侧永远没有 confirm 能力，
  `direction:propose` 只写草稿，方向只能用户在应用内确认。
* 引导里权限默认折叠成一行摘要，点「调整」才展开；摘要按 `scopes.length`
  说，不按 preset 名说（否则选「只看记录」还会显示「全部 14 项」）。
* `.onboarding__card--wide` 底部不留白，由 sticky 的 actions 自己撑（含顶部渐隐），
  否则内容一长主按钮就被顶出视口。

## Desktop：网页卡片（Phase 2）

* **卡片 = 真实 tabId**。`tab-N` 是唯一身份；排序存 `cardOrder`，圆桌存
  `participantTabIds`。禁止再出现第二套 `webcard-N` 或第二份网页实例。
* 预览只走 `browser:preview` 通道（update/clear），不搭在 `browser:changed`
  快照上；内存缓存 ≤12 张，标签关闭必须 `forget`，失败保留最后一张。
* **capturePage 需要绘制表面**：隐藏 / 窗口外的 WebContentsView 返回空图。
  收纳中的标签挂在透明采集宿主（`BaseWindow`，opacity 0、不可点、不抢焦点、
  `showInactive`）里，视口固定 1280×800；截图时临时 `setVisible(true)`。
  Linux 不支持窗口 opacity，宿主返回 null，预览降级为「显示过才有图」。
* 原生层对齐以渲染层上报的 **stage 矩形**为准，`applyBounds` 不能再加
  tabbar 高度（曾整体下沉 40px）。
* 浏览器面板 ✕ = **收起回到卡片架**（park），不是关闭；关闭只在卡片/标签的 ✕。
* 卡片与标签条都用 `data-tab-id`：任何落点查询必须 `stripRef` 内 scoped，
  全局 `querySelector` 会命中架子卡片，排序静默失效。
* Playwright `app.windows()` 会把 WebContentsView 里的网页也当页面返回；
  判断独立窗口只认壳页 URL 里的 `#bpFloat=`（圆桌同理 `#bpRoundtable=`）。
  `page.screenshot()` 拍不到原生网页。

## Desktop：多窗口与拖拽会话（Phase 3）

* **拖出判定必须在主进程**：渲染层在窗口外收不到可靠 pointer 事件（pointerup
  会丢、会话挂死），合成事件的 E2E 验证不了这一点。卡片/圆桌拖拽一律用 OS
  原生 HTML5 DnD（dragend 必达、OS 拖影窗口外可见），主进程
  `BrowserDragSessionManager` 轮询 `screen.getCursorScreenPoint` 裁定松手位置：
  实时光标 > 会话轮询读数 > 渲染层兜底坐标。窗口内 drop 必须 `dropHandled`
  （IPC FIFO 保证先于 dragend 到达主进程）。
* 拖拽会话是**单例**：会话未收尾时后续 begin 全被拒。窗口关闭（含圆桌窗口
  在 drop→dock 中销毁、dragend 永不到达）必须强制 `dragSession.cancel()`。
* 窗口定位禁止 `Math.max(0,…)`：用 `screen.getDisplayNearestPoint(落点).workArea`
  + `fitRectIntoBounds`（shared/window-placement.ts，负坐标有单测）。
* **圆桌状态在主进程** `RoundtableService`（快照 + version 广播）；两个 Renderer
  的 store 只是缓存。join 校验真实标签，标签关闭 `syncTabs` 自动摘除。
  草稿 = 后写者胜出：baseVersion 门控会因键击间隔 < IPC 往返而丢字符。
* 圆桌窗口：唯一实例（重复 detach 只聚焦）、系统 ✕=归位（isQuitting 放行防
  卡 quit）、外部销毁走 `onWindowLost` 兜底归位。`-webkit-app-region: drag`
  与 `draggable` 同区域互斥——拖拽源必须做成独立的 no-drag 手柄。
* 浮窗/独立浏览器窗口的系统关闭 = `recallToShelf`（park，不开 BrowserPanel）；
  主窗口 activate 重建判 `mainWindowRef` 而不是 `getAllWindows().length`
  （圆桌窗口活着时后者非 0）。
* E2E 假光标钩子：`globalThis.__bpTestHooks.setDragCursor`（仅 !app.isPackaged
  注入）；Playwright 关独立窗口要用 `BrowserWindow.close()`（page.close() 可能
  绕过 'close' 事件）。`browser.state()` 返回 Promise，evaluate 里要 await。
* **卡片拖拽面**（3.4）：装饰子元素（缩略图/占位/meta/握把）一律
  `pointer-events: none`、img 加 `-webkit-user-drag: none`——拖拽目标必须是
  卡片本体；**禁止对正在被拖动的源卡片做 DOM 变更**（data-insert 会话中断
  嫌疑）；dragstart 副作用必须包 try（抛错 = Chromium 取消原生拖拽）；
  会话有 45s 看门狗 + 过期会话识别（`end(fallback, expectedTabId)` 不匹配
  只取消）。链路埋点：渲染层 `[drag:card]`、主进程 `[drag]`。
* 编辑卡错误分层：navigate 成功会写 tab.url 使卡片退出编辑态——网络级失败
  显示在卡片上（加载失败 chip），只有输入级拒绝（协议拦截、url 仍空）才在
  表单内显示错误行。Playwright `dragAndDrop` 在 Electron 下不可靠，拖拽回归
  用合成 DragEvent + 结构断言，真实鼠标走人工清单。

## Desktop：圆桌 Multi-AI 问答（Phase 4.1 / 4.2）

* **4.2 起 tabId 是身份**：圆桌成员 = 真实 WebCard（participantTabIds），provider 只是
  能力标签。Renderer 只传 tabId；平台识别在主进程 Registry（`ai-chat/adapters/`，
  严格主机匹配）对实时 URL 判定；自动化用 `BrowserManager.resolveTabForAI` 解析的
  **原始 WebContents**——绝不建隐藏副本（AgentPageManager 仅遗留栈使用）。
* 探测/轮询算法单一来源：`automation/poll-engine.ts`；adapter 提交纪律不变（基线
  先于发送、写入校验、JSON-only）。已识别 ≠ 可自动交互：无 adapter 的描述符
  （Gemini 等）显示「已识别·尚未适配」，绝不假装可提问。
* 极简 Markdown 渲染层级：`#`→h3、`##`→h4、列表项是 `p.md-ul`（非 li）；断言别按
  标准 HTML 层级。innerText 陷阱：textContent 里的 `\n` 被 white-space:normal
  折叠成空格——夹具页构造换行要用 `<br>`。
* 持久化按 **tabId** 去重；metadata = `{ note, url, tabId, displayName }`；provider 列
  存平台 id（旧记录兼容，无 schema 变更）。
* **服务型广播必须真正接线**：ParticipantService 的 notify 要在构造时接到
  params.broadcast——只传参不接线的广播是静默 no-op（被 shell 自身的 ask 返回值
  掩盖，只有跨窗口同步测试能抓到）。cancel 必须同时设 `run.cancelled` 标志与
  状态（标志驱动轮询循环退出，状态只是展示）。
* 移出成员 / 关闭页面 → 立即终止对应参与者（RoundtableService 的
  onParticipantsChanged diff → cancelParticipant；每轮轮询重新 resolve tabId）。
* E2E：`BREWPHASE_AI_TEST_HOST` 接缝让 WebCard 直接建在夹具 URL 上（按段匹配 +
  端口校验）；**惰性 locator 陷阱**——`.last()` 在动作时重新解析，多卡场景必须在
  每张卡创建后立即取 data-tab-id。
* 4.1 遗留：aiChat 任务通知广播全部窗口；`##`→h4、列表 `p.md-ul`；平台登录态只
  探测代理页（4.2 起探测的就是卡片本身）；`browser.e2e`「拖动与缩放」无 GPU
  环境会拖不到位（干净 HEAD 同样失败，先 stash 验证再定性）。

## 代码风格与工作流

* 阈值集中 `RAG/Rules/IntelligenceConfig.swift`；中文词表放 `Resources/*.json`。
* 纯逻辑放 `Core/`，视图放 `Shared/Components/` 与 `Features/`。
* 改完先 commit + push 再询问 GPT，必须附 https://github.com/banmu123/BrewPhase。
* push 报 `CRYPT_E_NO_REVOCATION_CHECK` 时：`env -u http_proxy -u https_proxy
  -u HTTP_PROXY -u HTTPS_PROXY git -c http.sslBackend=schannel
  -c http.schannelCheckRevoke=false push`（schannelCheckRevoke 必须与
  显式 sslBackend=schannel 同给才生效；openssl 后端缺 CA 会报 issuer 错）。
