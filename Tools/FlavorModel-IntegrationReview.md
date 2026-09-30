# BrewPhase 风味窗口模型 — 对接复查记录

> 对接依据：`/Users/banmu/Brew/tools/BrewPhase-Model-Integration.md`（v1）
> 复查对象：`/Users/banmu/Brew/BrewPhase`（commit 见对接当次）
> 结论一句话：**模型接进来了、能跑，全量 156 项测试全部通过（含新加的 26 项）；
> 但模型包本身有一个数值缺陷，且 App 的字段覆盖面实测只有 85 个特征里的 13 个。
> 这两件事决定了它现在还不能当真。**

---

## 一、已经做完的

| 内容 | 位置 |
|---|---|
| 特征契约层（读 `feature_schema.json`，不硬编码 85 个名字） | `BrewPhase/ML/FlavorModelResources.swift` |
| 编码层（域模型 → 85 维，未知类别整组 0） | `BrewPhase/ML/FlavorFeatureBuilder.swift` |
| 推理层（Core ML、30 天曲线、窗口、缓存、降级） | `BrewPhase/ML/FlavorWindowPredictor.swift` |
| App 域模型 → 模型输入的翻译 | `BrewPhase/Services/FlavorInputFactory.swift` |
| 详情页卡片 + 折线图 | `BrewPhase/Features/Bean/FlavorWindowCard.swift` |
| 开关（更多 › 风味窗口 › 实验性风味预测） | `BrewPhase/Features/Settings/MoreView.swift` |
| 别名与数值缺省表 | `BrewPhase/Resources/flavor_mapping.json` |
| 模型产物 + 重编译脚本 | `BrewPhase/Resources/brewphase_xgb.mlmodelc`、`Tools/Models/compile_model.sh` |
| 验收测试 26 项 | `BrewPhaseTests/FlavorModelTests.swift` |

端侧实测（macOS 上直接跑 Core ML，比对 `reports/metrics.json`）：

- 逐天曲线与基准**吻合到 2.6e-6**（30 天里 29 天），峰值日 14、最佳窗口 [10,19] 与基准一致；
- 单条 30 天曲线约 **5.3 ms**（协议要求真机 < 1 秒），缓存命中 1000 次 0.4 ms；
- 未知产地 / 未知烘焙商 / 未知烘焙度不崩，对应 one-hot 整组 0，预测照常产出。

---

## 二、必须处理的问题

### P0 — `brewphase_xgb.mlpackage` 丢掉了 `base_score`，Core ML 的每一分都低 2.158

**证据。** `brewphase_xgb.json` 里 `learner.learner_model_param.base_score = 2.6580412`；
`.mlpackage` 的原始输出却与之成**严格常数差**，实测 30 天差值恒为 2.1580412，
正是 `2.6580412 − 0.5`（XGBoost 的旧默认 `base_score`）。未修正时曲线会掉到
**−1.08 分**，而模型文档写明输出范围是 1–5。

**根因。** `src/convert_coreml.py` 调 `xgb_converter.convert(booster, ...)` 时没有
处理 `base_score`；而且脚本的自检只比对**输入名字和个数**，注明了「运行时推理只能在
Xcode 里测」——这一步显然没做过，所以一直没暴露。

**改法（模型侧，推荐）。** 在 `convert_coreml.py` 里把 `base_score` 正确传给转换器
（或转换后对输出做同量补偿）并重新导出 `.mlpackage`，然后在
`flavor_mapping.json` 里删掉 `outputCorrection` 一节。那一节写明了它是什么、
数值怎么来的、以及什么时候该删——**这是临时补偿，不是设计**。

**App 侧现状。** 已在 `flavor_mapping.json → outputCorrection` 里补回该常数，
所以现在 App 给出的是团队训练出来的那个模型的分数。重新导出模型后必须删掉它，
否则会重复补偿。

### P0 — 协议 §6.1 的验收对照配错了 bag，那条测试永远过不了

协议要求「用 `predict.py __main__` 的示例 bag（Ethiopia/Guji/Heirloom/Natural/
Roaster_03/Light…）与 `metrics.json → example_curve.pred` 逐天对比」。

但 `example_curve.bean_id = bag_0000`，它是合成集的第 0 个 bag，真实属性是：

| 字段 | bag_0000（基准曲线的真正主人） | 协议里的示例 bag |
|---|---|---|
| variety | **Gesha** | Heirloom |
| processing_method | **Honey** | Natural |
| altitude | **1937.7** | 1800.0 |
| roaster | **Roaster_09** | Roaster_03 |
| development_time | **67.4** | 95.0 |
| packaging_type | **Box** | Bag |
| storage_temperature | **25.8** | 24.0 |
| 冲煮参数 | 来自该 bag 的**第一行 tasting** | V60 / 16 / 250 / 170 |

两者不是同一个 bag，拿示例 bag 去对基准不可能对上（实测逐天差 0.1–0.49）。

另外 `train.py → canonical_day_rows()` 才是基准曲线的生成方式，它有一个协议没提的
约定：**开封日写死第 3 天**（`opened_day = 3`），并忽略 bag 真实的开封时间。
App 侧按协议 §4.1 用了真实开封日，这是对的，但做基准对齐时必须把开封日设为 3。

**改法。** 把协议 §6.1 的对照改成：`bag_0000` 的属性（含首行冲煮参数）+ 开封日 3。
这条已经写进 `BrewPhaseTests/FlavorModelTests.swift → basisBag`，是可直接执行的验收。

### P1 — 转换器还有第二处保真问题：第 10 天有 0.0126 的残差

补回 `base_score` 之后，30 天里 29 天吻合到 2e-6，只有**第 10 天**偏低 0.0126。
特征上第 10 天唯一特殊的地方是 `days_since_roast = 10` 与 `days_since_open = 7`
两个整点，而前后两天的差值又完全对得上——这是某棵树在临界值上取值不同的特征。
App 侧没法干净地补，**只能靠重新转换模型**，届时这条测试会自动变严（断言写的是
「最多一天越界」，不是「就是第 10 天」）。

### P1 — 85 个特征里，App 实测只覆盖 13 个；而缺的那些才是有效的那批

以「槽位是否携带来自 App 的信息」为判据实测（one-hot 组只有匹配上的那个 1.0 算有信息，
结构性 0 不算；数值特征用训练均值补的不算）：

```
模型特征总数            : 85
携带 App 真实信息的槽位  : 13
其余                    : 72（默认值或结构性 0）

有信息的 one-hot 组 (5/9)：origin_country、origin_region、processing_method、roast_level、brew_method
没有的组 (4)            ：variety、roaster、packaging_type、storage_method
有真实值的数值特征 (7/11)：days_since_roast、days_since_open、dose、water_temperature、
                          water_weight、beverage_weight、brew_time
用训练均值补的 (4)       ：altitude、development_time、storage_temperature、grind_size
二值                    ：只有 opened（one_way_valve 走默认值）
```

换算成「模型真正在意的那部分，App 能不能提供」：模型 top20 重要性合计 63.7%，
其中 App 能提供 **49%**。

实测特征重要性（top20 内按组汇总）：

| 组 | 权重 | App 有吗 |
|---|---|---|
| `processing_method` 处理法 | **23.2%** | 有，但是自由文本 |
| `roast_level` 烘焙度 | **13.7%** | ✅ 有（枚举） |
| `days_since_roast` 烘焙后天数 | **7.6%** | ✅ 有 |
| `roaster` 烘焙商 | 5.4% | 有名字，但模型只认 `Roaster_01…20` 占位名，**必然对不上** |
| `storage_method` 储存方式 | **4.4%** | ❌ 缺 |
| `days_since_open` | 2.4% | ✅ 有 |
| `variety` 品种 | **2.2%** | ❌ 缺 |
| `origin_region` 产区 | 2.1% | 有，但是自由文本 |
| `storage_temperature` 储存温度 | **1.7%** | ❌ 缺 |
| `one_way_valve` 单向阀 | 1.0% | ❌ 缺 |

**而 `dose` / `water_temperature` / `water_weight` / `beverage_weight` / `brew_time` /
`grind_size` / `brew_method` 七个全部没进 top20。** 合成数据的真值曲线本来就只由
处理法、烘焙度、海拔、品种、储存决定，冲煮参数是噪声。

**建议的加字段顺序**：储存方式 → 品种 → 储存温度 → 包装类型／单向阀 →（海拔、发展时间）。
加的时候请用**枚举**而不是自由文本——`roaster` 那 5.4% 的权重谁都拿不到，正是因为模型的
类别值是 `Roaster_01…20` 这类占位名，自由文本永远匹配不上。
**不建议**为了这个模型去补「液重」或把研磨度改成 1–10——投入和收益不成比例。

#### 补充实测：补上「产地 / 品种」对**屏幕上那两个数字**几乎没有影响

拿一包浅烘水洗瑰夏跑真实链路，逐项看它到底改变什么：

| 输入 | 峰值日 | 最佳窗口 | 峰值分 |
|---|---|---|---|
| 巴拿马 · Boquete（产地+品种都认不出） | 12 | [7, 18] | 3.3870 |
| 同上 + 品种喂进去 | 12 | **[8, 18]** | 3.5095 |
| 埃塞俄比亚 · Guji（产地认得出，品种仍缺） | 12 | [7, 18] | 3.4013 |
| 同上 + 品种喂进去 | 12 | **[8, 18]** | 3.5222 |
| 埃塞俄比亚 · Guji，改处理法为**日晒** | **16** | [11, 21] | 3.4555 |

结论三条，都很具体：

1. **品种从缺到有**：峰值分 +0.12，窗口起点挪 1 天，**峰值日一动不动**。
2. **产地在 ①③ 之间切换**：峰值分差 0.014，峰值日与窗口**完全不变**。
3. **真正决定峰值日的是处理法**：同样一包豆子，水洗 12 天 vs 日晒 16 天，**差 4 天**。

原因写在生成器的真值公式里：峰值日只由「处理法 + 烘焙度 + 海拔」决定，产地与品种都不
参与；品种只影响峰值**分**（瑰夏 +0.25）。而卡片**不显示分数**（刻意的，避免做成「AI
品鉴师」）——所以**补 `variety` 字段之后，详情页那两个数字基本不会变**。

**因此补品种的理由应该是「数据完整性 / 将来真实数据模型要用」，而不是「现在的预测会更准」。**
顺便一提，`variety` 的别名表已经认「瑰夏 / 艺伎 / Gesha / geisha」了，只差 App 侧一个枚举
字段和一行映射——这是所有补字段里最便宜的一个。

### P1 — 处理法「厌氧日晒」没法对应到单一类别，需要先做个决定

模型的 `processing_method` 只能取 `Anaerobic / Natural / Honey / Washed` 之一
（一组必须恰好一个 1.0）。App 的「厌氧日晒」同时包含厌氧发酵与日晒两个概念，按协议
「不猜测」的原则整组留 0——**这意味着 App 演示数据里那包 Colombia Pink Bourbon 的处理法
信号是空的**。同类还有「拼配」。

要让它参与预测，得先决定它归到哪一类（或在 v2 加一个 `Anaerobic Natural` 类别）。
在决定之前，卡片会如实写一句「「厌氧日晒」对应不到模型认识的类别，这次没有参与预测」。

### P2 — 研磨度：App 存自由文本，模型要 1–10 相对刻度

`Brew.grindSize` 是「22 格」这种文本，而模型的 `grind_size` 是相对刻度、协议明令
**不可跨磨豆机比较**。App 侧选择留空（走默认值 5.5）并在卡片上说明，而不是做一次
假的换算。要真正用上，需要给每种磨豆机建一张刻度换算表——但看上面的权重，
这件事的优先级很低。

### P2 — 协议示例代码里的模型加载路径在端上是错的

`reports/ios_inference_sample.swift` 用
`Bundle.main.url(forResource: "brewphase_xgb", withExtension: "mlpackage")`。
Xcode 会把 `.mlpackage` 编译成 `.mlmodelc` 放进 Bundle，**端上找不到 `.mlpackage`**。
App 侧的实现先找 `.mlmodelc`、再退到 `.mlpackage` 并用 `MLModel.compileModel` 现编，
两种落法都能用。建议把示例代码一并改掉，否则下一个人照着抄会拿到一个永远 nil 的 URL。

### P2 — 本机 `sandbox-exec` 不可用，Xcode 编不了 Core ML 模型

`/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/echo ok` 直接返回
`sandbox_apply: Operation not permitted`。而 Xcode 的 `CoreMLModelCompile` /
`CoreMLModelCodegen` 两步都是包在 `sandbox-exec` 里跑的，于是**只要 `.mlpackage`
在 target 里，本机就编不过**（`ENABLE_USER_SCRIPT_SANDBOXING=NO` 也绕不开）。

**现状处理**：`.mlpackage` 移到 `Tools/Models/`（不进 target），改为随包携带预编译的
`BrewPhase/Resources/brewphase_xgb.mlmodelc`，用 `Tools/Models/compile_model.sh` 重新生成。
构建期不再需要 coremlc，任何机器都能编过。

**代价**：换模型必须重跑脚本。在 `sandbox-exec` 正常的机器上，可以把 `.mlpackage`
放回 `BrewPhase/Resources/` 恢复自动编译（加载器两条路都支持）。

### 已解决 — 工程自带测试的 10 项失败

首次复查时，工程自带测试有 10 项失败。在**未改动的干净检出**上跑同样逐字失败，
确认与本次对接无关；随后定位为**两处测试自身的问题**（不是产品代码），已修好，
全量 **156 项全部通过**。

- `PhaseEngineTests.testOpeningBeforeTheWindowChangesNothing`（8 条断言）
  测试想表达「烘焙后第 7 天之前开封不该有顺延」，但它把「第 N 天开封」直接传进了
  `openedDaysAgo`——那个参数是**从今天往前数**的天数。于是它实际问的是「第 20/18/15/13 天
  开封」，全都晚于窗口起点，引擎按设计给出了 3–7 天顺延。
  修法：改成 `openedDaysAgo: 20 - openedOnDay`，并顺手补上另一侧的断言——
  第 8 天开封应当已经损失 1 天，免得这条测试在「折扣根本不生效」时也照样通过。
- `NotificationPlannerTests.testABagOpenedLateGetsItsWindowRemindersPushedBack`（2 条断言）
  它断言 `onTime.map(\.kind) == [.windowEnding]`，但**同一个文件**里
  `testThePriorityNudgeAppearsWhenTheBagCannotBeFinishedInTime` 用完全相同的参数
  要求必须出现 `.brewPriority`。两处自相矛盾，而优先级提醒是后加的、专门有一节测试，
  所以是这一行没跟上——它写在只有四种提醒的年代。
  修法：按 kind 取出「窗口即将结束」那条再比，并补一条「按时开封的那包确实早于晚开封的」
  断言，把「the whole point」直接写进代码而不是只写在注释里。

---

## 三、其他小改动（为了对接顺手做的）

- `RoastLevel` 加 `Hashable`（`FlavorInput` 要用它当缓存键）。
- `AppLog` 加 `flavor` 通道。
- `PrefKey` 加 `experimentalFlavorPrediction`（默认开）。
- `Tools/Localization/strings.py` 加 27 个键并重新生成两份 `.strings`；
  `Tools/Localization/check.py` 通过（348 键，两表齐全，占位符数量一致）。
  别名表刻意放在 JSON 而不是 Swift 里，就是为了不把「埃塞俄比亚 / 水洗」这类**数据**
  混进待翻译的界面文案。

---

## 四、给模型方的三条建议

1. `convert_coreml.py` 的自检要从「输入名字对不对」升级成「**数值对不对**」：
   拿一条固定 bag 跑 30 天，和 `brewphase_xgb.json` 的预测比，误差超过 1e-4 就拒绝导出。
   本次两个保真问题都能被这一条挡住。
2. `metrics.json → example_curve` 里补上生成它所用的**完整输入**（bag_0000 的全部属性 +
   `opened_day = 3`）。现在这个文件只给了曲线和 `bean_id`，而合成集不在包里，
   验收方拿不到复现所需的输入——协议 §6.1 会因此写错配对。
3. 如果还想让模型真正有用，v2 的方向是**真实数据**，以及把 `processing_method` 这类
   高权重类别换成 App 侧能稳定提供的**枚举**而不是自由文本。

---

## 五、这次对接的影响面（改动边界）

交接时最该先看的一节：**哪些地方被动了，哪些地方一根线都没碰。**
下面每一条都是用 `git diff --quiet` 逐个核实过的，不是凭印象。

### 零影响 —— 可以放心

| 区域 | 结论 |
|---|---|
| SwiftData 模型 | `Bean` / `Brew` / `Tasting` **未改**，也没有新增 `@Model` → **不需要 store 迁移**，老数据原样可用 |
| 数据存储 | 预测**不落库**：只活在 `FlavorWindowCard` 的 `@State` 里，内存缓存上限 64 条输入 → 不新增表、不写记录、不涨数据量 |
| 导出 | `ExportDTO` / `ExportManager` **未改** → JSON / CSV 格式不变，**旧备份仍能还原** |
| 首页 / 冲煮 / 编辑器 / 规则页 | `PhaseEngine` / `PriorityEngine` 未改 → 「今天喝哪包」的排序与阶段判定与对接前**完全一致** |
| 提醒 | `NotificationManager` 未改 → 提醒时间不变 |
| 网络与隐私 | 推理全在本机（Core ML CPU），模型随包携带不下载 → 仍然没有账号、没有服务器、不上传任何东西 |

### 有影响 —— 只有这些

| 区域 | 影响 |
|---|---|
| 豆子详情页 | 阶段卡下方**多一张卡**（预计风味窗口 + 30 天折线图） |
| 更多页 | 「风味窗口」区块**多一个开关** + 一句说明 |
| App 体积 | **+200KB**（模型 180KB + 两份 JSON 20KB） |
| 本地化 | +27 个键 × 两份 `.strings`；`check.py` 会拦住新文件里没翻译的中文 |
| 测试 | +26 项（`FlavorModelTests` / `FlavorInputFactoryTests`），全量 156 项 |
| 构建管线 | 模型不再以 `.mlpackage` 声明在 target 里，改为**随包携带预编译 `.mlmodelc`**（原因见 P2）；换模型需跑 `Tools/Models/compile_model.sh` |
| 代码量 | 新增功能 1,669 行 |

### 两个「忘了就会错」的耦合

1. **`flavor_mapping.json → outputCorrection` 是给坏模型打的补丁。** 模型重新导出后**必须删掉**
   这一节；忘了删，每个预测会高 2.16 分，而且不会有任何报错。
2. **基准曲线现在有两份**：`Tools/Models/metrics.json` 和
   `FlavorModelTests.swift` 里硬编码的 30 天数组。换模型必须同步，否则验收测试红——
   这是有意为之的闸门，但它是需要维护的耦合。

### 顺带发现的仓库卫生问题（与对接无关，建议单独处理）

- **仓库里没有 `.gitignore`，而且 `.DS_Store` 与
  `BrewPhase.xcodeproj/.../UserInterfaceState.xcuserstate` 是被 git 跟踪的**
  （`git ls-files` 能查到）。后果：每次开 Xcode 或访达都可能污染 diff——本次
  `git diff --stat` 里就有这两条。建议加 `.gitignore` 并 `git rm --cached`。
- **模型产物在仓库里有两份**：`Tools/Models/brewphase_xgb.mlpackage`（888K）与
  `BrewPhase/Resources/brewphase_xgb.mlmodelc`（180K）。这是当前方案的必然代价
  （本机 `sandbox-exec` 不可用），但换模型时**两份都要更新**。
