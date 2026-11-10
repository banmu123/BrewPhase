# iOS → Android 功能对齐矩阵

状态含义（严格按实现与验证程度区分，不按"有没有界面"）：

| 状态 | 含义 |
|---|---|
| `NOT_STARTED` | 没写 |
| `IN_PROGRESS` | 写了但功能不完整，或有一部分是占位 |
| `IMPLEMENTED` | 功能可用，但没有针对它的自动化测试 |
| `TESTED` | 功能可用，且有真实执行通过的单元测试 |
| `BLOCKED` | 受环境或外部条件限制，当前无法完成 |

验证方式：`./gradlew :app:testDebugUnitTest` → **51 个用例，0 失败**（2026-11-10）。
`./gradlew :app:assembleDebug` → **BUILD SUCCESSFUL**，产出 `app-debug.apk`（约 44 MB）。

## A. 导航与整体结构

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 三个一级 Tab：Coffee / Records / Canvas | `navigation/BrewPhaseApp.kt` → `HomeTabs` | `IMPLEMENTED` | 无 | 底部 `NavigationBar`，三个 Tab 用 `rememberSaveable` 保持选中项 |
| 设置 / 问答 / 洞察为二级页面 | `navigation/BrewPhaseApp.kt` 路由 | `IMPLEMENTED` | 无 | 设置、洞察、Ask 都是二级路由，不占 Tab |
| 返回行为符合平台习惯 | 各屏 `TopAppBar` + 系统返回 | `IMPLEMENTED` | 无 | 系统返回由 Navigation 处理 |
| Tab 切换状态不丢 | — | `IN_PROGRESS` | 无 | 数据来自 Room，切回会重新加载；**列表滚动位置会丢**（没有用 `SaveableStateHolder`） |
| 字体缩放 / 多尺寸 | Compose 默认行为 | `IMPLEMENTED` | 无 | 未做平板专用布局 |
| 深色模式 | — | `NOT_STARTED` | 无 | 只实现了浅色；深色需要重校咖啡色相，没有校过就不假装支持 |

## B. Coffee 豆仓

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 豆仓列表（图、名、烘焙商、烘焙度、剩余、阶段、最近一杯） | `feature/coffee/CoffeeScreen.kt` | `IMPLEMENTED` | 无 | 列表按"该不该喝"排序：黄金期/衰减期在前，同阶段按烘焙日期 |
| 已喝完分区 | 同上 | `IMPLEMENTED` | 无 | 不隐藏历史 |
| 添加/编辑豆子（全字段） | `feature/bean/BeanEditorScreen.kt` + `BeanRepository.saveBean` | `IMPLEMENTED` | 校验规则 `BrewMathTest` | 名称、烘焙商、产区、处理法、烘焙度、烘焙/购买/开封日期、总重/剩余、价格、渠道、标签、备注 |
| 表单校验（含"剩余 > 总重则抬高总重"） | `BrewMath.validateBean` | `TESTED` | `BrewMathTest` 4 例 | 与 iOS 同语义：相信用户称出来的数字 |
| 五档烘焙度（含 `espressoBlend`） | `domain/model/Enums.kt` → `RoastLevel` | `TESTED` | `PhaseEngineTest` | 五档各自有独立默认窗口，拼配不并进深烘 |
| 豆子图片 | `BeanEditorScreen` 未接入选图；数据层有 `imagePath` | `IN_PROGRESS` | 无 | **编辑器里没有选图入口**；列表/详情可显示已有路径的图片 |
| 咖啡豆详情（阶段、库存、信息、冲煮、品鉴、操作） | `feature/bean/BeanDetailScreen.kt` | `IMPLEMENTED` | 无 | 含阶段轨、窗口天数、密封折算、库存、冲煮列表、品鉴列表、喝完/恢复/删除 |
| 手动调整库存 | `BeanDetailScreen` → `BeanRepository.setRemaining` | `IMPLEMENTED` | `StockLedgerTest` | 会记录盘点时刻，后续删除旧冲煮不再退粉 |
| 就这包豆提问 | 跳 `ask?beanId=` | `IN_PROGRESS` | 无 | 见 E 节：目前是关键词检索，不是 RAG |
| 标记喝完 / 恢复到在喝 | `BeanRepository.markFinished / restoreToActive` | `IMPLEMENTED` | `StockLedgerTest` | 只改状态，不动库存与历史 |

## C. 阶段引擎

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 四阶段（养豆/打开/黄金/衰减） | `domain/engine/PhaseEngine.kt` | `TESTED` | `PhaseEngineTest` 11 例 | 阶段命名与 iOS `BeanPhase` 一致 |
| 规则边界归一化 | `PhaseRuleData.normalized()` + `PhaseEngine.boundaries` | `TESTED` | 同上 | 窗口不能先结束再开始；衰减点不早于黄金期 |
| 密封期折算（每天 0.5 天，只算窗口开启后的部分） | `PhaseEngine.effectiveDay` | `TESTED` | 同上 | 与 iOS 逐行同算法；读数不会倒退 |
| 反函数 `dayReaching`（提醒用） | `PhaseEngine.dayReaching` | `TESTED` | 同上 | 保证提醒落在正确的早晨 |
| 缺烘焙日期 / 未来日期 | `PhaseReading.Problem` | `TESTED` | 同上 | 不猜 Day 0，直接说明 |
| 五档默认窗口 | `DefaultPhaseRules` | `TESTED` | 同上 | 数值逐项照抄 iOS（浅烘 3-7-28 等） |
| 自定义规则 | `PhaseRuleEntity` + `BeanRepository.saveRule/resetRules` | `IMPLEMENTED` | 归一化有测试 | 规则按 `roastLevel` 唯一，不用 UUID |

## D. 库存与冲煮

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 新建冲煮扣 `min(remaining, dose)` 并记实扣量 | `StockLedger.onBrewCreated` + `BrewRepository.saveBrew` | `TESTED` | `StockLedgerTest` 3 例 | `stockDeductedG` 与 `coffeeG` 分开存 |
| 编辑冲煮按实扣量差额调整 | `StockLedger.onBrewEdited` | `TESTED` | 同上 | 先读旧实扣量再改字段，顺序反了差额永远为 0 |
| 删除冲煮退真实扣除量 | `StockLedger.onBrewDeleted` | `TESTED` | 同上 | 旧记录退回 `coffeeG`；盘点结算过的一分不退 |
| 保存失败整体回滚 | `db.withTransaction { ... }` | `IMPLEMENTED` | 无 | Room 事务覆盖库存、冲煮、镜像品鉴；无故障注入测试 |
| 快速记一杯（少输入、继承上次） | `BrewEditorScreen` + `BrewPrefillBuilder` | `IMPLEMENTED` | 无 | 预填优先级：同豆上次 → 任意上次 → 用户默认 |
| 完整冲煮表单（7 项配方 + 评分 + 5 感官 + 标签 + 备注） | `BrewEditorScreen` | `IMPLEMENTED` | 无 | |
| 粉水比 / 时间解析（含全角） | `BrewMath` | `TESTED` | `BrewMathTest` 4 例 | `2:35` / `155` / `2.35` / `２：３５` |
| 冲煮历史 / 删除冲煮 | `BeanDetailScreen` + `BrewRepository.deleteBrew` | `IMPLEMENTED` | 无 | 删除后库存回补走同一段逻辑 |
| 编辑已有冲煮 | `BrewEditorScreen(brewId=...)` | `IMPLEMENTED` | 无 | **详情页没有"编辑这条冲煮"入口**，只能通过路由进入 |
| 冲煮诊断（酸/苦/平衡、与上一杯比较、调整建议） | — | `NOT_STARTED` | 无 | `BrewDiagnosticCard` / `AdjustmentPlanner` 未移植 |
| 品鉴手动新增/编辑 | 仓库有 `saveTasting`，**没有手写品鉴的 UI** | `IN_PROGRESS` | 无 | 详情页能展示与删除；新增入口缺失 |
| 冲煮镜像品鉴（`sourceRaw = brew`） | `BrewRepository.syncMirror` | `IMPLEMENTED` | 无 | 镜像 ID 稳定复用，多存几次不会长出重复节点 |
| 风味时间线（按天着色） | `BeanDetailScreen` 品鉴列表 | `IN_PROGRESS` | 无 | 只显示 `D{n}` 与评分/标签，没有 iOS 的图形化时间线 |

## E. Records

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 四种载体（link/image/video/text） | `RecordCarrier` + `RecordEditorScreen` | `IMPLEMENTED` | 无 | 每种载体有独立的表单分支 |
| 瀑布流（按原图比例） | `RecordsScreen` → `LazyVerticalStaggeredGrid` | `IMPLEMENTED` | 无 | 两列自适应，卡片高度随内容 |
| 搜索 + 标签筛选 | `RecordsViewModel` | `IMPLEMENTED` | 无 | 内存过滤（个人记录量级），输入即出结果 |
| 自定义标签（增/改/删、数量、多对多） | `RecordRepository` + `RecordTagEntity/Link` | `IMPLEMENTED` | 无 | 复合主键 `(recordId, tagId)` = 协议里的确定性标识 |
| 六个建议标签，仅在"空库"时播种 | `RecordRepository.seedSuggestedTagsIfPristine` | `IMPLEMENTED` | 无 | 用户删光后不会每次启动又塞回来 |
| 平台识别（YouTube/Bilibili/X/GitHub） | `LinkResolver` | `TESTED` | `LinkResolverTest` 17 例 | 含 `youtu.be`、`shorts`、`BV`、`b23.tv`、`/i/web/status`、GitHub 保留路径 |
| URL 规范化与去重 | `LinkURL.cleaned` + `findByCanonicalURL` | `TESTED` | 同上 | 去跟踪参数、排序 query、去 `www.` 与锚点 |
| 安全嵌入（只由平台 + 内容 ID 现拼） | `LinkResolver.embed` | `TESTED` | 同上 | 野地址一律 generic 且无播放器 |
| 视频播放 / 内嵌播放器 | — | `NOT_STARTED` | 无 | 详情页只有"打开原链接"（系统浏览器/外部 App） |
| 媒体导入（复制进应用目录 + 预览图） | `MediaStore` | `IMPLEMENTED` | 无 | 图片生成 1600px 预览；视频用 MediaMetadataRetriever 取首帧 |
| 媒体孤儿清理 | `MediaStore.cleanupOrphans` + 设置页入口 | `IMPLEMENTED` | 无 | 只删未被任何记录引用的文件 |
| 记录详情 / 删除 / 打开原链接 | `RecordDetailScreen` | `IMPLEMENTED` | 无 | 删除会带走画布节点（外键 CASCADE） |
| 链接元数据抓取（OG、GitHub stars、B 站信息） | — | `NOT_STARTED` | 无 | 字段已在实体里预留，没有抓取器 |
| 重复链接提示 | `DuplicateRecordException` + 编辑器错误提示 | `IMPLEMENTED` | 无 | 按规范地址判重 |

## F. Canvas

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 画布列表 / 新建 / 重命名 / 说明 | `CanvasListScreen` | `IMPLEMENTED` | 无 | |
| 无限画布 + 双指缩放 + 平移 | `CanvasWorkspaceScreen` | `IMPLEMENTED` | 无 | viewport 用父层 `graphicsLayer`，不写回节点 |
| 节点拖动 + **世界坐标持久化** | `CanvasNodeEntity.positionX/Y` + `moveNode` | `IMPLEMENTED` | 无 | 拖动结束才落库，拖动中只在本地 |
| 节点层级 / 备注 / 移除 | `bringToFront` / `updateAnnotation` / `removeNode` | `IMPLEMENTED` | 无 | 备注对话框 + `⋯` 菜单 |
| 从 Records 添加 + 同画布防重复 | `CanvasRepository.addRecord` + 唯一索引 | `IMPLEMENTED` | 无 | 重复时弹提示 |
| 删节点不删记录 / 删画布不删记录 | 外键方向 + `CanvasNodeStore` 语义 | `IMPLEMENTED` | 无 | 节点只存 `recordId`，不复制内容 |
| 适应全部内容 | 顶栏 `FitScreen` | `IMPLEMENTED` | 无 | 由节点包围盒算缩放与平移 |
| 手绘 / 橡皮擦 / 连线 / 分组 | — | `NOT_STARTED` | 无 | iOS 当前也没有 `CanvasStroke`，与基准一致地不做 |

## G. Ask（问答）

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 多轮对话 / 上下文 | `AskViewModel`（消息列表） | `IN_PROGRESS` | 无 | 每轮独立检索，没有真正的上下文延续 |
| 个人记录检索 + 引用 | 同上 | `IN_PROGRESS` | 无 | 关键词匹配豆/冲煮/品鉴，回答后列出引用 |
| 知识库检索（RAG） | — | `NOT_STARTED` | 无 | `knowledge_base.json`、`HybridRetriever`、`EntityGraph` 未移植 |
| 无证据时如实说明 | 同上 | `IMPLEMENTED` | 无 | 检索不到就直说 |
| 区分个人数据与知识库 | `AskCitation.source` 枚举 | `IN_PROGRESS` | 无 | 有来源字段，但知识库一侧没有内容 |

## H. Insights

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 今天喝哪包 | `InsightsViewModel` | `IMPLEMENTED` | 无 | 黄金期优先、窗口剩余最少者优先；没有就退到衰减期 |
| 最近一杯 | 同上 | `IMPLEMENTED` | 无 | |
| 与上一杯的变化 | 同上 | `IMPLEMENTED` | 无 | 同豆前一杯的评分差 |
| 参数偏差 | 同上 | `IN_PROGRESS` | 无 | 只有"样本 ≥ 3 才给"，且**证据文案硬编码中文**（英文界面会看到中文） |
| 我的最佳参数 | 同上 | `IMPLEMENTED` | 无 | 同豆最高分那杯 |
| 下一步建议 | 同上 | `IN_PROGRESS` | 无 | 只在"低于最佳"时给一句，规则很薄 |
| 证据不足提示 | 同上 | `IMPLEMENTED` | 无 | |

## I. 设置与数据

| iOS | Android 位置 | 状态 | 测试 | 说明 |
|---|---|---|---|---|
| 默认冲煮参数（V60 / 15g / 240g / 92°C） | `SettingsScreen` + `SettingsRepository` | `IMPLEMENTED` | 无 | 默认值与 iOS `@AppStorage` 一致 |
| 阶段规则管理（五档 + 恢复默认） | `SettingsScreen` → `RuleEditorDialog` | `IMPLEMENTED` | 归一化有测试 | 改完立即影响阶段计算（Flow 驱动） |
| 五种提醒 + 独立开关 + 默认值 | `ReminderKind` + `NotificationPlanner` + `ReminderScheduler` | `IMPLEMENTED` | 规划器无单测 | 默认只开三个推荐项；通知 ID 由本机 hash 生成 |
| 通知权限 | `ReminderScheduler.canNotify` | `IN_PROGRESS` | 无 | 只检查权限，**设置页没有申请权限的按钮** |
| 规则/豆子变更后重排提醒 | `ReminderScheduler.rescheduleForBean` | `IN_PROGRESS` | 无 | 方法存在，但**没有在保存豆子/规则后调用**（缺一条串联） |
| 示例数据（7 包） | — | `NOT_STARTED` | 无 | 只实现了"删除示例数据"，没有载入 |
| 完整备份 `.brewphasebackup`（v2–v4） | — | `NOT_STARTED` | 无 | 设置页明确写"尚未实现" |
| JSON / CSV 导出 | — | `NOT_STARTED` | 无 | 未做 |
| 媒体占用显示 / 清理 | `SettingsScreen` | `IMPLEMENTED` | 无 | 显示真实字节数 |
| 中英文界面 | `res/values`（EN）+ `res/values-zh`（ZH） | `IN_PROGRESS` | 无 | 主要界面已双语；**Insights 证据文案、Ask 回答、部分标签仍硬编码中文** |
| 运行中切换语言 | 设置里可选择，`SettingsRepository.setLanguage` 只存值 | `IN_PROGRESS` | 无 | 存了偏好但**没有真正调用 per-app locale**，切换后不会立刻变 |

## J. Desktop 同步

**整体状态：`NOT_STARTED`。**

| iOS / 协议 | Android | 状态 | 原因 |
|---|---|---|---|
| 扫码配对 `brewphase://pair` | CameraX + ML Kit 已引入，未写页面 | `NOT_STARTED` | 时间不足 |
| Token 存 Keystore | — | `NOT_STARTED` | |
| HMAC 签名（`x-bp-timestamp` / `nonce` / `signature`） | — | `NOT_STARTED` | |
| 实体同步（10 类） | — | `NOT_STARTED` | |
| 媒体分块（256 KB、断点续传、SHA-256） | — | `NOT_STARTED` | |
| 冲突 / 删除指纹 | — | `NOT_STARTED` | |
| 自动推送 / 手动同步 / 解除配对 | — | `NOT_STARTED` | |

**没有做任何"看起来同步了"的占位。** 设置页与导航里都没有同步入口，因为一个点了
没有真实行为的入口比没有更糟。

## K. 风味窗口预测（ML）

状态：`BLOCKED`。

iOS 用的是 Core ML XGBoost 产物（`Tools/Models/brewphase_xgb.mlpackage`）。Android 需要
先确认该模型的许可与可转换性（Core ML → ONNX/TFLite），再用**同一批输入**比对两端
输出。本次既没有转换工具链，也没有真机比对条件，因此不实现、不显示预测曲线，
也不在界面上放一个假的"峰值日"。

## L. 验收缺口（明确列出，不掩饰）

| 项 | 状态 | 原因 |
|---|---|---|
| 模拟器真实截图（Coffee/Records/Canvas/Settings 等） | `BLOCKED` | 本机 Android SDK **没有 system-images**，无法创建 AVD；下载镜像与启动模拟器在当前网络与时间条件下不可行 |
| Instrumented / Room 关系与迁移测试 | `BLOCKED` | 无设备、无模拟器；`androidTest` 依赖只有声明，未执行 |
| 备份跨端兼容（iOS 生成 ↔ Android 读取） | `BLOCKED` | 没有 iOS 真机生成的备份样本 |
| Desktop 真机联调 | `BLOCKED` | 同步客户端未实现 |
| Lint | `NOT_STARTED` | 未跑 `lintDebug`（时间不足） |
