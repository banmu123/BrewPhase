# Android 架构

## 分层

```text
Compose Screen  ── 只渲染、只发事件
      │
ViewModel       ── 页面状态（StateFlow / mutableStateOf），不碰 DAO
      │
Repository      ── 唯一写入路径、事务边界、数据源协调
      │
Room DAO        ── 只做 SQL
      │
domain/engine   ── 纯函数：阶段、库存、比例、链接、提醒、预填
```

约束：

- UI 不直接引用 DAO；唯一例外是 `RecordDetailScreen` 通过 repository 读取，仍然不碰 DAO。
- 业务规则不写在 ViewModel 里。`PhaseEngine` / `StockLedger` / `BrewMath` 都是纯函数，
  因此可以脱离数据库与 Android 运行时做 JUnit 测试。
- 时间只在边界转换：数据库存 epoch millis，domain 用 `LocalDate`。

## 唯一写入路径

三个 repository 各自守一类不变量：

**`BrewRepository.saveBrew`** —— 一次事务里做四件事：

1. 校验（`BrewMath.validate`）；
2. 扣/退库存（`StockLedger`）；
3. 写冲煮记录（含 `stockDeductedG`）；
4. 维护风味时间线上的镜像品鉴。

任何一步失败，`Room.withTransaction` 整体回滚。编辑时**先读旧实扣量再改字段**——
顺序反了差额永远是 0，改粉量就不动库存。

**`BeanRepository.setRemaining`** —— 人工盘点：写 `stockCountedAtMillis`，此后更早的
冲煮不再参与自动退粉。

**`RecordRepository.saveRecord`** —— 链接识别结果（canonical / provider / contentID）
由 `LinkResolver` 产出后写入；标签关系在事务里"先清后插"。

## 状态与刷新

所有列表都从 Room 的 `Flow` 出发，经 `stateIn(WhileSubscribed(5s))` 变成 `StateFlow`。
数据一变，相关页面自动刷新，不需要手工 `notifyDataSetChanged` 之类的机制。

豆仓首页把 4 条 flow（豆、规则书、全部冲煮、偏好）`combine` 成一次 UI 状态，
避免每张卡片各查一次库。

## 画布坐标系

`CanvasNode` 存的是**世界坐标**：`positionX/Y/width/height` 与屏幕无关。

- 缩放与平移只作用于父层 `graphicsLayer`（`scaleX/scaleY/translationX/translationY`）；
- 拖动结束时才把位移（屏幕 px ÷ density ÷ scale）折算回世界单位并落库；
- 因此换设备、换缩放、退出再进来，节点都在原位。

## 依赖注入

`AppContainer` 手写单例：数据库、5 个 repository、MediaStore、ReminderScheduler。
没有引入 Hilt —— 这个规模的应用为此付出的构建时间与学习成本不划算。

## 数据库与迁移

- `version = 1`，`exportSchema = true`，schema 进 `app/schemas/`；
- `MIGRATIONS` 数组是唯一升级路径；**没有** destructive fallback；
- 外键全部显式声明（`CASCADE` 的语义见 `DATA_MODEL_MAPPING.md`）。

## 提醒

`NotificationPlanner` 是纯函数（可单测），`ReminderScheduler` 只做副作用：
取消旧闹钟 → 按新计划 `setAndAllowWhileIdle`。用非精确闹钟是刻意的：上午 9 点前后
几分钟的偏差可以接受，换来的是一台不必申请 `SCHEDULE_EXACT_ALARM` 的手机。

## 测试

- `app/src/test/`：领域层单测（JUnit4），当前 51 例全绿；
- `app/src/androidTest/`：依赖已声明，但本机没有设备/模拟器，**未执行**。

## 与其它端的边界

- iOS 是功能基准，Android 不改 iOS 业务逻辑；
- Desktop 同步协议未实现，也没有为 Android 私自定义任何数据格式；
- 跨端字段语义以 `docs/DATA_MODEL_MAPPING.md` 为准。
