# BrewPhase Desktop — 圆桌自由布局多网页工作空间 交付报告（Phase 4.2 Freeform）

> 基线：`62d101c`（Phase 4.2 WebCard 圆桌问答之后）→ 本阶段提交见文末。
> 规格文件：Phase 4.2 第二轮「圆桌原生多网页工作空间与自由布局」。
> **产品规则补充（用户澄清）**：布局是自由布局，但**面板之间不允许重叠**——本阶段的防重叠是布局层的硬约束，不是吸附辅助。

## 一、架构差异（改造前 → 改造后）

| 维度 | 改造前 | 改造后 |
| --- | --- | --- |
| 圆桌成员展示 | 列表卡片（缩略图 + 状态行），不可操作网页 | **自由布局工作空间**：每个成员是一块可拖动/缩放的真实网页面板 |
| 网页操作 | 必须回到浏览器面板 / 浮窗 | **直接在圆桌面板内操作**（标题栏 + 手柄在原生视图之外，网页本体可点可输入） |
| 布局 | 固定列表，无位置概念 | 任意位置 / 任意尺寸 / 层级置顶，**互不重叠**（主进程 + 渲染层双重 enforcement） |
| 持久化 | 无布局持久化 | SQLite `roundtable_panels`（migration 11）+ 防抖 300ms 合并写；重启恢复为幽灵面板，一键重开保留几何 |
| 独立窗口 | 独立窗口渲染列表 + 输入框 | 独立窗口主体就是工作空间（同一批 WebContentsView 迁移宿主），提问条 + 讨论抽屉挂在底部 |

## 二、核心模块

```
src/main/roundtable/
  ├── roundtable-service.ts        # 成员关系 + workspaceOpen（唯一事实来源，原有）
  ├── roundtable-layout-manager.ts # 布局唯一状态持有者：位置/尺寸/层级/吸附，防抖落库
  ├── roundtable-view-manager.ts   # 原生视图托管：挂载/bounds/可见性/z-order/宿主迁移
src/main/browser/browser-manager.ts
  └── hostTabInRoundtable / releaseTabFromRoundtable / resolveTabForAI / createShelfTabWithURL
src/shared/roundtable.ts
  └── 面板模型 + 几何纯函数（clamp / 吸附 / 防重叠解析 / 找空位）
src/renderer/src/features/studio/
  ├── RoundtableWorkspace.tsx      # 面板框架 + 拖拽/缩放/置顶 + 添加网页 + rects 上报
  ├── roundtable-layout-store.ts   # 渲染层缓存（广播回放 + 拖动乐观覆盖）
```

职责边界：`RoundtableLayoutManager` 不碰 WebContents；`RoundtableViewManager` 不管布局业务规则；页面生命周期权威仍在 BrowserManager——没有第二套 TabManager。

## 三、原生视图与 React 层的层级方案（先验证后实现）

WebContentsView 是原生视图，永远盖在 DOM 之上，`z-index` 对它无效。本阶段的方案：

1. **DOM 只画「标题栏 + 边框 + 缩放手柄」**；内容区是一块预留空白矩形。
2. 渲染层 `getBoundingClientRect` 测量所有面板内容区 → rAF 节流上报主进程（`roundtable-layout:panel-bounds`）。
3. 主进程 `RoundtableViewManager.applyRects` 把**原始 WebContentsView** `setBounds` 到对应矩形。
4. 标题栏、8 个方向缩放手柄都在 view bounds **之外**（面板 DOM 比内容区大一圈 6px 边距），天然可点可拖——不存在「用 CSS 盖住网页」的伪方案。
5. z-order 用 `removeChildView + addChildView` 置顶实现（Electron 无 child z-order API）；每轮轮询重解析 tabId，页面关闭立即停止托管。

## 四、自由布局 + 防重叠（本阶段核心交互）

**坐标全部是工作区局部坐标**；屏幕位置由渲染层 DOM 决定、主进程 setBounds 跟随。

| 操作 | 行为 |
| --- | --- |
| 拖动标题栏 | 位置更新；吸附（阈值 8px，可开关）→ **防重叠解析** → 落库 |
| 四角/边缘缩放 | 自由边被邻居挡住时停在其边缘（收缩式解析），锚定边不动 |
| 单击面板 | `bringToFront`（z = max+1，removeChild+addChild 置顶） |
| 双击标题栏 | 焦点模式预留入口（Phase 4.3） |
| 移除成员 | 原网页归还卡片架（park，不销毁），布局行删除 |
| 拖入卡片 | 原始 tabId 加入；布局找**空位**落位 |

防重叠算法（`src/shared/roundtable.ts`，渲染层预览与主进程落库**同源同函数**）：

- `resolveMoveWithoutOverlap`：拖动候选与其他面板相交时，沿「离用户意图最近」的方向推出去，迭代至无重叠（8 轮上限）；被围死返回 null → 保持原位。
- `resolveResizeWithoutOverlap`：缩放候选相交时，把自由边收缩到刚好避开对方（多路径取面积损失最小），锚定边不动；与最小尺寸冲突返回 null → 保持原 rect。
- `findFreePanelSpot`：新成员从级联种子开始 24px 网格扫描第一个无重叠位置；放不下退到最小尺寸再扫。
- 不变量：**任何时刻布局集合两两不相交**（管理器所有写入路径都过解析器；几何单测锁定）。

## 五、布局持久化

- **migration 11**：`roundtable_panels(roundtable_id, tab_id, url, x, y, width, height, z_index, updated_at)`，主键 (roundtable_id, tab_id)。`url` 列用于幽灵面板一键重开。旧版本数据库由迁移器安全升级，既有数据不受影响。
- 吸附开关与工作区尺寸存 `local_state`（轻量元数据，不建表）。
- **防抖 300ms 合并写**：拖动逐帧只改内存 + 广播，绝不逐帧写 SQLite；`flushPersist` 供关键节点立即落盘。
- `setWorkspaceSize` 只更新 clamp 参照系、**不改写存储位置**——拆出/归位往返、宿主窗口尺寸变化都不会降级用户摆放；宿主变小时显示层按 clamp 显示，宿主变回原样恢复。
- 显示层（渲染层）按 z 序逐个 clamp + 防重叠解析——即使存储位超出当前宿主工作区，屏幕上也不会出现重叠面板。

## 六、WebContents 复用与宿主迁移（规格 §四/§五 验收点）

- **零复制**：圆桌面板直接托管用户那张 WebCard 的原始 view。`BrowserManager.hostTabInRoundtable` 只做三件事：让出激活位、从浮窗账本摘除（空浮窗安全关闭，规格 §5.2）、换父容器。绝不 loadURL、绝不建隐藏副本。
- **圆桌托管豁免**：托管期间 `applyBounds` / `activateTab` / 卡片拖出都不会碰该 tab；用户点卡片架上的卡片 = 聚焦工作空间/独立窗口，绝不抢 view。
- **拆出/归位**：`setWorkspaceVisible + retargetHost + syncMembers`——同一批 view 迁移到独立圆桌窗口再迁回，不创建、不销毁、不重载、不丢登录态；布局原样（E2E 断言位置一字不差）。
- **生命周期**：标签关闭 → `handleTabClosed`（清布局行 + 摘成员 + 视图清理）；页面加载完成 → `onPageSettled` 回填面板 URL；每轮 rects 上报只处理当前成员集合，移除成员的迟到上报被丢弃。
- **幽灵面板**：应用重启后 WebContents 必然消失而布局行还在——面板如实显示「标签已关闭」+ 一键重开；`rebindPanel` 把原几何绑定到新 tabId（清旧行、写新行），位置/尺寸/层级一步不差。

## 七、双窗口同步

主进程是唯一事实来源：布局广播 `roundtable-layout:changed`（主窗口 + 独立窗口都订阅）；成员快照走原有 `roundtable:changed`。两个 Renderer 都没有独立的成员/布局身份，只有缓存 + 拖动中的乐观覆盖（广播回放时被拖面板以本地为准防抖动）。

## 八、安全边界（规格 §十）

不自动提交问题、不 executeJavaScript 读第三方网页、不绕过登录/验证码、不采集凭据、不改 sandbox/contextIsolation、不为第三方网页加 preload、不暴露任意 JS 执行 IPC。本阶段只有用户直接操作网页；Multi-AI 并行问答链路原样保留在提问条/抽屉（Phase 4.1/4.2a 能力），未接入新的工作空间自动化。

## 九、测试结果

- **typecheck ✅ / build ✅**
- **Vitest 802/802**（62 文件；本阶段 +33：布局几何 19（含防重叠解析/找空位/被围死 null）、布局管理器 14（对账/防抖落库/参照系/防重叠 enforcement/rebind））
- **E2E 全量 78 passed / 7 skipped / 1 failed**；唯一失败 `browser.e2e 拖动与缩放` 为**既有环境问题**（Phase 4.1 已用 stash 在干净 HEAD `455ed71` 复现定性：无 GPU 环境真指针拖拽不到位，与本阶段无关）。
- 新增/更新 E2E：
  - `roundtable-workspace.e2e.spec.ts` 4 条：工作空间添加网页 + 原生视图跟随 + 拖动/缩放/置顶/移除；拆出归位宿主迁移（位置一字不差）；重启幽灵面板 + 一键重开（原几何复活）；**防重叠专项**（拖到另一面板正中 → 落点被推到最近空位、两面板不相交、bounds 仍对齐 DOM）。
  - `expectRoundtableViewsAlive`：主进程账本验收（view 存活、visible、bounds≥100、宿主窗口正确、z-order 升序无重复）+ `expectBoundsFollowDom`（view bounds = DOM 内容区 ±2px）。
  - 旧断言迁移（UI 模型升级的必然影响，语义未弱化）：`roundtable.e2e` 独立窗口断言改指工作空间面板；「空浮窗安全关闭」按规格 §5.2 更新期望；`roundtable-ai.e2e` 壳窗口断言改指面板 + 讨论抽屉。
  - 顺手修复两处测试自身的非确定性：合成拖拽未钉光标（全量跑时落点用了上一用例残留的真实 OS 光标）、窗口枚举撞销毁竞态。

## 十、真实桌面人工验收（未执行，需真实账号与真实鼠标）

清单见 `DESKTOP_ROUNDTABLE_FREEFORM_PHASE42_MANUAL_CHECKLIST.md`（7 个场景 34 项）。自动化夹具页只证明链路与布局机制正确，**不构成真实 ChatGPT/Claude/Gemini 网页的验收结论**。

## 十一、已知问题与 Phase 4.3 建议

1. **browser.e2e 拖动与缩放**：无 GPU 环境真指针拖拽不到位，干净 HEAD 同样失败（既有，非本阶段回归）。
2. **工作区挤满时的兜底**：12 成员上限 × 最小尺寸仍放不下时（理论上极难达到），新成员退回种子位并落日志——下一步可考虑工作区滚动/平移。
3. **焦点模式（4.3）**：数据结构已预留（`activeTabId`、面板数组可分组、z 序即顺序）；建议实现为「主区 = activeTabId 面板 + 右侧成员抽屉」，直接复用同一批 view 与 bounds 上报通道，不新建 WebContents；全景布局与焦点布局分开存（`roundtable_panels` 加 `mode` 列或新表）。
4. 面板标题栏「刷新/复制/移除」目前是标题栏内按钮；加载进度只有圆点 + 文本，4.3 可加进度条。
