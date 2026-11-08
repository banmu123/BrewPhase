# BrewPhase 项目长期约定

跨会话都要遵守的项目级事实与规矩。日常流水记在 `YYYY-MM-DD.md`。

## 本地化流水线（`Tools/Localization/`）

* 文案键 = **源码里的中文字面量**，`strings.py` 的 `EN` 给英文；`generate.py` 只把
  `source_keys()` 里出现过的键写进两个 `.lproj` 表，所以**表里没有的键在运行时会
  原样返回键本身**。
* 收集规则（`keys.py`）：字面量含汉字 → 算键；**只含中文标点、但出现在 `L(...)`
  行上**的也算键（`L("、")`、`L("。")`、`L("%@：%@")`）——判据是「在不在 `L(` 调用
  里」，因为 `L()` 的参数按定义就是要翻译的文案，而 `CharacterSet(charactersIn: "。，")`
  这种解析用的字面量不在 `L(` 行，不会被误收。
* 标点也是文案：中文句读不能照搬到英文（列表分隔符 `、`→`", "`、句号 `。`→`". "`、
  括号前留空格）。**不要在 Swift 里写死 `"。"/"，"/"、"/"；"` 再拼进展示文本**——
  走 `L()`，否则英文界面会读到「Washed，Light。」。展示文本的落点是
  `DocumentBuilder`（索引正文，也是回答里显示的那段）、`BeanKnowledgeInsight`、
  `DiagnosticResult`。
* `check.py` 五条：占位符数量、键是否齐全、两表键集一致、同键不重复定义、
  可本地化字面量不能再插值（`Text("\(n) 天")` 会变成不可翻译的键）。
  含插值又含汉字、且同一行没有 `L(` 的字面量会被判违规。
* 改完文案必须跑 `generate.py && check.py`（当前 1068 键）。

## 测试与模拟器

* 真实验收口径是 `xcodebuild test` 全量 + 模拟器截图 + OSLog，三者对得上才算过。* **判断全量是否真的绿**：`grep "Fatal error"` 必须为空，且末行是
  `** TEST SUCCEEDED **`。测试进程崩了会被 runner 重启，「Executed N tests」
  会混入多次启动的分段统计——Phase 3 的「600 通过」就是这么误判的（真因是
  `DemoData` 标签表越界，Phase 3.1 已修）。当前基线 625 条。
* 单测**必须**在 `setUp` 里 `LanguageManager.pinForTesting(.simplifiedChinese)`：
  语言偏好存在 App 的 UserDefaults 里，测试宿主与 App 共用容器，
  `Tools/run.sh --lang en` 会把它改成 en，之后断言中文文案的测试就会红。
* `Tools/run.sh` 的截图与 `xcodebuild test` **不能同时跑**：测试宿主会抢走模拟器
  并重启 App，截图会拍到别的界面。先截图，再跑全量。
* `xcodebuild` 一律带 `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`，
  并显式指定模拟器 `platform=iOS Simulator,id=C7C7F583-310C-43CE-B6ED-D4915F465154`
  （iPhone 16 Pro；旧的 810C6408 已不在设备列表里，换机时先 `simctl list` 查）。
* **跑桌面端 `pnpm e2e` 前先停 `pnpm dev`**：`smoke.spec.ts` 用的是真实 userData，
  dev 实例占着单实例锁 → 新实例启动即 quit，表现为 `electron.launch` 超时或
  「page has been closed」。带 `BREWPHASE_USER_DATA_DIR` 的 spec 不受影响。
* 桌面端 dev 在本机受限环境要 `env -u ELECTRON_RUN_AS_NODE npx electron-vite dev
  --noSandbox`：前者让 Electron 退化成纯 Node（`electron.protocol` undefined），
  后者绕开不可用的 Chrome setuid sandbox。两个参数都不进项目配置。

## 数据一致性的既有规则（2026-11 起）

* **库存是台账**：`Brew.stockDeductedG` 记这条记录**实际**扣掉的克数；删除/编辑
  都按它算，不要用 `coffeeG`——袋里不够时两者不等。旧记录该字段为 nil 时按粉量退。
* **手动改剩余量 = 盘点**：`Bean.setRemaining` / 编辑器改剩余量会写
  `stockCountedAt`；`createdAt` 早于它的冲煮视为已结算，`BrewRecorder.delete`
  不再退粉、编辑不改库存。新增撤销路径时必须遵守这条。
* **烘焙天数是现算的**：界面/导出/索引统一读 `Tasting.resolvedDayAfterRoast`；
  存储的 `dayAfterRoast` 只给「豆子已不在」兜底。没有烘焙日期就是 nil（显示「—」），
  不许写 0 冒充 Day 0。
* **删豆子先取通知 ID**：级联删除不碰 `UNUserNotificationCenter`，顺序固定为
  「取 ID → 删库成功 → `unschedule(identifiers:)` → 重排」。
* **Schema 只有一个清单**：`BrewPhaseSchema.schema`，App 与测试共用。只允许加实体、
  加可选/带默认值属性；破坏性变更必须先确认旧库能打开或用户能导出原始库。

## Records 瀑布流的既有契约（Phase 3.1 起）

* **一次只落一条**：`InsertionSequence`（Features/Records）是唯一的动画队列；
  推进靠 `withAnimation(_:completion:)` 的完成回调，不再用「520ms 间隔 /
  760ms 清理」这类互相追的固定延时。2s 超时只是回调丢失时的兜底。
* **插入前复核**：`RecordsDataSource.canInsert(_:for:)` 要求数据源查询已切到
  当前条件、记录仍匹配、列表里还没有它；查询变化或离开页面就 `cancel()`，
  记录在保存时已落库，取消只停动画。
* **分页只有一个哨兵**：挂在「更高一列」的末尾，`footerColumn` 按
  `pageGeneration` 冻结；哨兵以代数换身份、每代只 fire 一次。不要恢复
  `autoLoadArmed` 那种双列共享闸门。
* **估算器媒体不钳制**：图片/封面高度 = 列宽 ÷ 宽高比，与卡片
  `.aspectRatio(.fit)` 同一条公式；文本行数上限仍是近似（只影响列归属）。

## Record 详情页（Phase 4 起）

* **展示决策只在 `RecordDetailPresentation`**：title / credit / content /
  personalNote / sourceURL。新增字段先想清楚归属，同一事实不许出现在两处
  （标题 vs 摘要、域名 vs 来源、正文 vs 备注）。
* **文字载体的 `note` 是正文**，永不进「我的备注」；标题只在 `record.title`
  非空时显示，不拿备注首行或域名冒充标题。
* **操作入口只有一个 More Menu**：编辑 / 打开原始来源 / 复制链接 / 删除。
  底部不再放删除按钮；删除仍走「删库成功 → 清文件 → dismiss」。
* **视频播放器由 @State 持有**（`.task(id: mediaPath)` 建一次）：不要在 body
  里 `AVPlayer(url:)`，任何重绘都会让播放从头开始。
* `refreshMetadata` 有快照保护：地址变了丢弃响应；用户写过的标题不覆盖。

## 同步：清空与自动推送（2026-11-08 起）

* **清空只清同步实体**（`Desktop/src/main/sync/wipe.ts`）：记录 / 标签 / 画布 /
  笔迹 / 这些记录引用的媒体 / 同步状态。**豆子、冲煮、品鉴、阶段规则保留**——
  这是产品边界，不做「恢复出厂」。
* **`POST /api/sync/wipe` 三件套**：已配对 token + HMAC + body 里的
  `{"confirm":"DELETE_SYNCED_CONTENT"}`。少一个就 400，空 body 不能删数据。
* **iOS 解除配对的顺序**：先清远端、再清 Keychain。反了 token 就没了、请求发不出去；
  远端失败时本地照清，文案区分「已断开」与「没清成」。
* **重新配对必须清基线**（`SyncManager.pair` 末尾）：否则首次同步只发增量，
  桌面缺的那部分永远补不回来。
* **任何数据变更自动推送**：`SyncAutoPush.install(container:)`（App bootstrap 注册）
  监听 Core Data 的 `NSManagedObjectContextDidSave` → `scheduleAutoSync` 2 秒合并，
  未配对直接返回，`isRunning` 与手动同步互斥。**不要逐视图埋点**——新视图会漏，
  通知一处收口覆盖咖啡+记录+画布+标签。
* 这条依赖由 `SyncAutoPushTests.testSwiftDataSaveFiresDidSaveNotification` 守护：
  SwiftData 换持久层时测试先红，而不是自动同步悄悄失效。
* 媒体 SHA-256 必须走 `fileSHA256` 的 `(路径,大小,mtime)` 缓存，否则每编辑一条
  记录就把所有视频重读一遍。
* **删除类 E2E 不能只断言列表数量**：切页后组件刚挂载、items 是空数组，
  `toHaveCount(0)` 会假阳性。直接开库查 `count(*)` 才作数。

## 链接播放器（Desktop，2026-11-08 起）

* **播放地址只由内容 ID 拼**（`src/shared/link-embed.ts`）：YouTube 11 位
  base64url、B 站 `BV`+10 位 / `av`+数字；**不读记录里的 urlString/canonicalURL**。
  与 iOS `LinkEmbed` 同一条规矩，新增平台先过这里。
* **CSP 的 `frame-src` 必须两处一致**：主进程 `applyCsp` 的响应头 + `src/renderer/index.html`
  的 meta。两者同时存在取交集，少一处就回退 `default-src 'self'` 把 iframe 拦死。
* **CSP 只发给主框架**（`resourceType === 'mainFrame'` 且是自己的文档）：给 iframe 里的
  第三方页面也下发会拦掉播放器自己的脚本（黑屏）。
* **iframe 导航由 `will-frame-navigate` 收口**，只放行播放器注册域；主框架走 `will-navigate`。
* **默认不挂 iframe**：点封面才创建；放大是把同一节点 fixed 铺满（不重挂，视频不从头开始）。

## Canvas（Phase 1 起）

* **CanvasNode 是摆放实例**：`canvasID` / `recordID` 两个 UUID + 世界坐标 + 逻辑
  尺寸，不复制记录内容；同一记录可进多块画布。没有 SwiftData 关系，
  删除必须走 `CanvasNodeStore`（记录删除、画布删除、示例数据三条路径），
  与删除同一次 save；删节点永远不删记录。
* **只存世界坐标**：屏幕位置 = 世界 × `CanvasViewport.scale` + offset；缩放只改
  视口。节点不再各自 `.position/scaleEffect`——`CanvasWorldLayer` 整层只做一次
  变换；手势在命名屏幕空间（`canvas-screen`）取位移，再 ÷ scale 得世界位移。
* **拖动只改内存**：`@State translation` 跟手，松手才 `CanvasNodeStore.move`，
  一次拖动一次写库；拖动中只临时抬 zIndex。
* **点击语义**：单击节点直接推 `RecordDetailView`；播放/暂停是独立 Button；
  备注/移除放 contextMenu（备注写 CanvasNode）。
* **列表缩略图**：`CanvasThumbnailPreview` 用全部节点算包围盒、最多绘 8 个
  （四类各一，其余按「离已选最远」补齐以覆盖整块画布），只读本地缩略图，
  不建播放器/WebView；`canvas.touch()` 驱动刷新。
* **节点加载只有一条路径**：`CanvasNodeStore.nodes(in:)`（throws）→
  `CanvasNodeReconciler.reconcile` → 渲染。**读取失败一个节点都不许删**；
  只有成功读到、确认某条记录不存在时才清理那一条，并 touch 受影响画布。
  不要再用 `try? ... ?? []`：查询异常会被当成「记录都不存在」，把整块画布
  的节点删光（2026-11-06 的真实故障）。
* **加载状态只有一个来源**：`CanvasContentLoader`（loading / loaded / empty /
  failed(.nodes|.records)）。**`.empty` 只能来自「节点读取成功 + 对账成功 +
  零节点」**；失败保留上一次的 nodes 与 recordsByID，绝不拿空数组冒充结果。
  节点在、记录读不到时画虚线占位卡，不要整块消失。
* **删画布只有一个事务入口**：`CanvasNodeStore.deleteCanvas`——节点查不出来就
  抛错且不删画布，保存失败 rollback。`deleteNodes(in:)` 已删除，别再加回来
  （它就是「先删节点、再删画布」两步里会漏掉的那一步）。
* **装窗只认 `GeometryReader` 的 `geo.size`**：本页上 `onGeometryChange`
  报过 800×800、2460×2976 这类占位/像素尺寸，按它算视口会把内容推出屏幕。
  尺寸变化且用户没动过视角时要重算；另有「整块内容都在屏幕外 → 重装窗」兜底。
* **删除级联要连带画布时间**：删记录 / 删画布 / 清示例数据后，受影响的画布
  `updatedAt` 必须更新（缩略图靠它刷新），且与删除同一次 save。
* **双指只用 SwiftUI `MagnifyGesture`**（锚点 = 起始两指中点）。**不要**换
  UIPinchGestureRecognizer 桥：真机上它会抢走捏合，缩放整个失效（2026-11-06
  实测，已回退）。代价是拿不到两指中心的实时位置，`pinched` 那套中心跟随
  没有落地——除非能在真机验证，不要再引入 UIKit 手势层。
* **点阵不能按比例隐藏**：屏幕间距要钳在 14–40pt（世界间距按 2 的幂自适应）。
  旧实现在间距 <12pt 时整块 return，装窗到 36% 时画布看起来是一片空白。
* **右下角是四个钮**：添加素材（实心，独立）/ 放大 / 缩小 / 适配 + 百分比。
  加号必须留给放大——它曾经被做成「添加」，用户就再也找不到放大入口。
* **素材面板要显示内容**：每行 64pt 缩略图（图片/视频封面/网页预览/文字细线），
  不是只有图标 + 标题。没有本地预览才回退图标块。
* **备份 v4**：`canvasNodes` 是可选段；旧备份（v2/v3）不动设备已有节点；
  坏引用节点跳过并记日志，不失败整份备份。

## 代码风格

* 阈值集中在 `RAG/Rules/IntelligenceConfig.swift`；中文词表放 `Resources/*.json`
  （词表进 Swift 会被本地化流水线当成文案收键）。
* 纯逻辑放 `Core/`（Foundation），视图放 `Shared/Components/` 与 `Features/`。
* 结构化事实（`fact:*`）可以自带 `AnswerMarkup` 排版标记，界面按它分层渲染；
  引用编号由回答层统一加，事实本身不写 `[n]`。

## 工作流程约定（2026-10-14 起）

* **修改完成 → 先 push 远程 → 再询问 GPT**：问 GPT（ChatGPT《检查黄金风味代码》对话）前必须先把改动 commit + push 到 GitHub main，并要求 GPT 先看代码库再结合报告提问。GPT 的提示词按循环执行：执行 → push → 回报 → 问下一步。
* 询问 GPT 时**必须附上仓库地址** https://github.com/banmu123/BrewPhase （GPT 无需搜索即可核对远程 main；仓库对 GPT 可见）。

## CoffeeAI × ChatGPT 循环——会话交接（2026-10-15 深夜更新）

* **唯一权威交接文档：`Tools/CoffeeAI/review_queue/GPT_WORKFLOW.md`**（新会话必读）——含交互循环规范、ChatGPT 对话技术与选择器、状态快照、恢复步骤、阶段历史与关键决策。
* 当前状态：**Experiment E 设计包阶段（2026-10-16）**——GPT 设计评审终审 Q1–Q6 全部批准（裁定存档 gpt_replies/gpt_reply_experiment_E_design_ruling.md）：Q1 JSON schema v1{action/missing_variable_id/question/reason_code}+fail-closed 降级+变量注册表独立于 IntelligenceConfig；Q2 三候选零样本筛选（Qwen2.5-3B 对照/Qwen3-4B 主候选/7B 上限，开发集≠验收集，许可证前置）；Q3 轻粒度 synthetic+事实逐 claim 可追溯+轨迹七字段元数据；Q4 三层计分+门线（追问≥85%/误追问≤10%/接续≥85%/跳过≥90%/编造0/自然度降幅≤1）；Q5 E1 决策行为→E2 完整多轮（E1 达标≠E2 授权）；Q6 6 条单轮 clarification 不并入。设计包目录 `training/experiment_E_design/`（七件套待产出）。**训练仍未批准**；方法论参考 rasbt/LLMs-from-scratch（LoRA/指令微调/分类微调/裁判评测，概念参照非代码依赖，负责人指定）。GPT 额度 15:28 后恢复文件分析。
* 关键坑：**run_train.py 训练/烟测必须用隔离 venv python**（系统 python 无 mlx-lm，preflight 会拦截）；评测脚本用系统 python 跑即可。**评测脚本已参数化**（run_eval_generation_c.py --adapter-path/--out-prefix，D 用 evalD 前缀）。语义标层三层：成对格式/无残留（脚本可查）+ 逐句归属（只能语义审核）。
* ChatGPT 免费版额度每日 16:03（GMT+8）重置；发送验证必须查 **main 对话区独有词 + 输入框清空**；长消息尾部的独有词可能被虚拟列表截断——用消息开头的 commit 号验证。「Model not found」= 服务端故障，等额度刷新重发。
* ego-browser 任务空间纪律：单空间复用（taskSpace("chatgpt-coffeeai")）+ 每轮结束 `task.finish({ keep: [] })`；GPT 回复提取后**立即存档** gpt_replies/（两次漏存档教训）。
* Git 提交：Batch2e 系列 3aa74b6（plan）→ 02afaa9/e05c15d（plan v2/v3）→ 3650c0f/0778eb0/b527561（draft v1-v3）→ c6e6f91（v6 终审通过）→ aaeba79（落库 43 条）→ 74cecfd（Experiment D）→ 22cd5be（终审归档修订）。
