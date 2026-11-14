# BrewPhase Desktop — Phase 3.4 交付报告：网页卡片拖出修复与添加网页体验

- 功能提交：见本文件所在提交的同系列 `feat(desktop)` commit
- 前置：Phase 3 报告 `DESKTOP_MULTI_WINDOW_PHASE3_REPORT.md`（圆桌独立窗口已由用户真实操作验收）
- 本阶段范围：只修网页卡片拖出 + 重设计「添加网页」输入卡；**不触碰圆桌拖拽机制**

---

## 1. 拖出失败的真实根因（差异对比诊断）

Phase 3 已把卡片与圆桌接到**同一个** OS 拖拽会话（HTML5 DnD + `BrowserDragSessionManager`）。
用户实测：**圆桌标题栏拖出成功，卡片拖出失败**——同一套会话、同一个主窗口，差异只能在卡片自身的事件链路。逐项对比后找到五个结构性差异（圆桌全都没有）：

| # | 卡片独有的行为 | 风险 |
| --- | --- | --- |
| 1 | **拖动光标扫过源卡片本身时，`onDragOver` 会改写源元素的 `data-insert` 属性**（卡片自己也是 drop 目标） | 对正在被拖拽的元素做 DOM 变更，会干扰 macOS 原生拖拽会话——头号嫌疑 |
| 2 | 拖动起点多为缩略图 `<img>` / 文字子元素（圆桌标题栏子元素是普通 span） | macOS Chromium 图片拖拽劫持 / 子元素歧义 |
| 3 | `.web-card__actions` 是 `opacity: 0` 但**仍接收指针事件**的悬浮层，盖住预览区一角 | 按压落在隐形按钮区域 |
| 4 | dragstart 处理器无异常防护——Chromium 会在 dragstart 抛错时**直接取消原生拖拽** | 任一副作用异常 = 拖拽静默失败 |
| 5 | 会话单例无看门狗：一次 dragend 丢失后，之后所有 `begin` 永久被拒 | 「永远拖不出来」的次生灾害 |

## 2. 修复内容（拖拽事件与 IPC）

渲染层 `WebCardShelf.tsx`：

1. **整卡收敛为一张拖拽面**：缩略图、占位、meta、圆点、握把全部 `pointer-events: none`，`<img>` 加 `-webkit-user-drag: none`——按住卡片任何位置，指针目标都是可拖拽的 `<article>`；按钮层改为 `pointer-events: none`（悬浮/聚焦时 `auto`）。
2. **源卡片不做插入标记**：`onDragOver` 命中正在拖动的那张卡时直接跳过（对齐圆桌行为）。
3. **dragstart 加固**：`dataTransfer.setData` 同步最先执行；拖影/状态副作用全部包进 try（异常不再中止原生拖拽）；`suppressClick` 双保险（拖动后 400ms 内的 click 不开面板）。
4. 全链路埋点：渲染层 `[drag:card] dragstart/dragend`（页面 console）+ 主进程 `[drag] begin/outside/release outside/cancel/watchdog`（开发终端）——用户真实拖一次即可看到断在哪一环。
5. **悬停「独立窗口」备用按钮**：与拖出共用 `BrowserManager.detachTab()`（同一页面实例迁移），不代替拖动。

主进程 `browser-drag.ts` / `browser-manager.ts`：

6. **会话看门狗（45s）**：dragend 丢失时强制收尾，单例不再永久挡路。
7. **过期会话识别**：`end(fallback, expectedTabId)`——dragend 上报的 tabId 与残会话不一致时只取消，**绝不把旧 tab 拆出去**。
8. `detachTab` 的去重（已拆出 → 只聚焦）保持不变；`moveToWindow` 迁移链路一行未动。

**关于真实 OS 拖拽的自动化边界（如实说明）**：本环境无法注入 OS 级鼠标（cliclick 被 macOS TCC 杀掉，exit 137）。自动化覆盖为：合成 DragEvent 走完整 IPC 链路（9 条 E2E）+ 结构断言（拖拽面 `pointer-events` 收敛、`elementFromPoint` 命中卡片本体）。**真实鼠标拖出必须按人工清单验收**；若仍有问题，终端 `[drag]` 日志会给出精确断点。

## 3. 「添加网页」编辑卡重设计（3.4.3）

- 编辑卡不再受 208px 卡宽限制：344px 独立卡片，圆角 + 轻阴影；
- 结构：图标 + 「添加网页」标题 → 标签文案 → 40px 高输入框（地球图标、聚焦时 sage 描边 + 柔光环）→ 支持协议提示 → 错误行 → 取消（ghost）+ 打开网页（espresso 主按钮）；
- 交互：自动聚焦、Enter 提交、Esc 取消（关掉空标签）、空输入禁用主按钮、提交中防重复（按钮显示「正在打开…」）；
- 错误分层：**输入级拒绝**（协议被安全校验拦下等）→ 错误行显示在表单内，可取消无残留；**网络级失败** → 卡片退出编辑态，按 Phase 2 语义在卡片上显示「加载失败」（URL 解析/规范化/HTTP(S) 校验逻辑一行未动）；
- 深色主题同一套令牌，截图验证对比度正常。

## 4. 页面实例保持不变（3.4.2）

拆出/收回仍只走 `BrowserTabManager.moveToWindow()`：原 tabId、原 WebContents、原 Session、滚动/输入/SPA 状态全部保留；收回后预览重采；卡片架 ✕ 才销毁。E2E 继续用 `__born` 不变 + `__ticks` 增长证明页面未重载。

## 5. 修改文件

- `renderer/features/studio/WebCardShelf.tsx`（拖拽面收敛、源卡免标记、防异常、点击抑制、备用拆出按钮、编辑卡重写）
- `renderer/styles/app.css`（拖拽面 pointer-events、握把、编辑卡整套样式）
- `main/browser/browser-drag.ts`（看门狗、过期会话识别、埋点钩子）、`main/browser/browser-manager.ts`、`main/index.ts`（日志接线）
- `i18n/messages/{zh-CN,en-US}/studio.ts`（新键：formLabel/formHint/formInvalid/formOpening/detachAction；open → 打开网页；newCardTitle → 添加网页）
- `tests/e2e/web-cards.e2e.spec.ts`（+5 条）、`tests/unit/browser-drag.test.ts`（+4 条）、`scripts/phase34-visual-check.mjs`（新）

## 6. 测试结果（本次实际运行）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` / `pnpm build` | ✅ 0 error / 全部产物 |
| `npx vitest run` | ✅ **56 文件 / 734 条全过**（+4：看门狗、过期会话、不匹配取消、埋点） |
| `pnpm e2e tests/e2e/web-cards.e2e.spec.ts` | ✅ **9 passed**（+5：编辑卡全流程、窗口内松手不拆窗不误点、重复拖出不双开、备用入口、拖拽面收敛） |
| `pnpm e2e tests/e2e/roundtable.e2e.spec.ts`（回归） | ✅ **6 passed**——圆桌拖出/归位/同步无回归 |
| 视觉截图 | ✅ `test-results/phase3-screenshots/11–13`（编辑卡浅色/深色、悬浮态） |

## 7. 未完成的人工验收项

全部在 `DESKTOP_WEB_CARD_DRAG_PHASE34_MANUAL_CHECKLIST.md`，核心是**真实鼠标拖出**（自动化无法代替）：从缩略图/标题区按住拖出窗口外松手 → 独立窗口出现且页面未重载；登录态保持；归位两条路径；多显示器下负坐标落点（沿用 Phase 3 清单 §C）。若真实拖动仍失败，请带终端 `[drag]` 日志反馈——埋点会精确指出断在哪一环。
