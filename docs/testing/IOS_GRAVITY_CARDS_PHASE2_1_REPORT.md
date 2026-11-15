# iOS Phase 2.1：单卡片行程与倾斜速度响应 — 实施报告

日期：2026-11-15
基线：`923e9b2`（含 Gravity Cards Phase 2 `4986786`）
范围：**只改两处**——单卡片的横向行程、倾斜角度与速度的关系。
首页布局、三空间结构、数据、同步、导航一律未动。

---

## 1. 改动前的问题

两个问题都出在「参数组合」而不是算法错误：

| 问题 | 根因 |
|---|---|
| 单卡片只能滑 16pt | `WorkspaceGravityTravel.homeBounds` 对所有卡片一视同仁；而分区里即使只有一张卡，也仍占「整行 ÷ 3」的宽度，两侧各剩一半空白没被利用 |
| 倾斜越大越快感知不到 | 终端速度 ≈ `gravityScale ÷ 摩擦时间常数` ≈ 260 ÷ 0.10 = **2600 × 强度**，而 `maxSpeed = 240` → 只要强度超过 ~0.09（约 5.7°）就**全部撞到同一个上限**。所有倾角手感一样，正是这个原因 |

第二个问题尤其关键：不是「曲线不够陡」，而是**上限把所有倾角压平了**。

---

## 2. 文件清单

### 修改

| 文件 | 改动 |
|---|---|
| `Motion/WorkspaceMotionSettings.swift` | 重平衡动力学参数；新增 `tiltResponseExponent`、`singleCardSafeMargin`；补全注释说明每个参数对手感的影响 |
| `Motion/WorkspaceMotionController.swift` | 强度映射改为 `linear ^ 1.4`（**唯一一处**非线性） |
| `Motion/WorkspaceCardMotionState.swift` | `WorkspaceGravityBounds` 加 `Equatable` + `clamp(_:)` |
| `Motion/WorkspacePhysicsEngine.swift` | `update(bounds:)` 在边界变小时夹回越界位置并清该方向速度；摩擦底数钳 0.02（防 NaN） |
| `Motion/WorkspaceGravityField.swift` | 新增 `setBounds(cardCount:isEmpty:availableWidth:for:)` |
| `Features/Home/WorkspaceCardStackView.swift` | 单卡居中卡位；`onGeometryChange` 读真实宽度；`WorkspaceGravityTravel` 增加单卡与多卡两种推导 |
| `Core/WorkspaceStackLayout.swift` | 新增 `cardSlot(forDepth:cardCount:)`、`cardWidth(in:)` |
| `BrewPhaseTests/WorkspaceGravityTests.swift` | +17 条（38 → 55） |

**未改**：`WorkspaceHomeView`（布局零改动）、任何 `@Model`、Schema、同步、搜索、导航。

---

## 3. 单卡片移动范围怎么算

```
cardWidth  = (availableWidth + 2 × cardOverlap) ÷ 3      // 与三卡完全相同的公式
travel     = (availableWidth − cardWidth) ÷ 2 − safeMargin   // 小于 0 取 0
```

- `availableWidth` 来自 `onGeometryChange` 读到的**卡片行真实宽度**（不是屏幕宽度，
  所以 iPad 的内容上限 760pt 自动生效）。
- `cardWidth` 复用三卡的公式——**单卡不会被放大**，这是规格 §2.2 的硬要求。
- `safeMargin = 6pt`，保证卡片不会贴到页边。
- 垂直行程**完全不放宽**，仍是 6pt（上下是标题与相邻分区）。

实测（iPhone 16 Pro，内容宽 358pt）：`cardWidth = 140.7`、`travel = 102.6`。
实测截图测得 104pt（含 0.5pt 抗锯齿取整误差），是 Phase 2 的 **6.5 倍**。

### 为什么居中

三个卡位等宽（w）、相邻重叠 c，则整行宽 `W = 3w − 2c`。中间卡位的左缘是 `w − c`，
中心是 `(w − c) + w/2 = (3w − 2c)/2 = W/2` —— **恰好是整行中点**。
所以只要把单卡画在中间卡位、左右各放透明占位，就自动居中，且卡宽仍由
「整行 ÷ 3」决定。有单测用几何公式钉住这一点（`testSingleCardSitsInTheMiddleSlot`）。

用占位而不是 `Spacer()` 是关键：`Spacer` 会让卡吃掉整行宽度，变成整屏大卡。

---

## 4. 单卡片与多卡片的区别

| | 单卡片 | 多卡片（2–3 张） |
|---|---|---|
| 卡位 | 中间卡位 + 两侧透明占位 | 从第 0 位顺排 |
| 横向行程 | `(区域宽 − 卡宽)/2 − 6`，iPhone ≈ 103pt | `min(16, gutter−2)` = 16pt |
| 垂直行程 | 6pt | 6pt |
| 卡宽 | 140.7pt（与三卡相同） | 140.7pt |
| 个性参数 | 恒为第 0 层（responsiveness 1.0） | 按深度 1.0 / 0.85 / 0.72 |
| 空态卡 | **不放宽**，走多卡片边界 | — |

空态卡走保守边界是刻意的：它只是占位，给它整行行程会出现「没内容反而动得最远」。

### 卡片数量变化

- **3 → 1**：边界变大，`update(bounds:)` 只换边界、**不动位置与速度**——幸存的卡
  留在原处平滑继续，不跳变（`testGoingFromThreeCardsToOneDoesNotResetTheSurvivor`）。
- **1 → 3**：边界变小，越界的位置被 `clamp` 夹回、该方向速度清零；状态仍按稳定 ID
  保留，新卡从零开始（`testShrinkingBoundsClampsPositionInsteadOfLeavingTheSpace`）。
- **删除/替换**：`reconcile` 按 `WorkspaceCard.Identity` 对账，删掉的卡状态丢弃。

---

## 5. 倾斜角度 → 速度的映射

三层，各管一件事，**不重复叠加**：

```
① 死区      3.5° 以下 → 0
② 线性归一  t = (θ − 3.5°) / (25° − 3.5°)，钳到 [0,1]
③ 幂整形    intensity = t ^ 1.4          ← 唯一的非线性，只在控制器
④ 物理      a = intensity × 380 × responsiveness
            v *= 0.82^dt（≈0.58s 时间常数）
            |v| ≤ 210
```

### 参数为什么这么定

| 参数 | Phase 2 | Phase 2.1 | 理由 |
|---|---|---|---|
| `gravityScale` | 260 | 380 | 略提高，让中等倾角也够快 |
| `frictionPerSecond` | **0.10**（保留 90%/s） | **0.82**（保留 82%/s） | 旧值的时间常数是 10 秒——卡片像在糖浆里走，且终端速度被推到天上（见下） |
| `maxSpeed` | 240 | 210 | 略降，配合新摩擦让「接近满倾才贴近上限」 |
| `tiltResponseExponent` | — | 1.4 | 拉开三档差异；≥1.8 会让 8° 几乎没反应 |

摩擦时间常数 `k = −ln(1 − friction)`，终端速度 `v∞ = gravityScale × 强度 / k`：

| | 时间常数 | v∞ | 上限在什么强度开始生效 |
|---|---|---|---|
| Phase 2 | 9.5 s | 2476 × 强度 | **强度 > 0.097（≈ 5.5°）** —— 再大全部同速 |
| Phase 2.1 | 0.58 s | 222 × 强度 | **强度 > 0.95（≈ 24°）** —— 只有接近满倾才触顶 |

也就是说：旧参数下，只要倾斜超过 5.5°，卡片就已经在用上限速度跑，倾角再大也
没有区别；新参数下，从死区到 24° 的整段区间里速度都与倾角成正比。

**加速阶段也快了 16 倍**（时间常数 9.5s → 0.58s）：旧参数下小倾角要十几秒才接近
终端速度，用户根本等不到；新参数 0.6 秒到位，于是「同样 0.75 秒内，倾角越大
速度越快」这件事才第一次可见。

### 实测对比（同起点、同 45 帧 = 0.75s、行程给足不撞边界）

| 倾角 | 控制器强度 | 速度 | 位移 |
|---|---|---|---|
| 8°（轻） | 0.111 | **16.9 pt/s** | 7.1 pt |
| 15°（中） | 0.411 | **63.2 pt/s** | 26.8 pt |
| 22°（大） | 0.787 | **120.5 pt/s** | 51.9 pt |

- 速度 8° → 15° 是 **3.7 倍**，15° → 22° 是 **1.9 倍**，大到小合计 **7.1 倍**
  ——远超「几个百分点」的不可感知范围。
- 强度严格单调（0.111 < 0.411 < 0.787），位移也严格单调。

这组数字由 `testLargerTiltMovesFasterAndFurther` 在每次跑测试时打印并断言。

---

## 6. 新增测试（17 条，38 → 55）

### 单卡布局与行程（10 条）

| 用例 | 钉住什么 |
|---|---|
| `testSingleCardKeepsTheSameWidthAsInAStack` | 单卡宽度 = 三卡宽度公式，不被放大 |
| `testSingleCardSitsInTheMiddleSlot` | 中间卡位中心 = 整行中点（几何公式验证） |
| `testSingleCardTravelIsFarLargerThanSixteenPoints` | > 16 × 5，且垂直不放宽 |
| `testSingleCardTravelGrowsWithWiderScreens` | iPad 更宽 → 行程更大；极窄区域退化 0 不变负 |
| `testSingleCardSlidesBothWaysWithinTheSafeArea` | 左右都能滑到 ±travel（>90pt） |
| `testSingleCardNeverLeavesTheContentArea` | 卡宽 + 偏移后左右边缘都在安全边内 |
| `testMultiCardBoundsStayConservative` | 2/3 张仍 = homeBounds |
| `testEmptyCardDoesNotGetTheSingleCardTravel` | 空态卡不放宽 |
| `testGoingFromThreeCardsToOneDoesNotResetTheSurvivor` | 3→1 位置保留、不飞走 |
| `testShrinkingBoundsClampsPositionInsteadOfLeavingTheSpace` | 1→3 越界夹回、速度清零、状态按 ID 保留 |
| `testGrowingContentKeepsStatesByStableID` | 新卡从零、老卡保留 |

### 倾斜速度响应（7 条，控制器 + 引擎串联）

`tiltRun(degrees:frames:travel:)` 每帧喂传感器样本 → 取控制器输出 → 驱动引擎一步，
测的是**真实链路**而不是数学曲线本身。

| 用例 | 断言 |
|---|---|
| `testTiltIntensityIsMonotonicInAngle` | 8° < 15° < 22° 强度单调 |
| `testLargerTiltMovesFasterAndFurther` | 速度与位移都单调；大到小 ≥ 3 倍（实际 7.1 倍） |
| `testSustainedMaxTiltStopsAtTheSpeedCap` | 40° 持续 4 秒：不超上限，且 ≥ 90% 上限 |
| `testTiltInsideDeadZoneProducesNoSpeed` | 2° 完全无输出、无位移 |
| `testReleasingTiltDecaysSpeedNaturally` | 松手后衰减到 settled，停在新位置不回原位 |
| `testReversingTiltNeverTeleportsUnderTheNewDynamics` | 换向第一帧位移 ≤ maxSpeed/60，且速度仍为正（先减速） |

---

## 7. 全量测试与编译

```
xcodebuild test
Executed 797 tests, with 3 tests skipped and 0 failures
** TEST SUCCEEDED **
```

- Phase 2 基线 780 → **797**（+17），无删除、无弱化、无跳过。
- 3 条 skip 是跨端同步（需真实桌面端在线），与本次无关。
- `xcodebuild build`：**0 error、0 warning**（全量日志 grep 确认）。
- 本地化 `check.py`：1177 键通过，本次未新增文案。

---

## 8. 模拟器截图验证

单卡场景通过临时删除多余画布制造（验完已恢复演示数据）：

| 状态 | 卡片横向范围 | 宽度 | 中心 | 相对静止位移 |
|---|---|---|---|---|
| 静止 | 130.7–270.7pt | 140.0pt | **200.7pt**（屏心 201） | — |
| 右倾 `1,0` | 234.7–374.7pt | 140.0pt | 304.7pt | **+104pt** |
| 左倾 `-1,0` | 26.7–166.7pt | 140.0pt | 96.7pt | **−104pt** |

- 居中验证：中心 200.7 vs 屏幕中心 201，误差 0.3pt。
- 宽度验证：三种状态都是 140.0pt，与三卡场景完全一致 → 没有放大。
- 行程验证：±104pt，而 Phase 2 是 16pt；左右边界 26.7 / 374.7 都在 22–380 的内容区内。
- 多卡片未受影响：Coffee/Records 三卡行在右倾下位移 16.7pt，与 Phase 2 的 16.6pt 一致。

截图：`/tmp/bp-gravity21/{rest,right,left,single-rest,single-right,single-left}.png`（未入库）。

---

## 9. 尚未完成 / 待真机确认

1. **单卡 104pt 的手感是否「够明显」**——数值上比 16pt 大 6.5 倍，但真机上是否
   有「桌面上滑一张卡片」的感觉，只能上手。
2. **0.82 摩擦是否偏滑/偏黏**。新的时间常数 0.58s 是纸面推导；真机上可能觉得
   「一倾斜就冲出去」。调 `frictionPerSecond`（越小越黏）与 `gravityScale` 两个值即可，
   单测会守住单调性。
3. **幂指数 1.4 的三档差异**是否与直觉一致；偏「小角度没反应」就降到 1.2，
   偏「大角度没更快」就升到 1.6。
4. 滚动 / 键盘暂停链路、后台恢复、耗电发热、iPad 与深色模式、最大动态字体
   ——均未真机验证，与 Phase 2 相同。
5. 多卡片切换到单卡片时的**视觉过渡**：代码上位置保留、边界平滑放大，
   但 `Motion.settle` 动画是否让卡片看起来「跳了一下」，需真机看。
