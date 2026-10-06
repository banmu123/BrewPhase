# BrewPhase V2 第三批 —— 首次上手 / 空态 / 术语统一 / 可信库存 报告

本批目标只有一个：让 BrewPhase 从「功能完整」变成「第一次打开容易理解、每天
使用不费劲、长期记录不会烦」。零新模型、零迁移、零新 AI 能力；核心引擎与数据
结构一字未动。

---

## 1. 修改文件清单

| 文件 | 类型 |
| --- | --- |
| `BrewPhase/Features/Bean/BeanEditorView.swift` | 改（onboarding 重排 + 烘焙度必选） |
| `BrewPhase/Features/Bean/FlavorTagEditor.swift` | 改（+`CollapsibleFlavorTags` 组件） |
| `BrewPhase/Features/Brew/QuickBrewLogView.swift` | 改（结果页精简 + 复用折叠组件） |
| `BrewPhase/Features/Bean/BeanDetailView.swift` | 改（库存确认框 + 删除确认统一 + 空态文案） |
| `BrewPhase/Features/Brews/BrewHistoryView.swift` | 改（删除确认） |
| `BrewPhase/Features/Bean/TastingTimelineView.swift` | 改（间隔天数 + 空态 + a11y） |
| `BrewPhase/Features/Home/HomeView.swift` | 改（空豆仓文案） |
| `BrewPhase/Features/Ask/AskView.swift` | 改（发送按钮 a11y） |
| `BrewPhase/Features/Bean/FlavorWindowCard.swift` | 改（术语统一） |
| `BrewPhase/Models/BeanPhase.swift` | 改（title/shortTitle 术语） |
| `BrewPhase/Shared/Components/Chips.swift` | 改（PhasePresentation 术语） |
| `BrewPhase/Shared/Components/StarRating.swift` | 改（a11y label） |
| `BrewPhase/Core/PriorityEngine.swift` | 改（verdict 文案术语） |
| `BrewPhase/Core/ReminderKind.swift` | 改（术语 + recommendedByDefault） |
| `BrewPhase/Core/FlavorLibrary.swift` | 改（提醒默认值同源） |
| `BrewPhase/Features/Settings/MoreView.swift` | 改（提醒默认值 + 说明） |
| `BrewPhase/RAG/Retrieval/StructuredRetriever.swift` | 改（「阶段规则」措辞） |
| `BrewPhase/en.lproj` / `zh-Hans.lproj/Localizable.strings` | 重新生成（864 键） |
| `Tools/Localization/strings.py` | 改（+54 新键，−36 死键） |
| `BrewPhaseTests/ConsumptionAndPriorityTests.swift` / `NotificationPlannerTests.swift` | 改（断言随行为更新） |
| `Tools/V2-Batch-3-Report.md` | **新增**（本文件） |

## 2. UX 改动

* **首添豆 onboarding**：首屏只回答「这是什么豆」——豆名、烘焙日期、烘焙程度
  （带「必选」红字标记，五个档位**零预选**）、重量；烘焙商与照片移入
  「更多信息」折叠区（连同原有产区/处理法/价格）；风味标签默认折叠
  （新组件 `CollapsibleFlavorTags`，与 Quick Log 共用）。
* **空态全部说人话**：空豆仓「还没有你的咖啡豆 / 添加正在喝的豆子，BrewPhase
  才能帮你判断阶段和饮用顺序。/ [添加第一包豆]」；无冲煮记录「记下第一杯，
  之后才能看到你的参数变化和个人规律」；时间线空态「记一杯或随手记一笔，
  它的变化就会出现在这里」。没有一处是「暂无数据」。
* **结果页精简**：评分（★）→ 味觉轴 → 参数行 → 一句话诊断 → 上次建议验证卡 →
  「下一杯建议」单卡（抬起 + 一个旋钮 + 一句为什么）→ [查看完整分析] 折叠
  （证据/知识出处收进去）→ [再记一杯][完成]。
* **阶段术语统一**：养豆期 / 风味打开 / 黄金风味期 / 风味衰减——PhaseCard、
  TodayCard、图例、统计 chip、提醒文案、Insights、规则页、实验预测全部同词；
  enum case 名不动。
* **删除确认统一**：删除豆子 / 冲煮记录 / 风味记录全部先过确认框
  （「删除这包咖啡豆？」「删除这条冲煮记录？」「删除这条风味记录？」+ 一句
  后果说明 + [删除][取消]）；长按菜单不再直接删。
* **提醒降噪**：推荐提醒默认开（进入黄金风味期 / 黄金期将尽 / 喝不完提示），
  养豆完成与黄金期过半默认关；设置页一句话说明默认策略。

## 3. 首次使用流程变化

```
之前：添加豆子 → 8 行首屏（含照片/烘焙商）→ 风味标签 30+ 词全铺开
      → 烘焙度默认浅烘（悄悄决定阶段）→ 保存

现在：添加豆子 → 豆名 / 烘焙日期 / 烘焙程度（必选，零预选）/ 重量
      → 「更多信息」折叠着 → 风味标签折叠着 → 保存
      没选烘焙度：保存被拦下，红字「选一个烘焙程度吧，阶段判断要靠它」
```

## 4. Quick Log 最终操作步骤数量

默认路径（参数沿用上一杯）：打开 → 确认豆（已预选）→ 确认方式（已预选）→
点评分 → （可选）点味觉轴 → 记下这一杯 → 完成。**核心路径 3 次点击**；
调整参数或风味各需一次展开。保存按钮常驻底部安全区，不被键盘遮挡。

## 5. 「无数据 / 数据不足」处理方式

* 诊断引擎门槛早已存在：个人基线不可用（如只有 1 杯）→ `.insufficient`，
  **不给建议**；本批把这句话提到结果页第一屏——「目前「…」有 N 次带评分的
  记录，还差 M 次…」+ 「继续记几杯，BrewPhase 会用你自己的数据给出建议。」
* Insights「下一步」在数据不足时整块不出现；「我的最佳参数 / 和平时比」
  沿用真实样本阈值（「证据不足，先不给结论」）。
* 提醒：数据不足的豆子不会排「喝不完提示」（引擎只在数字真实时排）。

## 6. 库存一致性处理

* 剩余量 > 总容量：保存前弹确认框「剩余量高于总容量 / 保存后这包豆的总容量
  会从 200g 变成 270g。历史记录不受影响。/ [把总容量调整为 270g][取消]」
  ——**不悄悄扩容**，得到用户点头才写；行内的即时提示保留。
* 已喝完的豆子：`PriorityEngine.todaysPick` 直接排除（本批确认，非本批改动）；
  恢复到在喝只改状态与库存显示，历史 Brew / Tasting 一律不碰（第二批语义）。
* 删除确认统一后，「清理无用的图片」等维护操作仍保留直接执行（低风险）。

## 7. Accessibility 检查结果

* **颜色不再单独承载语义**：阶段处处有文字（PhaseCard 标题、图例、统计 chip
  全是文字+色点组合）；评分只读组件补 `accessibilityLabel("N 星")`。
* **图标按钮补语义**：Ask 发送（「发送」）、风味自定义加号（「添加自定义
  风味」）、折叠风味（「添加风味/收起风味」）。
* **时间线整行合并**（`accessibilityElement(children: .combine)`），VoiceOver
  一次读完「Day 9 · 4 星 · 酸 3 甜 4 · 9月30日 · 冲煮记录」。
* 烘焙度选择区标 `accessibilityElement(children: .contain)`，五个档位可逐一切换。
* Dynamic Type：项目使用固定字号体系，本批未做全面改造（见 §11）——按规格
  「只补足语义，不改视觉风格」执行。

## 8. Localization 检查结果

```
Localisation check passed — 864 keys, both tables complete, placeholder counts match.
```

本批 +54 新键；清理 36 个因术语统一而退场的死键（「黄金窗口」「太新」「窗口
过半」等全套旧说法）。杯数 / 天数 / 克数全部走 `L()` 键（`+%@ 天`、`把总容量
调整为 %@` 等），无硬编码。

## 9. Test / Clean Build 结果

```
Executed 330 tests, with 0 failures (0 unexpected) in 44.3s
Clean build（清空 SYMROOT/OBJROOT）：** BUILD SUCCEEDED **，项目代码 0 警告
```

两个测试随行为更新：提醒默认值（3 开 2 关）、verdict 文案（黄金风味期）。

## 10. 本批没有改动的核心模块

`PhaseEngine` / `PriorityEngine` 评分逻辑 / `PersonalBaseline` /
`AdjustmentPlanner` / `BrewDiagnosisService` / `BrewDiagnosticEngine` /
`BrewRecorder` / `BrewPrefill` / `BrewDelta` / `ImageStore`（事务顺序为第二批
成果，本批只确认）/ `ConsumptionEstimator` / RAG 检索与回答链 / SwiftData
schema（零迁移）。`ReminderPreferences.current()` 的默认值变化是本批唯一的
行为变更，且有测试钉住。

## 11. 下一批最值得处理的 3 个问题

1. **Dynamic Type 全面适配**：固定字号体系在大字号下会截断；建议引入
   `@ScaledMetric` 与相对字体（工作量集中在一轮排版回归）。
2. **提醒内容的个性化**：现在所有豆子共用五档模板；下一步可以让「喝不完
   提示」引用用户真实消耗速度的历史（引擎已有数字）。
3. **导出 / 备份的引导**：数据都在本机，但「导出」入口深在更多页第三组；
   可以在设置页顶部给一个一次性的备份提醒。
