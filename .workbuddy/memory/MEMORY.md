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

## 代码风格与工作流

* 阈值集中 `RAG/Rules/IntelligenceConfig.swift`；中文词表放 `Resources/*.json`。
* 纯逻辑放 `Core/`，视图放 `Shared/Components/` 与 `Features/`。
* 改完先 commit + push 再询问 GPT，必须附 https://github.com/banmu123/BrewPhase。
