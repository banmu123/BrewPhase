# BrewPhase V2 第五批报告 —— 1.0 首发验收

日期：2026-10-06 · 基线：`142a113`（第四批）· 本批性质：**不加功能，证明可靠性**

本批按规格执行：先审计（状态矩阵、日期/Phase 边界、极端输入、库存漂移、幂等、try?、权限、隐私、导出、图片、数据量、开发痕迹、实验开关），再只修 P0/P1，最后给出验收结论与评分。

---

## A. P0 问题（数据正确性）

**结论：未发现未修复的 P0。** 新增 `ReleaseAcceptanceTests.swift`（13 个测试）把发布前必须为真的事实全部钉住，343 项测试 0 失败：

| 审计项 | 结果 | 钉住的测试 |
|---|---|---|
| 库存漂移（连续编辑 15→18→12→20） | ✅ 每步按差值调整，无累计漂移；反复保存只产生 1 条记录 | `testConsecutiveEditsNeverDriftTheStock` |
| 编辑后删除 | ✅ 还回编辑后的 18g，库存精确归位 | `testDeletingAnEditedBrewRestoresWhatItNowCosts` |
| 喝完后删 Brew | ✅ 库存回血>0 自动离开「已喝完」 | `testDeletingABrewAfterTheBagWasMarkedFinished…` |
| 标记喝完/恢复幂等 | ✅ 重复执行零副作用：不动库存、不删 Brew/Tasting | `testMarkFinishedAndRestoreAreIdempotent` |
| Phase 精确边界日 | ✅ restEnd-1=养豆、restEnd=打开、peakStart=黄金、peakEnd-1=黄金、peakEnd=衰减（数字从规则推导，不硬编码） | `testPhaseBoundariesReadExactlyAtTheRuleEdges` |
| 极端天数 | ✅ 365/3650=衰减、-3/0=养豆，无空 phase | `testExtremeDaysAreStable` |
| 跨月/跨年读数 | ✅ 9/30→10/1 与 12/31→1/1 都是 Day 1（Asia/Shanghai 时区） | `testReadingAcrossMonthAndYearBoundaries` |
| 日期基础 | ✅ 当天=Day 0、跨月/跨年/闰日/时刻无关（既有 5 个测试复核通过） | PhaseEngineTests 既有 |
| 全库喝完不推荐 | ✅ | `testAllFinishedCellarHasNoPick` |
| 单豆无记录可推荐且理由可读 | ✅ | `testSingleUntouchedBagIsStillThePickWithAReadableReason` |
| 排名确定性（含零库存/极老豆） | ✅ 两遍排名一致 | `testRankingIsDeterministicUnderOddData` |
| 小样本估算（1 杯） | ✅ 粉量取该杯、节奏保守按一天一杯、不假装精确 | `testSingleSampleGivesAConservativeHonestEstimate` |
| 数据量冒烟（50 豆/300 Brew/150 Tasting） | ✅ 秒级完成、每包有阶段、排名稳定 | `testCellarOfFiftyBeansWithHundredsOfBrewsRanksStably` |

**审计过程中发现并修正的一处测试误用**：初版漂移测试错用了 `BrewRecorder.apply`（它是失败回滚用的低层字段写入器，不管库存）；App 真实编辑路径是 `save(draft, bean:, existing:)`。改用真实路径后确认**无漂移**——这条注释已写进测试，防止后人再犯。

## B. P1 问题（流程不能断）

1. **双击重复保存（已修复）**：四个保存入口（QuickLog / BeanEditor / BrewEditor / TastingEditor）均无重入防护，双击可产生重复记录与重复扣库存。已加同步守卫（成功才置位、失败可重试），未引入新状态框架。
2. **全角时间输入（已修复）**：`parseTime("２：３５")` 原本返回 nil——中文键盘全角数字是常态。接入 ICU `Fullwidth-Halfwidth` 变换，`２：３５`→155、`2．35`→150，纯 ASCII 行为不变。
3. **Ask 无法回答的体验（复核通过）**：数据不足时说「目前有 N 次带评分的记录，还差 M 次」；知识盲区说「暂时没有这包豆子的专属资料，下面显示的是更上层的通用知识」。无 Retrieval failed / Engine fallback 类技术词。
4. **导出审计（通过）**：JSON 含 beans/brews/tastings/reminders/phaseRules + formatVersion + 免责声明；空库导出有效；CSV 表头齐全。项目无导入功能——按规格只审计不新增。
5. **图片生命周期（复核通过）**：缺图返回 nil 不崩、缩略图/大图双写、替换三段式、孤儿清理（既有 8 个测试）；「thumbnail 缺失但大图在」由读取路径现场兜底。

## C. P2 问题（未来迭代）

- Dynamic Type 最大字号的逐屏走查（固定字号体系在 AX 档会紧；本批未改视觉）。
- 导出不含偏好设置（默认冲煮参数）。
- 粉量无上限校验：极大值会被 `remainingAfter` 夹到 0 并在保存条显示「保存后剩余 0g」——有提示但不拦截，属日记哲学的可接受边界。
- 「全喝完」首页状态没有独立调试屏（逻辑简单，代码走查 + 幂等测试覆盖）。

## D. 本次修改文件

- `BrewPhase/Features/Brew/QuickBrewLogView.swift` — save 双击守卫（`saved == nil`）
- `BrewPhase/Features/Bean/BeanEditorView.swift` — save 双击守卫（`didSave`）
- `BrewPhase/Features/Brew/BrewEditorView.swift` — save 双击守卫（`didSave`）
- `BrewPhase/Features/Bean/TastingEditorView.swift` — save 双击守卫（`didSave`）
- `BrewPhase/Core/BrewMath.swift` — parseTime 全角归一化
- `BrewPhaseTests/ReleaseAcceptanceTests.swift` — 新增，13 个验收测试
- 本报告

## E. 测试结果

| 项 | 结果 |
|---|---|
| Unit Test | **343 项，0 失败**（较上批 +13：发布验收套件；无删减） |
| UI Test | 项目无 UI Test 目标（以 simctl 截图流程代替） |
| Debug Clean Build | SUCCEEDED，0 项目警告 |
| **Release Build** | **SUCCEEDED，0 项目警告**（仅 AppIntents metadata 噪音） |
| Localization | 875 键，generate + check 通过（本批零文案变更） |
| 流程截图 | 10 组全通过：首启→首页→QuickLog→结果→详情→Timeline→Insights→Ask→**标记喝完→恢复**（`/tmp/bp-scenes5/`） |

## F. 全局审计结论

**try? 保留清单**（App 代码现存 44 处，全部逐条判读，无一涉及用户数据写入）：
- **UI 时序**（4）：App/AskView/QuickLog 的 `Task.sleep`（调试屏延时/滚动锚点）——睡失败等于没等，无害。
- **可选展示**（2）：PhaseRulesView/BeanEditor 的规则预取，失败退默认规则——预览而已。
- **照片**（1）：PhotosPicker `loadTransferable`，失败=没选上，用户重试。
- **随包资源**（7）：BundleResource/MethodRules/FlavorModelResources 读自带 JSON——只读、随二进制分发。
- **派生索引**（8）：向量检索 search/count/metadata 编解码——索引可全量重建（派生数据），失败走词法兜底。
- **可选引擎**（5）：Ollama 探测/调用——可选外部引擎，失败回退本地。
- **天气**（3）：缓存读写+超时——推荐只做微调。
- **图片目录**（6）：目录创建/枚举/大小统计——枚举失败=0 个文件；目录创建失败会让后续 write 抛错进正常错误路径。
- **演示与导出**（3）：DemoData 安装计数、ExportManager 临时目录清理、PhaseRuleBook 种子预取（失败→重播种，幂等自愈）。
- **SwiftData 用户数据写入的 try? = 0**（第一批清零后维持）。

**权限最小化**：通知=保存第一包豆时请求一次（`askedForNotifications` 只问一次）；定位=用户主动点「自动获取天气」时一次性；照片=系统 PhotosPicker（零权限）；无相机/通讯录/麦克风/HealthKit。

**隐私/网络**：核心数据路径（SwiftData/ImageStore/Export）**零网络依赖**。仅有的网络栈：① OllamaClient——仅当用户在高级设置配置本地 Ollama 才调用；② WeatherKit——仅 auto 天气模式，用户主动触发。无 Analytics/Crash 上报/遥测/remote config。

**开发痕迹**：print/debugPrint/TODO/FIXME/fatalError/空 catch **全部为 0**。

**实验开关**：关闭风味预测 → 卡片整体消失（`if isEnabled`），Bean/Brew/Phase/Insights 主流程零依赖（既有测试 + 代码走查确认）。

**升级兼容**：五批以来 schema 零变更、零迁移；`roastLevel` 缺失在 UI 层显式「未设置/必选」，从不悄悄写入 Light。

**不确定性语言**：全项目统一「约/实验预测/还不够/暂时没有」；禁用词（AI 推测/模型认为/预测准确率）零命中。

## G. 最终产品验收评分（§34）

| 维度 | 得分 | 说明 |
|---|---|---|
| Product（Home/Bean/Brew/Insights/Ask） | 92/100 | 五屏闭环完整、状态矩阵齐备；Dynamic Type 是唯一短板 |
| Reliability（持久化/保存/库存/图片/迁移） | 95/100 | 漂移/失败/幂等/回滚全被测试钉住；零迁移 |
| Usability（首启/快记/复用/错误恢复） | 93/100 | 3 次点击记完一杯；保存失败不丢输入 |
| Intelligence（诊断/推荐/基线/观察环） | 88/100 | 只说证据内的结论；方向判断诚实声明局限 |
| Trust（实验标注/不确定性/local-first/隐私） | 96/100 | 实验卡可关、核心路径零网络、权限最小化 |
| **Release readiness** | **91/100** | |

**结论：BrewPhase 已达到可提交 App Store 首发的程度。** 验收标准（陌生用户从空库开始，不看教程完成 添加→记录→分析→再冲→趋势 全程）已被 10 组真实路径截图与 343 项测试覆盖。剩余问题全部可放进 1.1：Dynamic Type 大字号走查、导出补偏好设置、极小屏三列统计真机复看、StoreKit 一次买断。

## H. 边界确认

本批未新增 LLM/RAG/服务端/账号/同步/ML/核心功能；Core 引擎零改动（仅 BrewMath.parseTime 输入归一化，纯增强）；产品定位未变。
