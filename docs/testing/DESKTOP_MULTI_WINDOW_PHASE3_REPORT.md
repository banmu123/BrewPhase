# BrewPhase Desktop — Phase 3 交付报告：原生窗口拖出与圆桌独立显示

- 功能提交：`983f3b7`（feat(desktop): 卡片拖出改 OS 拖拽会话；圆桌拆出为独立原生窗口）
- 文档提交：见仓库最新 `docs(testing)` 提交
- 仓库：https://github.com/banmu123/BrewPhase
- 范围：**不含**多显示器专项适配、AI 统一提问 / 辩论（规格 §7 明确不做）

---

## 1. 拖出失败的根因（为什么要重做）

Phase 2 的卡片拖出在真实鼠标下不可靠，排查确认了四个根因：

1. **主因（渲染层）**：pointer 事件拖拽依赖「光标离开 BrowserWindow 后仍能收到 pointermove/pointerup」。真实 macOS/Windows 桌面上这个假设不成立——pointerup 在窗口外丢失时，整个拖拽会话挂死，detach 永不触发，表现为「卡片拖不出去」。Phase 2 的 E2E 用 `dispatchEvent` 合成 PointerEvent，绕过了 OS 输入链路，所以 CI 全绿而真实拖动失败。
2. **主进程无会话**：只有渲染层节流上报的 dragProbe，没有权威光标追踪，也没有防重复拆窗。
3. **`Math.max(0, …)` 定位**：浮窗创建位置被钳到 (0,0)+，副屏在主屏左/上（负坐标）时窗口落到错误显示器，拖出「看起来没生效」。
4. **关闭语义错位**：浮窗系统关闭会 reattach 并强制 `panelVisible = true`（意外打开主窗口 BrowserPanel）。

## 2. 卡片拖出的新机制（Phase 3.1）

**渲染层拖拽改为 OS 原生 HTML5 Drag and Drop**：

- 卡片 `draggable`；`dragstart` 写入 `application/x-brewphase-webcard` 数据、`setDragImage(卡片元素)`——拖影由 OS 渲染，**窗口外也可见**，像真的把卡片拿了起来；
- OS 拖拽会话保证**终态事件 `dragend` 必达**：窗口外松手、落到其他应用、Esc 取消，全部收敛到同一个出口；
- 窗口内行为走 `dragover/drop`：卡片间排序（插入指示线）、拖入圆桌热区加入；
- `drop` 被接受时立即通知主进程 `dropHandled`（IPC FIFO 保证先于 dragend 到达），会话按「内部投放」收尾，绝不拆窗。

**主进程 `BrowserDragSessionManager`（`src/main/browser/browser-drag.ts`）是唯一裁判**：

- `dragstart` → `begin('webcard', tabId)`：会话单例（重复 begin 被拒绝 → 一次拖动绝不双开窗口）；
- 会话期间每 32ms 轮询 `screen.getCursorScreenPoint()`——**主进程是唯一能可靠看到窗口外坐标的一方**；`outside` 翻转时广播 `browser:drag` 帧，渲染层据此显示「松手拆出」提示；
- `dragend` → `end()`：松手位置优先级 = **实时光标读数 > 会话内最后一次轮询 > 渲染层兜底坐标**（窗口外渲染层坐标不可信，只作无读数时的兜底）；落点在任何已知窗口之外 → 拆出新窗口，否则取消；
- 拖动中的标签被关闭 → 会话强制收尾；圆桌窗口关闭时同理（否则单例会挡住下一次拖动）。

**几何修复**：`float-window.ts` 定位改用 `screen.getDisplayNearestPoint(落点).workArea` + 纯函数 `fitRectIntoBounds`（`src/shared/window-placement.ts`）——允许负坐标、窗口完整可见，负坐标场景有直接单测覆盖。`detachTab` 对已拆出的标签只聚焦现有窗口。

**关闭语义（规格 §3.6）**：卡片架的 ✕ = 真正关闭标签（销毁 WebContents）；独立窗口的系统 ✕ = 收回卡片架（park 到采集宿主，页面不销毁、不重载、**不打开 BrowserPanel**）；「收回卡片架」按钮与系统 ✕ 语义完全一致。

## 3. 圆桌独立窗口（Phase 3.2）

**主进程唯一状态**（`src/main/roundtable/roundtable-service.ts`）：

- 唯一的 `RoundtableSnapshot`：`{ id, participantTabIds, draft, detached, updatedAt, version }`，每次真实变更 `version`+1 并广播到主窗口 + 圆桌窗口（`roundtable:changed` 通道）；
- `join` 校验 tabId 是活着的真实标签（不创建隐藏网页）；标签关闭 → `syncTabs` 自动摘除参与者；
- 草稿采用**后写者胜出**：曾实现 baseVersion 门控，但键击间隔必然短于 IPC 往返，快速打字会被拒、丢字符——共享文本框改用 last-writer-wins（两个窗口始终看到同一份最终值），「静默覆盖」防护保留在结构性写入（参与者/拆出）上。

**唯一实例窗口**（`roundtable-window-manager.ts`）：

- 加载本应用 Renderer，hash 路由 `#bpRoundtable=<id>`（与 `#bpFloat` 互不冲突；同一套 preload/sandbox/i18n/主题，不复制页面、不用 iframe）；
- 系统 ✕ = 归位（intercept close → service.dock()）；窗口被外部销毁（崩溃/destroy）→ `onWindowLost` 兜底归位，状态不卡在 detached；应用退出时放行（isQuitting），不卡 quit；
- 重复 detach 只聚焦现有窗口；贴近松手点摆放（同一套 workArea 几何）。

**渲染层**：

- `App.tsx` 按 hash 分发三壳：主应用 / `#bpFloat`（浏览器独立窗口）/ `#bpRoundtable`（圆桌独立窗口）；
- `RoundtableWindow.tsx`：品牌标题栏 + 专用拖回手柄（grip，`no-drag` 区域）+ 参与者 + 提问输入 + 归位按钮；标题栏本体是原生窗口移动（`-webkit-app-region: drag`），与 OS 拖拽源分离——同一区域两者会互相抢事件；
- 主窗口 `RoundtableSection`：停靠态（标题栏为拖出拖拽源，整块圆桌作为 OS 拖影）或占位区（人数 + 参与者名 + 重新打开 + 归位 + 拖回热区）；Phase 2 的 `position: fixed` 应用内浮层整体移除；
- 圆桌拖出同样是 OS 拖拽会话：标题栏 `dragstart` → `roundtable.dragBegin()` → 窗口外松手 → 主进程拆窗；拖回 = 手柄拖到主窗口占位区 drop，或点「归位」——两条路径同效。

## 4. 跨窗口同步

主窗口与圆桌窗口是两个 Renderer，各自的 Zustand 只是**主进程快照的缓存**：所有动作「发意图 → 主进程校验/提交 → 广播快照」。E2E 验证了：主窗口写下草稿 → 拆出后独立窗口显示同一份；独立窗口移除参与者 → 主窗口占位区人数同步；独立窗口改草稿 → 归位后主窗口输入框原样出现；归位/系统关闭后参与者与草稿不丢。

## 5. 文件清单

新增（9）：`main/browser/browser-drag.ts`、`main/roundtable/roundtable-service.ts`、`main/roundtable/roundtable-window-manager.ts`、`shared/window-placement.ts`、`renderer/features/studio/RoundtableWindow.tsx`、`scripts/phase3-visual-check.mjs`、单测 ×3（browser-drag / roundtable-service / window-placement）。

修改（20）：`browser-manager.ts`（拖拽会话接线、detach 去重、关闭语义、hasTab/liveTabIds/classifyDragPoint）、`float-window.ts`（workArea 定位）、`main/index.ts`（装配、activate 修复、测试钩子）、`ipc/register.ts` + `contracts/*`（12 个新 IPC + zod 校验）、`preload/index.ts`（browserDrag + roundtable API）、`App.tsx`（三壳路由）、`WebCardShelf.tsx`（DnD 重写）、`RoundtableSection.tsx`（重写）、`roundtable-store.ts`（快照缓存）、i18n 中英、样式；测试改写：`roundtable.test.ts`、`roundtable-store.test.ts`、`web-cards.e2e`（4 条）、`roundtable.e2e`（6 条）。

## 6. 测试结果（本次实际运行）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ 0 error |
| `pnpm build` | ✅ main / preload / renderer |
| `npx vitest run` | ✅ **56 文件 / 731 条全过**（新增 31 条：拖拽会话 12、窗口几何 8、圆桌服务 15；旧圆桌 2 个套件改写为新模型，未删覆盖） |
| `pnpm e2e`（全量） | ✅ **65 passed / 8 skipped / 0 failed**（2.1m；skip 为既有 visual 基线集，无新增 skip、未删断言） |

E2E 关键链路：卡片拖出（合成 dragstart + 主进程假光标 + dragend）→ 新窗口 + tabId 不变 + `__born` 不变（页面未重载）；浮窗系统关闭（`BrowserWindow.close()`，与系统 ✕ 同路径）→ 卡片回架、**BrowserPanel 不打开**、页面不销毁；卡片 ✕ → 标签销毁；圆桌按钮拆出 / 标题栏拖出 → `#bpRoundtable` 窗口 + 占位区 + 重复拆出只聚焦；跨窗口 join/leave/草稿同步；归位与系统关闭数据不丢；拖回占位区归位；三类窗口共存（主窗口 + bpFloat + bpRoundtable）。

多显示器算法：`fitRectIntoBounds` 8 条单测覆盖副屏在左（x=-1920）、在上（y=-1080）、dock workArea 非零起点、窗口大于屏幕等。**真实多显示器人工验证未做**（本机单屏），见清单 §C。

## 7. 窗口表现截图

`Desktop/test-results/phase3-screenshots/`（gitignored，`scripts/phase3-visual-check.mjs` 生成）：

| 文件 | 内容 |
| --- | --- |
| `01-shelf-thumbnail.png` | 卡片真实缩略图 |
| `02-shelf-detached.png` | 卡片拆出后的架子（收回入口可见） |
| `03-float-browser-window.png` | 拆出的独立浏览器窗口（标题栏/标签条/工具栏） |
| `04-page-in-float.png` | 独立窗口里的真实网页（主进程 capturePage） |
| `05-shelf-recalled.png` | 收回后的架子 |
| `06-roundtable-docked.png` | 圆桌停靠态（参与者 + 提问输入 + 独立窗口按钮） |
| `07-roundtable-window.png` | 圆桌独立窗口（品牌标题栏 + 手柄 + 归位） |
| `08-main-placeholder.png` | 主窗口占位区（人数 + 重新打开 + 归位） |
| `09-coexistence-main.png` | 独立窗口运行时的主窗口 |
| `10-roundtable-docked-with-draft.png` | 归位后草稿原样保留 |

ChatGPT / Claude 真实站点验证沿用 Phase 2 结论（同一条拆出/收回链路）：ChatGPT 可真实访问并截图；Claude 停在 Cloudflare 挑战页（真实截图如实显示，需人工通过验证）。

## 8. 实现中修复的真实缺陷（含自查发现的）

1. **草稿 baseVersion 门控丢字符**（自查）：键击间隔 < IPC 往返，门控必拒 → 改后写者胜出。
2. **`setDraft` IPC 返回包装对象**（E2E 抓到）：store 把 `{ok, snapshot}` 当快照存，`participantTabIds` 变 undefined → React 崩溃整树卸载 → 服务层改为直接返回快照。
3. **圆桌窗口关闭后拖拽会话残留**（E2E 抓到）：拖回流程 drop → dock 关窗，dragend 永不到达，会话单例挡住后续所有拖动 → 窗口关闭时强制收尾。
4. **圆桌窗口被外部销毁后状态卡死**（E2E 抓到）：`page.close()`/destroy 绕过 'close' 事件 → `onWindowLost` 兜底归位。
5. **`-webkit-app-region: drag` 与 `draggable` 冲突**（自查）：同一区域原生窗口移动会吞掉 OS 拖拽源 → 拆出「专用拖回手柄」。
6. **E2E 误用 Promise**（自查）：`browser.state()` 是 Promise，直接 `.tabs.length` 必炸。

## 9. 尚未人工验证（清单文档逐项执行）

真实鼠标 OS 级拖出/拖回的手感与边界、独立窗口最小化/最大化/缩放、ChatGPT 登录态跨拆收保持、真实双显示器（副屏左/上/DPI 差）、拔掉副屏后窗口找回、Claude 人机验证后缩略图更新、深色主题下的两个独立窗口。逐项见 `DESKTOP_MULTI_WINDOW_PHASE3_MANUAL_CHECKLIST.md`。
