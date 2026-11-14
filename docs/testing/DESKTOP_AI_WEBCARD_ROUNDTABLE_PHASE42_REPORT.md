# BrewPhase Desktop — 真实 WebCard 驱动的 AI 圆桌（Phase 4.2）交付报告

基线：`62d101c`（Phase 4.1）。交付提交见文末。

## 一、修改前后的架构差异

| 维度 | Phase 4.1（前） | Phase 4.2（后） |
| --- | --- | --- |
| 参与者身份 | 固定 provider（`'chatgpt' \| 'claude'`），渲染层选择 | **真实 WebCard 的 tabId**，来自圆桌 `participantTabIds` |
| 页面实例 | `AgentPageManager` 为每平台维护的**隐藏** WebContentsView | 用户拖入圆桌的**原始 WebCard WebContents**（零隐藏副本） |
| 平台识别 | 由渲染层传入 provider 决定 | 主进程 Registry 对实时 URL 严格主机匹配 |
| 同平台多卡 | 不可能（Map 按 provider 去重） | 天然支持，每卡独立参与者 |
| 任务输入 | `{ prompt, providers }` | `{ prompt, participantTabIds }`（渲染层只传 tabId） |
| 持久化去重粒度 | provider | **tabId**（metadata 记 tabId/displayName） |
| 登录方式 | 后台页 openHome（用户看不到） | 在原始卡片里手动登录，登录态即页面本身 |

核心原则落地：**WebCard 是 AI 成员的身份载体，Adapter 是平台操作能力，Roundtable 是统一调度空间。**

## 二、Registry 的设计

新目录 `src/main/ai-chat/adapters/`：

- `types.ts` — `AIPlatformAdapter` 接口（`matches / probe(context) / submit(context, prompt) / poll(context)`）、`AIWebCardContext`（tabId + 真实 WebContents + 实时 url/title）、`AIPlatformDescriptor`（识别元数据与自动化能力**分离**）、`createScriptAdapter` 底座（沿用 Phase 4.1 加固过的脚本纪律：基线先于发送、写入校验、JSON-only、多候选选择器）。
- `registry.ts` — `register / unregister / get / has / resolve(url) / isAdapted`。`resolve` 返回 `{ descriptor, adapter? }`：**已识别 ≠ 可自动交互**——未适配平台拿到描述符但拿不到 adapter，UI 明确显示「已识别 · 尚未适配」。
- `platform-catalog.ts` — 目录登记：chatgpt / claude（已适配）+ gemini / grok / deepseek（**只登记描述符，无 adapter**，规格 §13 明确不做）。新平台接入 = platforms/ 加一个文件 + 目录一行，圆桌核心零改动。
- `platforms/chatgpt.ts`、`platforms/claude.ts` — 从旧 `automation/adapters.ts` 迁移的脚本，旧文件改为**转发**（遗留 Multi-AI 路径行为不变，历史测试全绿）。
- `host-match.ts` — 严格主机名匹配（精确或子域后缀，`chatgpt.com.evil.io` 冒充不了）+ `BREWPHASE_AI_TEST_HOST` 测试接缝（按段路径 + 端口校验）。

调度算法抽取：`automation/poll-engine.ts`（probeWithRetry + pollUntilAnswerStable）。遗留 TaskCoordinator 改为调用引擎——其 8 条既有单测全绿，证明行为零漂移；圆桌路径复用同一引擎。

## 三、BrowserManager 如何解析真实 tabId

新增 `BrowserManager.resolveTabForAI(tabId)`：委托 `BrowserTabManager.get(tabId)`（内部已含 isDestroyed 检查），URL / title 从 WebContents **实时读取**。约束逐条满足：不创建视图、不 reload、不改父子关系（moveToWindow 语义不变）、销毁即返回 null。**只供主进程内部使用**——没有新增任何把 WebContents 或任意脚本执行暴露给 Renderer 的通道；`browserTabs.executeOnTab` 是既有通道且未扩大。

## 四、执行链路（participant-service）

`src/main/ai-chat/participant-service.ts`：

1. 校验 tabId ⊆ 当前圆桌成员（`RoundtableService.hasParticipant`，渲染层无法伪造身份）；
2. 逐个解析真实 WebContents + 实时 URL → Registry 识别 → 普通资料 / 未适配 / 已销毁页面**不参与也不报失败**；一个可参与的都没有时明确报错；
3. 问题先行落库（conversation + user message），同一份 prompt 并行发给全部可参与成员（`Promise.allSettled`）；
4. 每个参与者独立状态机（checking → sending → generating → completed/…），每轮轮询重新解析 tabId：**页面关闭立即 failed（tab closed）**、**URL 跳出 Adapter 域立即 failed**；
5. 平台一 completed 立即落库（按 tabId 去重），任务落定补写剩余终态；广播快照带 conversationId；
6. 并发保护：全局单任务 + tabId 去重 + 上限 `ROUNDTABLE_AI_MAX_PARTICIPANTS = 12`（schema 强制）。

成员被移出圆桌时立即终止对应任务：`RoundtableService` 新增 `onParticipantsChanged`（commit 时 diff added/removed）→ 装配层接 `ParticipantService.cancelParticipant`。

## 五、AgentPageManager 是否仍被圆桌调用

**否。** 全部引用检索确认：它只被遗留 `ai-chat-service` / `task-coordinator`（provider 型旧路径）使用。遗留栈整体保留（MultiAI / Accounts / Conversations 组件与 IPC 未删，行为不变），圆桌问答链路零引用。未删文件的原因：规格 §7 允许保留，删除旧路径会牵连历史契约与测试，收益为零。

## 六、同平台多个 WebCard 如何区分

任务记录 `runs: Map<tabId, ParticipantRun>`；快照 results 按 tabId 列出；回答卡 key = tabId，卡头显示 `平台名 + 卡片标题`，卡尾显示 tabId（内部诊断）。「查看原网页」= `browserTabs.activate(tabId)`，定位回答所属的**原始卡片**，不新建平台页。持久化 metadata 记 `{ tabId, displayName, note, url }`，provider 列仍是平台 id（不把 tabId 写进 provider）。

## 七、多窗口状态如何同步

主进程 `ParticipantService` 是唯一事实来源：每次状态变化向**所有**非 destroyed 窗口广播 `roundtable-ai-task:changed`（新通道，payload = 快照 + conversationId）。主窗口与圆桌独立窗口都通过 App 的全局订阅收同一份广播；成员识别（describe）是拉取式：挂载、成员增减、页面导航（URL 变化）、任务结束、手动「重新检测」时刷新。占位区（独立窗口运行时）显示任务状态摘要行。

## 八、持久化如何兼容旧记录

无 schema 变更。`provider` 列语义不变（= platformId，旧值 chatgpt/claude 照读）；`metadata` JSON 在原 `{ note, url }` 基础上**追加** `tabId / displayName` 字段——旧记录缺这两个键，读取方不依赖它们即可兼容。增量落库时序与 Phase 4.1 一致（问题先行、完成即写、终态补写），去重键从 provider 改为 tabId。

## 九、自动化测试结果

- typecheck ✅ / build ✅
- **Vitest 769/769 全过**（60 文件；新增 14：Registry 6 + ParticipantService 8）
  - Registry：子域识别、恶意域名拒绝、未适配不伪装、普通网页不误识别、注册/去重、接缝按段匹配；
  - ParticipantService（真 SQLite + 假 Adapter/页面）：同平台双卡独立回答、单失败隔离、提交时页面已销毁被过滤、非成员拒绝、任务中关页立即失败（tab closed）、cancelParticipant 单点终止 + 忙时拒绝、持久化按 tabId 去重且 metadata 正确、describe 四种状态；
  - 遗留路径回归：ai-chat-coordinator / ai-chat-service / ai-adapters / roundtable-service 全绿。
- **E2E**：全量 74 passed / 7 skipped / 1 failed。唯一失败仍是 `browser.e2e`「拖动与缩放」——Phase 4.1 时已用 stash 在干净 HEAD 验证过同样失败的**既有环境问题**（无 GPU 帧节流），非本次回归。
- 新增 `roundtable-ai.e2e` 4 条（本地夹具跑真实 probe→submit→poll）：
  1. 成员识别三态（AI 可参与 / 网页资料 / 需要登录）+ 只有 AI 卡出回答 + 登录卡如实显示 login_required；
  2. 同平台两卡 → 两个成员、两份回答、tabId 互不相同、内容各自回显真实输入；
  3. 多平台并行 → 先完成者先显示 → 拆出同步 → 归位不丢；
  4. 独立窗口发起 → 主窗口占位区同步进度与完成 → 归位后回答与草稿保留。
  - 过程中抓到并修掉两个真缺陷：① `ParticipantService` 构造时未把 broadcast 接到 notify（广播从未发出，主窗口永远看不到进度）；② `cancelParticipant` 漏设 `run.cancelled` 标志（状态改了但轮询循环不会停）。另记录 E2E 陷阱：`page.locator(...).last()` 是惰性定位器，多卡创建后统一取 `data-tab-id` 会全部解析到最后一张——必须在每张卡创建后立即取。

## 十、真实网页人工验收结果

**未执行**——需要真实账号在真实桌面环境操作。清单已备好：
`docs/testing/DESKTOP_AI_WEBCARD_ROUNDTABLE_PHASE42_MANUAL_CHECKLIST.md`（A 识别 / B 登录 / C 并行 / D 生命周期 / E 双窗口 / F 历史兼容，共 26 项）。
按规格要求如实声明：本地夹具 E2E 只能证明链路与调度正确，**不构成真实 AI 平台通过验证的结论**。

## 十一、未完成事项与下一阶段建议

- 真实平台人工验收（上表 26 项）待执行；ChatGPT/Claude 选择器随平台改版可能失效，失败时按清单 D 类场景定位。
- 平台状态探测目前是拉取式（挂载/变化/手动刷新），URL 变化的推送式识别可作后续增强。
- `AgentPageManager` 与遗留 provider 路径仍保留；确认无回归后可在未来阶段安全移除（引用面已收敛到 ai-chat-service + task-coordinator）。
- 参与者并发上限 12 为常量，未来可放入设置。
- 登录态探测依赖页面 DOM 信号（与 4.1 相同），Cloudflare 挑战页会显示为「状态未知」，需人工在卡片内通过。

## 十二、提交

- Commit：见交付消息（本报告随提交入库）。
- 修改文件清单：`git show --stat <sha>`（新增 adapters/ 六个模块 + participant-service + roundtable-ai 契约；改造 RoundtableSection / roundtable-ai-store / browser-manager / roundtable-service / index / register / preload；测试与文档）。
