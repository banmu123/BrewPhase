# 网页卡片 Phase 2 — 真实缩略图与原生窗口展开：交付报告

- 基线：`5f72d58`（Roundtable Phase 1 + 文档）
- 范围：Studio Home 网页卡片架从「本地模拟网址卡」升级为「真实 BrowserTab + 真实截图 + 可拆出/收回的原生窗口」
- 不在本阶段：AI 自动化、多 AI 统一提问、圆桌原生窗口、schema / migration 变更

---

## 1. 新旧网页卡片模型的区别

| 维度 | Phase 1（旧） | Phase 2（新） |
| --- | --- | --- |
| 卡片身份 | 渲染层 `webcard-N`，本地生成 | 主进程 `tab-N`（`BrowserTabManager` 的 tabId） |
| 网页状态 | zustand 里的 `url / status`，可手填 | `BrowserTabInfo` 快照：url / title / loading / error / windowId / detached / parked |
| 页面实例 | 无（纯 UI 假数据） | 一个 `WebContentsView` + 一个 WebContents，卡片只引用它 |
| 卡片视觉 | 图标 + 名称 + 域名 | 16:10 真实网页截图 + 名称 + 域名 + 状态 |
| 关闭卡片 | 删一条本地数据 | `closeTab(tabId)`：销毁唯一的 WebContents，并清预览缓存 |
| 点击卡片 | 无真实动作 | 在浏览器浮窗里展开同一个 tab（`activateTab`） |
| 拖出 | 无 | 把同一个 view 迁到新的原生 BrowserWindow，不重新 loadURL |
| 圆桌参与者 | 引用 `webcard-N` | 引用真实 `tabId`，标签关闭时自动摘座 |
| 顺序 | 本地数组 | 渲染层 `cardOrder`（localStorage），tabId 不变 |

**关键约束**：卡片不是网页状态的来源。`cards.length` 等于 `browserState.tabs.length`（顺序不同），
标签消失则卡片消失；反之任何 UI 收起都不会销毁标签。

---

## 2. 真实网页与卡片的映射架构

```text
Studio Home
  └── WebCardShelf
        ├── useBrowserStore(快照) ──► BrowserTabInfo[]（主进程广播）
        ├── useBrowserPreviewStore ─► BrowserPreview（主进程内存缓存）
        └── card 1..n ── tabId ──► BrowserTabManager
                                      └── WebContentsView
                                            └── WebContents（唯一页面实例）

  └── Roundtable（participantTabIds: string[]）
        └── tabId 引用（不复制 url / 不复制截图）
```

- **身份**：`tabId`。排序、拆出、收回、圆桌加入/移除都不改 tabId。
- **生命周期**：只有 `BrowserTabManager.closeTab / disposeAll` 销毁 WebContents。
  窗口（主窗 / 浮窗 / 采集宿主）只负责显示与挂载。
- **展示位置**：`BrowserTabInfo.windowId` + `detached` + `parked`。
  `active` 表示「主窗口面板正在显示」，由 `panelVisible && !startPage && windowId===主窗` 共同决定。
- **渲染层边界**：只订阅快照、调用 IPC；拿不到 WebContents / Session / Cookie。

---

## 3. 缩略图：采集、更新与缓存

### 3.1 为什么需要「采集宿主」

实测（`/tmp` 探针，Electron 45）：`WebContentsView` 只有落在可见窗口内容区
**并获得绘制表面**之后，`webContents.capturePage()` 才有内容；隐藏视图直接报
`Current display surface not available for capture`，从未显示过的视图返回空图。
把视图临时放到窗口外也会返回空图——它必须真正参与合成。

因此新增 `src/main/browser/capture-host.ts`：

- `BaseWindow`（没有 renderer，不出现在页面列表）：
  `opacity: 0`、`focusable: false`、`setIgnoreMouseEvents(true, { forward: true })`、
  `showInactive()`；
- 收在架子上的标签挂在它里面，视口固定 1280×800（16:10 桌面比例）；
- 截图时 `setVisible(true)` → 等一帧 → `capturePage()` → `setVisible(false)`；
  用户看不见（窗口全透明），但 Chromium 会绘制这一帧；
- 展开卡片时把**同一个 view** 迁回主窗口；收回时再迁回宿主。只改父子关系，
  不 `loadURL`、不重建 view、不复制页面实例。
- Linux 不支持窗口 opacity：`ensure()` 直接返回 null，退化为「只在页面被显示过之后才有预览」，
  不会用一个真实窗口盖住主界面。

### 3.2 采集与压缩

- 采集：`webContents.capturePage()`（2x 屏得到 2560×1600）。
- 压缩：`nativeImage.resize({ width: 640, quality: 'good' })` → `toJPEG(68)` →
  `data:image/jpeg;base64,…`（单张约 40–80 KB）。
- 缓存：`BrowserPreviewService` 内存 `Map<tabId, BrowserPreview>`，最多 12 张，按最旧淘汰。
  **不写 SQLite、不进日志、不上云**；标签关闭/销毁即 `forget` 并广播 `clear`。

### 3.3 刷新策略

| 事件 | 行为 |
| --- | --- |
| `did-stop-loading`（无错误） | `onPageSettled` → 700ms debounce 后采集 |
| `did-navigate` / `did-navigate-in-page` | 同上（站内导航也刷新） |
| `page-title-updated` | 同上（SPA 路由/标题变化） |
| 拖出到独立窗口 | 迁移完成后重新 schedule |
| 拖回 / 收回卡片架 | 迁移完成后重新 schedule |
| 卡片无预览且非加载/错误 | 渲染层 `request(tabId)` 触发一次（主进程节流） |
| 采集失败（窗口最小化、渲染崩溃、无表面） | **保留最后一张有效预览**，不广播空值 |

节流：同一 tab 最小采集间隔 2s；全局并发 1（截图会短暂改 view 的 bounds/visible，不能并发）。
取消/清理：`dispose()` 清定时器、队列与缓存；标签关闭调 `forget`。

---

## 4. 拖出 / 拖回的真实窗口迁移链路

### 拖出（卡片 → 独立窗口）

```text
卡片 pointerdown（阈值 5px）
  → document pointerup（屏幕坐标）
  → api.browserTabs.dragProbe(x, y)        // 主进程窗口几何判定
  → 光标在所有窗口之外
  → api.browserTabs.detach(tabId, x, y)
  → BrowserManager.detachToNewWindow
  → FloatWindowManager.create(tabId, near) // 新原生窗口，位置贴着松手点
  → BrowserTabManager.moveToWindow(tabId, 新窗口 id)
        ├─ 从采集宿主/主窗口 removeChildView
        ├─ 新窗口 contentView.addChildView(同一个 view)
        └─ 不 loadURL、不重建 WebContents
  → 卡片保留在架上，presentation = 'detached'
```

### 拖回 / 收回（独立窗口 → 卡片架）

```text
独立窗口标题区拖动（pointer capture）或点击「收回卡片架」
  → probe.mainWindow === true / recall(tabId)
  → BrowserManager.recallToShelf(tabId)
        ├─ FloatWindowManager.release + 空窗口 closeEmpty
        ├─ parkTab(tabId)：moveToWindow(采集宿主) + 1280×800 + 隐藏
        ├─ activeTabId / panelVisible 复位（不影响其他标签）
        └─ previews.schedule(tabId) 刷新截图
  → presentation = 'shelved'，缩略图更新；Session / 滚动 / SPA 状态不变
```

`page.__born`（页面出生时间）在「展开 → 拆出 → 收回」全程不变，`__ticks`
持续增长——E2E 用这两条证据证明没有重新加载。

---

## 5. 新增与修改的文件

### 新增（9）

| 文件 | 作用 |
| --- | --- |
| `src/shared/web-cards.ts` | 卡片派生模型：顺序对账、presentation、域名/名称、可加入判断 |
| `src/main/browser/browser-preview.ts` | 缩略图调度器：debounce、2s 节流、并发 1、缓存淘汰、失败保留 |
| `src/main/browser/capture-host.ts` | 透明 `BaseWindow` 采集宿主（opacity 0 / 不可点 / 不抢焦点） |
| `src/renderer/src/features/browser/preview-store.ts` | 渲染层预览缓存 + 事件订阅 + 按需 request |
| `tests/unit/web-cards.test.ts` | 10 条：顺序/模型/身份/可加入 |
| `tests/unit/browser-preview.test.ts` | 7 条：合并/节流/单并发/失败保留/清理/淘汰 |
| `tests/e2e/web-cards.e2e.spec.ts` | 3 条：真实缩略图、展开/收起、拖出+收回不重载、加载/失败态 |
| `tests/e2e/web-fixture.ts` | 本地网页夹具（真实导航/绘制/截图，不依赖外网） |
| `scripts/phase2-visual-check.mjs` | 视觉验收截图脚本（手动运行，产物进 test-results，已 gitignore） |

### 主要修改（30）

| 区域 | 文件 | 改动 |
| --- | --- | --- |
| 主进程 | `browser-manager.ts` | 预览服务接入、采集宿主、`createShelfTab` / `navigateTab` / `detachTab` / `recallToShelf`、park/unpark、active 语义、原生层对齐修正（去掉重复 40px 偏移） |
| 主进程 | `browser-tab-manager.ts` | `parked` 状态、`captureWindowId`、页面事件回调、关闭清理；窗口查找改用 `BaseWindow.fromId`（同时支持 BrowserWindow 与宿主） |
| 主进程 | `index.ts` | 主窗口关闭时收起采集宿主并兜底退出 |
| 主进程 | `ipc/register.ts` | 新增 7 个 handler（preview list/get/request、create-shelf、navigate-tab、detach、recall） |
| 契约 | `shared/contracts/browser.ts`、`index.ts`、`validation/ipc.ts` | `parked`、`BrowserPreview`、`BROWSER_PREVIEW_CHANNEL`、zod schema、RendererApi |
| preload | `preload/index.ts` | `browserPreviews` + 4 个 browserTabs 方法 |
| 渲染层 | `WebCardShelf.tsx` | 完全重写：真实快照派生、缩略图、内联地址、拖出/排序/拖入圆桌、拖动影子、收回按钮 |
| 渲染层 | `roundtable-store.ts` | 去掉本地 cards，改为 `cardOrder + roundtable(participantTabIds)`，对账与持久化 |
| 渲染层 | `RoundtableSection.tsx` | 参与者改为真实标签，缩略图小样，移除只读本地卡 |
| 渲染层 | `BrowserPanel.tsx` | ✕ 改为「收起，回到卡片架」，不再销毁页面 |
| 渲染层 | `BrowserFloatWindow.tsx` | 标题区拖动收回（屏幕坐标判定）+ 「收回卡片架」按钮 |
| 渲染层 | `BrowserTabStrip.tsx` | 落点查询收在本标签条内（修复与卡片 `data-tab-id` 的冲突） |
| 渲染层 | `App.tsx` | 订阅并 hydrate 预览通道 |
| 渲染层 | `shared/api.ts` | 用 `globalThis` 取桥，避免 node 单测无 DOM lib |
| 样式 | `styles/app.css` | 缩略图卡片、拖动影子、空架引导、参与者小图、浮窗标题拖动反馈 |
| i18n | `studio.ts` / `browser.ts` ×2 | 新增状态、预览、收回、拖出提示等中英文案 |
| 共享 | `shared/roundtable.ts` | 参与者改为 `participantTabIds`，新增 `retainParticipants` |
| 测试 | 单测 4 个 + E2E 2 个 | 适配新语义；`browser.e2e` 的「关闭」改为「收起」；`browser-detach` 选择器限定 |

---

## 6. 实际测试结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | ✅ 通过（node + web 两套 tsconfig） |
| 构建 | `pnpm build` | ✅ 通过（main / preload / renderer） |
| 单测 | `npx vitest run` | ✅ **53 文件 / 692 条全通过**（新增 17 条，改写圆桌 28 条） |
| E2E | `pnpm e2e` | ✅ **64 passed / 8 skipped / 0 failed**（2.0m，含新增 3 条 web-cards 与改写 6 条 roundtable） |

相关专项：`web-cards` 3/3、`roundtable` 6/6、`browser` 7/7、`browser-detach` 1/1。
本轮没有删除测试、没有新增 skip；8 条 skipped 均为既有的 visual spec（需 `VISUAL_CHECK`）。

### 过程中发现并修掉的两个真实缺陷

1. **`data-tab-id` 冲突**：卡片与浏览器标签条都用 `data-tab-id`，`BrowserTabStrip`
   的全局 `document.querySelector` 先命中架子上的卡片，导致标签排序永远 no-op。
   修复：落点查询限定在 `stripRef.current` 内。
2. **网页整体下沉 40px**：`applyBounds` 在渲染层上报的 stage 矩形上又加了一次
   `BROWSER_TABBAR_HEIGHT`，原生网页顶部留白 40px。修复：原样对齐 stage；
   `browser.e2e` 的「原生层始终对齐」断言从长期偏移恢复为 0px 误差。

---

## 7. ChatGPT / Claude 真实访问截图

产物目录：`Desktop/test-results/phase2-screenshots/`（gitignored）

| 截图 | 内容 | 结论 |
| --- | --- | --- |
| `06-page-chatgpt.png` | 主进程 `capturePage` 拍到的 ChatGPT 页面 | ✅ 真实打开（未登录欢迎页，中文界面） |
| `05-shelf-chatgpt.png` | ChatGPT 卡片 + 真实缩略图 + 域名 + 已收纳 | ✅ 缩略图来自该真实页面 |
| `04-page-claude.png` | Claude 页面 | ⚠️ 停在 Cloudflare「正在进行安全验证」 |
| `03-shelf-claude.png` | Claude 卡片（挑战页的真实截图，标题「请稍候…」） | ✅ 截图真实，但要进入应用需人工过验证/登录 |

说明：本机 Electron 里 ChatGPT 可直连；Claude 的 Cloudflare 人机验证在自动化环境
持续 90s 未通过（真实页面、可手动点击）。这不是卡片或截图链路的问题——卡片显示的
正是那一页的真实画面，没有伪造。

---

## 8. 三种卡片状态截图

| 截图 | 状态 |
| --- | --- |
| `01-shelf-local-thumbnail.png` / `02-shelf-only.png` | 缩略状态：16:10 真实网页截图 + 名称/域名 + 「已收纳」 |
| `07-panel-expanded.png` | 主窗口展开：卡片点击后在浏览器面板打开同一个 tab（原生网页不参与 DOM 截图，stage 为空白，属已知限制） |
| `08-shelf-detached.png` | 独立窗口：卡片保留在架上，chip「独立窗口」，边框强调色 |
| `09-float-window.png` | 独立窗口壳：品牌标题栏 + 标签条 + 「收回卡片架」 |
| `10-page-in-float.png` | 独立窗口里同一个页面的真实内容（主进程 capturePage） |
| `11-shelf-recalled.png` | 收回后：缩略图刷新、chip 回到「已收纳」 |
| `12-shelf-dark.png` | 深色主题：卡片/文字/状态可读，缩略图保持网页本色 |

---

## 9. 仍需人工验收的项目

见 `docs/testing/DESKTOP_WEB_CARDS_PHASE2_MANUAL_CHECKLIST.md`。摘要：

1. **OS 级真实拖出**：按住卡片拖到 BrewPhase 窗口外（真实鼠标，非 CDP 事件），确认新窗口出现且页面未刷新。
2. **OS 级拖回**：按住独立窗口标题区拖到主窗口上松手，确认接回卡片架、窗口自动关闭。
3. **原生窗口操作**：最小化 / 最大化 / 缩放 / 关闭，页面内容保持。
4. **登录态**：在卡片展开的窗口里登录 ChatGPT / Claude，收起后重新展开仍是同一会话。
5. **滚动与 SPA 状态**：滚动到中部、打开一段对话，拆出再收回，位置与对话不变。
6. **Claude 验证页**：人工勾选 Cloudflare 验证并登录，确认卡片预览更新为应用界面。
7. **多显示器**：在第二块屏幕上松手，浮窗出现在正确屏幕；收回后回到主屏卡片架。
8. **Linux**：无透明宿主，确认预览退化为「显示过才有图」，且没有多余窗口。

---

## 10. 已知限制与取舍

- **Playwright 拍不到原生 `WebContentsView`**：`page.screenshot()` 只能拍壳；网页内容用主进程
  `capturePage()` 单独落盘（`04/06/10`）。这是 Electron 的结构性限制，不是产品缺陷。
- **拖出测试使用屏幕坐标 PointerEvent**：Playwright 的鼠标无法离开窗口；E2E 仍走卡片的
  阈值、document pointerup、`dragProbe` 与真实迁移链路，不直接调 `resolveDrop`。OS 级拖动留给人工清单。
- **采集宿主不可见但存在**：`BaseWindow` + `opacity: 0`，不出现在 `BrowserWindow.getAllWindows()`；
  在 Mission Control 里可能表现为一个空窗口（macOS 系统行为），不影响使用。
- **Linux 预览降级**：窗口 opacity 不支持，不创建宿主；页面第一次被展开前没有缩略图。
- **深色主题下缩略图仍是浅色网页**：这是网页本身的外观，不做反色（否则就不是真实预览）。
- **未做**：预览图持久化、卡片跨重启恢复、拖动 autoscroll、预览右键菜单、圆桌原生窗口。
