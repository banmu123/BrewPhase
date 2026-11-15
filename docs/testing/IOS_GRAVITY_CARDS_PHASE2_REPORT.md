# iOS Phase 2：Gravity Cards 重力卡片交互 — 实施报告

日期：2026-11-15
基线提交：`1ed5b67`（Phase 1 三空间首页）
范围：首页卡片的设备倾斜运动。**不改首页结构、不改数据、不改同步。**

---

## 1. 改造前的首页结构

| 层 | 文件 | 现状 |
|---|---|---|
| 首页容器 | `Features/Home/WorkspaceHomeView.swift` | `NavigationStack > ScrollView > VStack`：页头 → 桌面同步入口 → 搜索框 → 三个分区 |
| 分区 | `Features/Home/WorkspaceCardStackView.swift` | 整区是一个 `Button`（点哪都进列表）；标题 22pt + 一行卡片 |
| 卡片 | `Features/Home/WorkspaceCardView.swift` | 纯展示，尺寸由 `cardAspect` 与列宽决定 |
| 几何 | `Core/WorkspaceStackLayout.swift` | `cardOverlap = 32`、`depthLift = 3`、`cardAspect = 0.9`、`visibleLimit = 3` |
| 数据 | `Features/Home/WorkspaceHomeFeed.swift` | `WorkspaceCard` 是 `@Model` 的投影，身份是 `WorkspaceCard.Identity`（实体 UUID 或空态） |

关键前提（决定了本阶段的实现方式）：

- 卡片**有稳定 ID**（`Identity`），不依赖数组下标 → 物理状态可以安全地按 ID 索引。
- 分区是**一个按钮**，卡片本身没有手势 → 运动只改渲染，按钮语义天然不受影响。
- 首个分区标题与卡片行只隔 `Metric.Space.xs = 8pt`，分区之间只隔 `20pt`
  → 垂直行程必须小于 8pt，卡片才盖不住任何标题。
- 工程 `UISupportedInterfaceOrientations_iPhone = Portrait` → 屏幕系与设备系固定对应，
  不需要按界面方向重映射。

检查结论：工程此前**没有任何 CoreMotion 使用**，也没有 `ScenePhase` 监听、没有传感器权限键。

---

## 2. 文件清单

### 新增

| 文件 | 职责 |
|---|---|
| `Features/Home/Motion/WorkspaceMotionSettings.swift` | 全部可调参数集中一处（死区、行程上限、重力尺度、摩擦、settled 阈值、固定步长） |
| `Features/Home/Motion/WorkspaceCardMotionState.swift` | 单卡状态（offset / velocity / rotation / settled / 个性参数）+ `WorkspaceGravityBounds` |
| `Features/Home/Motion/WorkspacePhysicsEngine.swift` | 每个分区一个的确定性物理引擎：重力 → 摩擦 → 上限 → 软边界 → 旋转 → settled |
| `Features/Home/Motion/WorkspaceMotionController.swift` | 唯一 `CMMotionManager`：基准校准、低通、死区、限幅、启停；数据源走协议注入 |
| `Features/Home/Motion/WorkspaceGravityField.swift` | 协调者：三个引擎 + 是否静止（`isQuiescent` 驱动时间线暂停） |
| `BrewPhaseTests/WorkspaceGravityTests.swift` | 38 条用例（引擎 20 / 行程 2 / 空间隔离 3 / 控制器与生命周期 13） |

### 修改

| 文件 | 改动 |
|---|---|
| `Features/Home/WorkspaceHomeView.swift` | 唯一 `TimelineView` 驱动物理；滚动 / 键盘 / 后台 / 推开详情 / 路由离开的暂停与重校准 |
| `Features/Home/WorkspaceCardStackView.swift` | 新增 `field` + `frameToken`；单卡渲染偏移与旋转（只加 `.offset` / `.rotationEffect`） |
| `Features/Settings/MoreView.swift` | 「重力卡片」开关（`EditorToggleRow`）+ 数据用途说明 |
| `Core/FlavorLibrary.swift` | 新增 `PrefKey.gravityCardsEnabled` |
| `Services/DebugLaunch.swift` | `value(for:)` 从 `fileprivate` 放宽到 `internal`（控制器要读启动参数） |
| `BrewPhase.xcodeproj/project.pbxproj` | 两个构建配置各加 `INFOPLIST_KEY_NSMotionUsageDescription` |
| `Tools/Localization/strings.py` + 两份 `.strings` | 4 条新文案，1177 键 |

**没有改动**：任何 `@Model`、`BrewPhaseSchema`、仓储、同步协议、备份、三个模块的业务视图。

---

## 3. Core Motion 的实现方式

- 单一 `CMMotionManager`，包在 `CoreMotionDeviceMotionSource` 里，由 `DeviceMotionSourcing`
  协议抽象；控制器只认协议，测试注入 Mock，全程不碰硬件。
- `deviceMotionUpdateInterval = 1/30`，回调在独立 `OperationQueue`（`brewphase.gravity.motion`），
  控制器在 `@MainActor` 上收样本——传感器线程与 UI 线程分离。
- 用 `CMDeviceMotion.gravity`，**不用原始加速度**：它是融合算法的输出，已滤掉用户主动的
  线性加速度，举起/放下手机不会被当成倾斜。
- 生命周期：`activate()` / `deactivate()` / `suspend()` / `resume()`；前两者清零，后两者
  在恢复时**重新采集基准**（见 §4）。

---

## 4. 姿态基准与屏幕方向映射

### 基准

进入首页（或从滚动/键盘/后台恢复）时记录当前 `gravity` 为基准 `g₀`，之后只用**相对量**：

```
Δx = g.x − g₀.x          // 设备右倾为正
Δy = g₀.y − g.y          // 底边下沉为正（屏幕 y 向下）
```

因此不假设用户平放手机：竖着、45°、躺着都从「当前这个姿势」开始，只有**之后的变化**产生运动。

### 为什么不用四元数做跨系变换

需求提示「不要直接对两个不同设备系的向量作差」。这里做了推导：设 `R₀`、`R` 为基准与当前
姿态矩阵，世界重力 `G` 恒定，则当前设备系重力 `g = Rᵀ·G`。若用完整相对旋转把 `g₀` 变到
当前系，得到的正是 `RᵀR₀g₀ = RᵀG = g`——与 `g` 完全相同，差值恒为零。**相对量只能来自
同一设备系下的分量差**（或称「相对水平」），这也是所有水平仪类应用的通行做法。
本工程锁定竖屏，设备系与屏幕系固定对应，不存在方向重映射问题。

### 符号（竖屏）

| 手势 | 重力变化 | 卡片 |
|---|---|---|
| 右边缘下沉 | `Δx > 0` | 向右 |
| 左边缘下沉 | `Δx < 0` | 向左 |
| 下边缘下沉 | `Δy > 0` | 向下 |
| 上边缘下沉 | `Δy < 0` | 向上 |

方向由 `testTiltMappingSignsFromDeviceGravity` 与 `testPitchSignMapsBottomEdgeDownToDownwardCards` 钉住。
**实机方向仍需人工确认**（见清单第 1 项）——符号常量集中在控制器一处，若与直觉相反改一行即可。

### 滤波

低通 `α = 0.35`（30Hz）→ 死区 `3.5°`（`|Δ| < sin3.5°` 直接归零）→ 限幅 `25°` →
按「超出死区的比例」线性给强度（过死区不跳到满力）。

---

## 5. 每张卡的运动状态

`WorkspaceCardMotionState`：`offset`（相对原始堆叠位置的偏移）、`velocity`、`rotation`、`settled`、
`settleStreak`、`responsiveness`、`extraFriction`。

- 引擎按 **`WorkspaceCard.Identity`** 索引（不是数组下标）：内容增删后，留下的卡保留自己的
  位置，新卡从原位进入，删掉的卡状态被丢弃（`testRemovedCardDropsItsStateAndNewCardStartsAtRest`）。
- 个性参数由**堆叠深度**决定，稳定不随机：前卡 `1.0`、中层 `0.85`、后卡 `0.72`；
  后卡摩擦更大（`extraFriction` 0.04 / 0.09），因此动得更慢。
- 三个空间用同一套参数（`responsiveness(forDepth:)` 不看 `AppTab`），不存在「某个空间的卡
  天生跑得更远」。

---

## 6. 物理：重力、惯性、摩擦、边界

半隐式欧拉，固定步长 `1/60`，`TimelineView` 的时间戳走累积器（单帧最多消化 100ms）：

```
a = gravity × 260 × responsiveness
v += a·dt ;  v *= (1 − 0.10 − extraFriction)^dt ;  |v| ≤ 240
p += v·dt
软边界：行程内自由 → 缓冲 4pt 内线性吸收 → 越界钳回并强衰减（不反弹）
rotation → clamp(v.x × 0.0032, ±1.3°)，平滑跟随
settled：无力 && |v| < 2.5 && 每步位移 < 0.08 连续 6 步
```

- **不做游戏式反弹**：越界只钳回 + 衰减，速度不反向 → 边界处不可能持续振荡
  （`testBoundaryDoesNotOscillate`）。
- **换向不瞬移**：速度有上限、加速度连续，换向第一帧的位移 ≤ `maxSpeed × dt`
  （`testChangingDirectionDoesNotTeleport`）。
- **静止后零计算**：settled 的卡直接 `continue`；整页 settled 且无重力时，时间线被暂停。

---

## 7. 三个空间如何完全隔离

两重保险，都是结构性的：

1. **每个分区一个 `WorkspacePhysicsEngine`**，各自持有自己的 `bounds`。Coffee 的引擎里没有
   Records 的卡片，物理上无处可去；渲染层也不做跨区裁剪。
2. **行程由真实布局推导**（`WorkspaceGravityTravel.homeBounds`）：
   - 水平 = `min(16, gutter − 2)` = 16pt，卡片最多滑到页留白内侧，**出不了屏幕**；
   - 垂直 = `min(8, 标题间距 − 2, 分区间距 ÷ 2)` = 6pt，**小于任何标题间距**，
     因此卡片无论怎么滑都盖不住自己的或邻居的标题。

标题本身不在运动层里：`header` 与 `stack` 并列，偏移只加在卡片上。

---

## 8. 原有交互如何保持不变

| 交互 | 为什么没受影响 |
|---|---|
| 点分区进列表 | 整区仍是同一个 `Button`；运动只加 `.offset` / `.rotationEffect`，`contentShape` 与外层 frame 未变 |
| 卡片点击区域 | 卡片本来就不是控件（`accessibilityElement(children: .ignore)`），点击由外层 Button 决定 |
| 页面滚动 | 未加任何手势；只**观察** `onScrollPhaseChange` 暂停传感器，不拦截事件 |
| 搜索 | `FocusState` 只用于暂停重力；搜索态下三个分区不渲染，引擎自然空转 |
| 布局尺寸 | 偏移不影响布局计算，ScrollView 内容高度不变；无动画修饰符作用于 offset |
| VoiceOver | 结构未变，仍是「进入 X，N 条内容」的单一元素；位移不会产生焦点跳变 |

---

## 9. 生命周期与复位

| 时机 | 行为 |
|---|---|
| 进入首页 | `configureGravity()` → 清空引擎 → `activate()` 采集基准 → 时间线起步 |
| 滚动 / 键盘 | `suspend()` + `calm()`：传感器停、重力归零、**速度保留**，卡片靠摩擦滑停；时间线继续跑到 settled |
| 滚动结束 / 键盘收起 | `resume()`：**重新校准基准**，输出归零后再采样（避免握姿差被当成倾斜） |
| App 进后台 | `suspend()`：停传感器、停时间线；**不重置位置** |
| 回前台 | `resume()`：重校准 + 保持原位置继续 |
| 推开详情（搜索结果） | `destination` 非空 → `teardownGravity()`；返回时 `configureGravity()` 从原始堆叠开始 |
| 进入任一空间 / 路由离开 | `onDisappear` → `teardownGravity()`；再次进入是全新一轮 |
| 关闭设置 / Reduce Motion | `gravityActive == false` → `field: nil`，完全静态；`deactivate()` 不启动传感器 |

---

## 10. 物理引擎测试

`BrewPhaseTests/WorkspaceGravityTests.swift`，**38 条，全部通过**。覆盖需求 §13 的每一项：

| 组 | 用例 |
|---|---|
| 方向（1–6） | 零重力不动、右/左/下/上四向、斜向 |
| 独立性（9–10） | 同一输入下三张卡位置不同、两次运行结果一致（确定性） |
| 上限（11–12） | 速度不超上限、位移不超行程 |
| 边界（13–14） | 停在边界不穿出、边界处不振荡 |
| 衰减（15–17） | 回正后速度衰减、最终 settled、settled 后不再更新、新重力能唤醒 |
| 连续性（18） | 换向第一帧位移 ≤ `maxSpeed × dt` |
| 步长（19） | 1/60 与 1/120 推进同样时长，结果差 < 15% |
| 内容变化 | 删卡清状态、新卡从零开始、深度变化换个性参数 |
| 空间隔离 | Coffee 的卡不在 Records/Canvas 引擎里；单空间输入不影响另一空间 |
| 行程 | 上限与布局双重收窄、池子变小行程变小 |
| 控制器 | 启动/停用/暂停/恢复、首帧校准、死区、滤波收敛、限幅、恢复后重校准、无传感器降级、调试注入 |

单测不碰真实传感器，也不宣称验证了手感。

---

## 11. 全量测试

```
xcodebuild test -scheme BrewPhase -destination 'platform=iOS Simulator,id=C7C7F583-…'
Executed 780 tests, with 3 tests skipped and 0 failures
** TEST SUCCEEDED **
```

- Phase 1 基线 742 条 → 780 条（+38），无删除、无弱化、无跳过。
- 3 条 skip 是跨端同步用例（需要真实的桌面端在线），与本次改动无关。
- 编译：`xcodebuild build` 无 error、无新增 warning。

## 12. 本地化

`python3 Tools/Localization/generate.py` → 1177 条；`check.py` 通过（键集一致、占位符匹配）。
新增 4 条：开关标题、开关说明、开启态说明、关闭态说明。

## 13. 性能

- 传感器 30Hz，回调在后台队列；`@ObservationIgnored` 保证它**不触发任何视图刷新**。
- 物理步进只在一条 `TimelineView` 里，进度 60/120Hz 由系统决定；单帧 9 张卡 × 十余次浮点运算。
- **静止即停**：全部 settled 且无重力时 `isQuiescent = true`，时间线暂停（SwiftUI 不再逐帧
  求值），只留 30Hz 传感器用于发现新的倾斜。
- 无自建 Timer / CADisplayLink，无重复 `CMMotionManager`，离开页面即 `deactivate()`。

**未测**：真实设备的耗电、发热、长时间掉帧——模拟器没有传感器，无法代表真实负载（见清单）。

## 14. 模拟器截图验证（方向与边界的客观证据）

模拟器没有设备姿态，因此加了调试注入 `-BrewPhaseGravityTilt x,y`（正常启动不生效）。
四张截图逐像素测量（iPhone 16 Pro，402×874pt）：

| 状态 | 卡片行左边界 | 卡片上边界 | 结论 |
|---|---|---|---|
| 静止 | 22.0pt | 312.7pt | 与 Phase 1 完全一致（未破坏原布局） |
| `1,0`（右倾） | 38.7pt | — | 右移 **16.7pt**，右边界 396.0 < 402，未出屏 |
| `0,1`（底边下沉） | 22.0pt | 318.7pt | 下移 **6.0pt**（= 垂直行程），未进入下一分区 |
| `-1,-0.5`（左+上） | 5.3pt | 307.3pt | 左移 16.7pt、上移 5.4pt，仍在屏幕内且低于标题下缘 |
| 关闭开关 + `1,0` | 22.0pt | 312.7pt | **与静止态完全一致**，传感器未启动 |

截图：`/tmp/bp-gravity/{rest,tiltRight,tiltDown,tiltLeftUp,disabled}.png`（未入库）。

## 15. 尚未完成 / 待真机确认

1. **真机手感与方向**：滚转/俯仰四个方向是否符合直觉、惯性是否自然、会不会抖——
   模拟器无法验证。方向常量集中在 `WorkspaceMotionController.ingest`，一处可改。
2. **俯仰在接近竖直握持时信号天然变弱**：`Δy ∝ cos(基准倾角)`，手机越接近垂直，
   上下倾斜带来的变化越小（物理正确：垂直的「桌面」上重力几乎全在面内）。
   平放/半躺握持时响应最明显。若实机觉得「上下没反应」，需要重新考虑基准策略。
3. **滚动与键盘的暂停链路**：`onScrollPhaseChange` 与 `FocusState` 在模拟器无法手指验证，
   只做了代码路径与单测覆盖。
4. **性能与耗电**：需真机长时间使用观察。
5. **iPad / 深色模式 / 最大动态字体**：未截图核对；行程按布局推导，理论上自适应。
6. **Reduce Motion**：只验证了门控逻辑（`gravityActive`），未在真机开启该辅助功能实测。
