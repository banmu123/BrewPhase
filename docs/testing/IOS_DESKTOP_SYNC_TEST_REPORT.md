# BrewPhase iOS ↔ Desktop 配对与数据同步专项测试报告

- 报告日期：2026-11-12
- 代码基线：`244b40c`（`main`，与 `origin/main` 同点）
- 桌面端版本：`0.1.1`（Electron `45.2.3`）
- 协议版本：`protocolVersion = 1`
- 测试性质：**专项定位测试**。本轮只做测试与记录，未修改任何生产业务代码，
  未触碰真实用户数据库，未执行 wipe。

---

## 1. 结论摘要

| 项目 | 结果 |
| --- | --- |
| Desktop 全量单测/集成（Vitest） | **507 / 507 通过**（37 个文件） |
| ├ 既有同步单测 `tests/unit/sync.test.ts` | 57 / 57 通过 |
| └ 本轮新增 `tests/integration/sync-special.test.ts` | **19 / 19 通过** |
| Desktop `typecheck` | 通过 |
| Desktop `build` | 通过 |
| iOS `SyncSpecialTests`（模拟器真实 XCTest 宿主） | **11 / 11 通过** |
| iOS `SyncCrossEndTests`（真实 HTTP + 真实 SQLite 联调） | **3 / 3 通过** |
| iOS 全量 XCTest | **716 / 716 通过**（0 failures，128s） |

**核心链路的正常路径是通的**：10 类实体全量首次落库、重复同步幂等、修改覆盖、
删除不复活、删除冲突保护、媒体分块与整文件校验、撤销授权立即失效、并发 apply
不重复写入，均已用真实 HTTP + 真实 SQLite（非 `:memory:`）验证。

**但有 2 个真实缺陷必须修**（详见 §5）：

1. **跨语言负零指纹漂移 → 实体永久假冲突**（P2，已被真实链路复现）。
2. **记录级联删除不清 `canvasNode` 基线 → 每轮同步固定产生一条 failed**（P2）。

另有 3 项按设计如此、但需要产品确认的边界（基线丢失后重推会"复活"已删数据、
单条删除留孤儿媒体、重复配对留下多个有效 token），见 §5.3–§5.5。

---

## 2. 测试范围与边界

### 2.1 本轮明确做了什么

- 阅读两端生产实现与协议文档，核对**代码与文档是否一致**：
  `Desktop/src/main/sync/{server,snapshot-importer,pairing-service,media-transfer,migrations}.ts`、
  `BrewPhase/Sync/{SyncManager,SyncSnapshotBuilder,SyncNetworkClient,SyncModels,SyncKeychain}.swift`、
  `Desktop/docs/SYNC_PROTOCOL.md`、`Desktop/docs/SYNC_METADATA_CONSISTENCY.md`。
- 新增**桌面侧**整链集成测试（真实 HTTP + 真实 SQLite 文件）。
- 新增**iOS 侧**跨语言指纹金标测试与快照构建测试。
- 新增**跨端**联调测试：真实 Swift 快照构建 → 真实 `SyncNetworkClient` → 真实
  Desktop HTTP → 真实 Desktop SQLite。
- 跑全量回归，确认新增测试未破坏既有基线。

### 2.2 本轮明确没有做（不冒充已验证）

| 项目 | 原因 |
| --- | --- |
| 真实 iPhone 设备 | 全程使用 iOS 模拟器（`C7C7F583-…`），未接物理设备 |
| 二维码扫描 / 相机链路 | 模拟器无相机；配对由夹具侧直接调用同一 `/api/pair` 完成，**二维码解析与 AVFoundation 未覆盖** |
| Keychain 凭据读写 | 未签名模拟器包缺 entitlement，`SecItemAdd` 返回 `errSecMissingEntitlement`；跨端用例把 token 直接注入客户端，等价于"已配对且凭据可读"之后的状态 |
| 真实断网 / 切网 / 弱网 | 未做物理层断网。幂等性用"重放同一批"验证，不等价于网络中断重试 |
| TLS | 协议明确列为下一跳，当前版本未实现 |
| Bonjour 发现 | 协议标注为后置增强项，未实现 |
| 清空（wipe）真实数据 | 按任务要求禁止对真实库执行；仅读代码与既有单测核对 |
| Desktop → iOS 回推 | 协议规定**永不回推**，不在测试范围 |

---

## 3. 测试方法与环境

### 3.1 环境

| 项 | 值 |
| --- | --- |
| macOS | 15.7.3 |
| Xcode | 26.3 (17C529) |
| Node | v22.22.2 |
| pnpm | 10.34.5 |
| Electron | 45.2.3 |
| 模拟器 | `C7C7F583-310C-43CE-B6ED-D4915F465154` |

### 3.2 隔离策略（不碰真实数据）

- 桌面侧所有测试使用 `mkdtemp()` 临时目录 + 独立 `brewphase.db`，`afterEach`
  整目录删除；`BREWPHASE_USER_DATA_DIR` 指向临时目录。
- 跨端夹具使用临时 SQLite 文件，端口优先 **47899**（避开 dev 默认 47821），
  仅监听 `127.0.0.1`。
- 跨端夹具凭据通过 `Documents/sync-harness.json` 投递；因
  `test-without-building` 每次重装 App 会更换数据容器 UUID，夹具每 200ms
  向所有模拟器容器广播一次，避免"上一次的容器还在、这一次读不到"。
- 全程未读取、未写入用户真实 `brewphase.db`。

### 3.3 新增测试文件

| 文件 | 作用 |
| --- | --- |
| `Desktop/tests/integration/sync-special.test.ts` | 桌面侧整链：全实体、幂等、修改、删除、冲突、媒体、撤销、边界 |
| `Desktop/tests/integration/support/sync-harness.ts` | 跨端夹具：起真实 Desktop 同步服务 + 真实配对 + 凭据广播 |
| `BrewPhaseTests/SyncSpecialTests.swift` | 跨语言指纹金标 + 快照构建器全实体覆盖 |
| `BrewPhaseTests/SyncCrossEndTests.swift` | 真实 Swift 客户端 → 真实 Desktop 服务联调 |

---

## 4. 执行结果

### 4.1 Desktop 全量

```
Test Files  37 passed (37)
     Tests  507 passed (507)
  Duration  83.95s
```

`vitest.config.ts` 的 `include` 为
`['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts']`，因此专项文件
`sync-special.test.ts`（19 条）**包含在 507 之内**，不是漏跑。

- `pnpm typecheck`：无输出、退出码 0（`tsconfig.node.json` + `tsconfig.web.json` 均通过）。
- `pnpm build`：主进程 / preload / renderer 三产物均构建成功。

### 4.2 桌面侧同步专项（19 条，全绿）

| # | 用例 | 结论 |
| --- | --- | --- |
| 1 | 全实体一次同步：10 类实体逐条 applied，字段与关联完整落库 | 通过（applied=11，baseline=11） |
| 2 | 同一批连续同步 3 次：仅首次 applied，之后全 skipped | 通过 |
| 3 | 修改同步：标题/备注/URL/数值被覆盖，再同步转 skipped 且不写 change_log | 通过 |
| 4 | URL 变更后旧链接派生元数据被清除，不挂到新 URL | 通过 |
| 5 | 删除后重复同步 3 次 + 桌面重启后再同步：不复活 | 通过（真实 close→reopen） |
| 6 | iOS 基线丢失后重推旧数据：按插入分支重新创建 | 通过（协议允许，见 §5.3） |
| 7 | 连续删除多条：同批 3 条全部生效 | 通过 |
| 8 | 删除豆子：冲煮/品鉴/提醒级联删除；记录删除带动节点 | 通过 |
| 9 | 删除记录后 iOS 仍推节点变更：failed + 基线残留 | 通过（**缺陷已钉住**，§5.2） |
| 10 | 冲突：桌面改过而 iOS 未改 → 保留桌面、落冲突；重复同步不产生第二条冲突 | 通过（冲突恒为 1 条） |
| 11 | 删除冲突：桌面改过而 iOS 要删 → 保留 + 落删除冲突 | 通过 |
| 12 | 修改后立即删除：走冲突分支，数据保留等裁决 | 通过（现状记录） |
| 13 | 部分失败：brew 引用不存在 bean → 该条 failed，其余照常 | 通过 |
| 14 | 并发两次 apply 同一批：合计只写一次 | 通过 |
| 15 | 媒体：分块上传后落盘，重复上传识别为 have | 通过 |
| 16 | 媒体：整文件哈希不符 → 拒绝落位，不留正式文件 | 通过（400） |
| 17 | 媒体：删除记录后文件仍留在磁盘 | 通过（**孤儿文件**，§5.4） |
| 18 | 撤销授权后 token 立即失效；重复撤销幂等 | 通过（401 / `already=true`） |
| 19 | 重复扫码配对：旧 token 仍有效，出现两条同名设备 | 通过（**越权残留**，§5.5） |

> 上表 19 行即 `it` 的准确数量（第 10 行把"落冲突"与"冲突去重"合并计为一条）。

### 4.3 iOS 侧测试

**`SyncSpecialTests`：11 / 11 通过**（`0 failures`，0.066s）

| 用例 | 验证点 |
| --- | --- |
| `testBeanFingerprintMatchesDesktopGolden` | 18 字段豆子（中文/null/布尔/毫秒/小数）逐字节对齐 TS 金标 |
| `testNumberFingerprintMatchesDesktopGolden` | `1 ≡ 1.0`、6 位截断、去尾零 |
| `testNullAndBooleanFingerprintMatchesDesktopGolden` | `nil → ~`、空串 ≠ null、`"~"` 不是 null 替身 |
| `testRecordTextFingerprintMatchesDesktopGolden` | 文本换行/引号原样入指纹，不转义 |
| `testLargeNumberFingerprintMatchesDesktopGolden` | epoch 毫秒与浮点不被科学计数法劫持 |
| `testCanvasNodeFingerprintMatchesDesktopGolden` | 节点坐标字段序与桌面一致 |
| `testNegativeZeroDiffersFromDesktop` | **已知差异**：Swift `-0.0 → "-0"`，TS `→ "0"`（§5.1） |
| `testSnapshotCoversEverySyncedEntityInDependencyOrder` | 10 类实体齐全且父先子后 |
| `testTagLinkIDIsDeterministicCompositeKey` | `recordId:tagId` 确定性复合键，两端同构 |
| `testEveryUpsertCarriesAWellFormedFingerprint` | 每条 upsert 指纹为 64 位十六进制 |
| `testMediaManifestReportsUnreadableReferences` | 读不到的媒体必须进 `errors`，不静默跳过 |

**`SyncCrossEndTests`：3 / 3 通过**（57.6s）

| 用例 | 覆盖 | 结果 |
| --- | --- | --- |
| `testFullLifecycleAgainstRealDesktop` | 连通性/协议版本 → 8 类实体首同步（applied=8）→ 重复同步 0 请求 → 服务端重放全 skipped → 修改 2 条 → 删除 → 删除后 2 轮 0 请求不复活 | 通过 |
| `testDeletionWithStaleBaselineBecomesConflict` | 故意不推进基线就删，注入过期指纹 → 必须进删除冲突，且不算 failed | 通过 |
| `testTinyNegativeCoordinateFingerprintDrift` | `positionX = -1e-7` 的真实节点，重放后是否被判假冲突 | 通过（**缺陷复现**，见下） |

负零用例的真实输出（非推断）：

```
[负零边界] replay conflicts=1 applied=0 skipped=4 drifted=["canvasNode"]
```

**夹具库最终落库状态**（真实 SQLite 文件查询）：

| 表 | 行数 |
| --- | --- |
| beans | 1 |
| brews | 1 |
| tastings | 1 |
| records | 2 |
| record_tags | 3 |
| record_tag_links | 1 |
| canvases | 2 |
| canvas_nodes | 1 |
| sync_baseline | 13 |
| sync_conflicts | 2 |

`sync_conflicts` 明细正好对应两个已定位边界：

| entity_type | remote_operation | 来源 |
| --- | --- | --- |
| `canvasNode` | `upsert` | 负零指纹漂移（§5.1，**非预期**） |
| `record` | `delete` | 过期基线删除保护（§4.3 第 2 条，**预期行为**） |

### 4.4 iOS 全量 XCTest

运行命令：

```
xcodebuild test-without-building -scheme BrewPhase \
  -destination 'platform=iOS Simulator,id=C7C7F583-310C-43CE-B6ED-D4915F465154' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO -derivedDataPath build/DerivedData
```

结果：**716 tests / 0 failures**（128.0s），末行 `** TEST EXECUTE SUCCEEDED **`。

包含：

- `SyncSpecialTests` 11 条（本轮新增）
- `SyncCrossEndTests` 3 条（本轮新增，跑时夹具在线）
- `SyncModelsTests` 8 条（既有指纹/配对链接单测，全部通过）
- 其余既有套件

基线对比：上一轮全量为 715 条，本轮 +1（跨端新增负零漂移用例），其余无回归。

### 4.5 Desktop E2E（参考，非同步专项）

```
40 passed / 7 skipped / 3 failed (2.4m)
```

3 条失败**全部与同步无关**，且均为本轮之前已存在的环境/时序问题：

| 失败用例 | 实际错因 | 是否同步回归 |
| --- | --- | --- |
| `chrome-companion.e2e.spec.ts:102` 设置页安装 Native Host | `outcome.status.extensionDir` 为 `null`，`toContain('ChromeExtension')` 失败（e2e 环境下扩展目录未解析） | 否 |
| `data-location.e2e.spec.ts:47` 更改数据位置 | 确认迁移后未出现 `已迁移，正在重启 BrewPhase…`（`restarting` 状态/重启时序，文案本身存在于 `zh-CN/settings.ts`） | 否 |
| `data-location.e2e.spec.ts:96` 恢复默认位置 | 同上 | 否 |

同步链路本身没有 Playwright 用例（它是 HTTP + SQLite 层），因此 E2E 的红/绿
不构成同步结论；同步结论只取 §4.1–§4.3。

---

## 5. 发现的问题

### 5.1 【P2，必修】跨语言负零归一不一致 → 实体永久假冲突

**现象**

同一行数据，两端算出的指纹不同，桌面端因此每次都判成"iOS 改了、桌面也改了"，
落一条冲突并**永久保留**。

**根因**

`SyncFingerprint.number`（Swift）对负数用 `String(format: "%.6f", value)`
再截尾零：`-0.0000001 → "-0.000000" → "-0"`；
桌面端 `canonNumber` 走 `String(Number(value.toFixed(6)))`：`-1e-7 → "0"`。

**真实链路证据**

iOS 建 `CanvasNode(positionX = -0.0000001)` → 首次同步 applied=5（tag/record/
tagLink/canvas/node）→ 强制重放同一批：

```
replay applied=0 skipped=4 conflicts=1 drifted=["canvasNode"]
```

即 4 条正常 skipped，唯独该节点被判冲突；夹具库 `sync_conflicts` 里留下
`canvasNode / upsert` 一行。

**影响**

- 不会丢数据（冲突保护生效），但该实体**永远无法收敛**：每轮同步都新增/复用
  同一条冲突，用户在设置页会看到一条怎么裁都消不掉的冲突。
- "接受手机版本"也救不回来：桌面端把 `-1e-7` 存进列后，本地指纹仍是 `"0"`，
  与 iOS 的 `"-0"` 依旧不等。
- 触发面窄（仅当数值落在 `(-5e-7, 0)`），但画布世界坐标经缩放/平移完全可能
  产生这种极小负数，且**没有任何日志会提示这是归一问题**。

**建议修复（本轮未改）**

在 Swift 侧 `SyncFingerprint.number` 归一后把 `"-0"` 折成 `"0"`（对
`abs(value) < 5e-7` 统一输出 `"0"`），并补一条与 TS 同输入的金标；或在 TS 侧
保留 `-0` 以镜像 Swift——**两者只能选一个方向，且必须同步改测试**。

**回归守护**

`SyncSpecialTests.testNegativeZeroDiffersFromDesktop`（Swift 侧现状）+
`SyncCrossEndTests.testTinyNegativeCoordinateFingerprintDrift`（真实链路现状）。

---

### 5.2 【P2，必修】记录级联删除不清 `canvasNode` 基线 → 每轮固定一条 failed

**现象**

iOS 删除 Record 后，桌面端 `canvas_nodes` 因 `ON DELETE CASCADE` 一并被删，
但 `sync_baseline` 里该节点的指纹**没有被清**。iOS 侧节点对象仍在（只持有
`recordID`，不是 SwiftData 级联关系），一旦拖动就会以新指纹 upsert 上来。

**真实结果**

```
[sync] failed canvasNode 99999999-…: FOREIGN KEY constraint failed
apply 1 failed
```

断言确认：`appliedCount = 0`、`conflictCount = 0`、`failedItems.length = 1`、
`canvas_nodes` 行数 = 0（没有复活、没有孤儿行）、
`sync_baseline` 中 `canvasNode` 仍为 **1** 行。

**影响**

- 不是数据损坏，是**永久噪音 + 无效重试**：该节点每轮同步都会失败一次，
  iOS 侧因 failed 不推进基线，于是无限重试。
- 用户看到"同步有 1 条失败"却无从处理；也没有 UI 能清掉这条残留基线。
- 根因是级联删除走 SQLite 外键，**没经过 `applyDeletion`**，所以基线清理逻辑
  被绕过。

**建议修复（本轮未改）**

删除 Record 前先按 `record_id` 查出其 `canvasNode` id，走正常删除路径清基线；
或在级联后补一次"孤儿基线清理"（`sync_baseline` 中该实体在本地已不存在且
来自本次级联）。

**回归守护**

`sync-special.test.ts` → `删除记录后 iOS 仍推节点变更：核对失败条目与落库状态`。

---

### 5.3 【P3，需产品确认】iOS 基线丢失后重推旧数据会"复活"已删记录

`删除后不复活` 只在**基线仍在**时成立。若 iOS 重装/换机导致基线清空，重推
旧记录会走"行不存在 → 插入"分支，桌面端已删除的记录**重新出现**。

- 用例：`iOS 侧基线丢失后重推旧数据：桌面端按冲突保留，不会静默覆盖也已删除的数据`
- 现状：`appliedCount = 1`，记录重新出现。
- 这是协议既定行为（无 tombstone 就无法区分"新增"与"复活"），不算 bug，
  但**用户会认为删除失败**。建议：后续引入 tombstone（协议已为
  `originDeviceId/revision/tombstone` 预留字段），或在 UI 上明示。

### 5.4 【P3】单条删除记录不清理媒体文件 → 孤儿文件累积

`wipe` 会删媒体，但单条记录的 `applyDeletion` 只删数据库行：

- 用例：`媒体：删除记录后媒体文件仍留在磁盘（孤儿文件，现状记录）`
- 现状：记录行已删，`mediaDir()` 里文件仍在。
- 影响：长期使用后磁盘只增不减；视频文件尤其明显。
- 建议：删除记录时按 `mediaPath/previewPath` 引用计数清理，或提供"清理未引用媒体"。

### 5.5 【P3】重复扫码配对不撤销旧 token → 两条同名设备、两个有效 token

`PairingService.exchange()` 只签发新 token，不撤销同名设备的旧 token；撤销只
发生在显式 `POST /api/unpair`。

- 用例：`重复扫码配对：旧 token 仍然有效，设备表出现两条同名记录`
- 现状：`devices` 两行同名、`revoked_at` 均为 null、旧 token 仍可 `apply`（200）。
- 正常流程会先解除配对，因此这是"绕过 unpair 重扫"时的表现。
- 影响：设备列表越积越多；丢失的旧设备凭据仍然有效（安全面）。
- 建议：同 `deviceName` 重新配对时自动撤销旧 token，或在 UI 上强制先解绑。

### 5.6 【P3，行为记录】"改完立刻删"会进删除冲突而非直接删除

iOS 改了内容但基线仍是旧指纹，紧接着删除时带的是旧基线指纹；桌面端本地指纹
已变 → 按协议判删除冲突，数据保留等裁决。

- 用例：`修改后立即删除（同一轮 iOS 先改再删）：以删除为准，不复活`
- 现状：`conflictCount = 1`，标题保持"改过又被删"。
- 这是**非破坏性设计的正确表现**（宁可留数据也不误删），但用户预期是"我删了
  就该没"。建议在冲突 UI 上把这类文案写清楚。

---

## 6. 协议一致性核对

| 文档声明 | 代码/测试实际 | 结论 |
| --- | --- | --- |
| 单向 iOS → Desktop，Desktop 永不回推 | 无 Desktop → iOS 请求路径 | 一致 |
| `protocolVersion = 1` | iOS `SyncManager.protocolVersion = 1`，`/api/status` 校验 | 一致 |
| 端口首选 47821，被占回落 | 产品默认 47821；夹具显式指定 47899 时实测 `HARNESS_READY {"port":47899,…}`，符合预期 | 一致 |
| 写入需 Bearer + timestamp + nonce + HMAC | 专项用例按同算法签名，非法/撤销后 401 | 一致 |
| 四态合并（不存在/相同/基线==本地/基线==来端） | 19 条用例逐态验证 | 一致 |
| 删除必须带 `expectedFingerprint`，不符进删除冲突 | 桌面 + 跨端双向验证 | 一致 |
| 冲突按"实体+远端指纹+操作"去重 | 重复同步冲突数恒为 1 | 一致 |
| 引用缺失进 `failedItems`，不拖垮整批 | brew 指向不存在 bean：2 applied + 1 failed | 一致 |
| `recordTagLink` 用 `recordId:tagId` 复合键 | Swift 与 TS 双侧断言 | 一致 |
| Media：256KB 分块 + 整文件 SHA-256 + 原子落位 | 落盘/拒绝/幂等三态验证 | 一致 |
| `canvasNote/canvasStroke` 入站拒绝 | 代码路径核对（`applyBatch` 收口） | 一致 |
| wipe 需要 `{"confirm":"DELETE_SYNCED_CONTENT"}` | 既有单测覆盖，本轮未执行真实 wipe | 未实测 |

---

## 7. 复现方式

### 7.1 桌面侧

```bash
cd Desktop
pnpm typecheck
pnpm test                                   # 全量 507
npx vitest run tests/integration/sync-special.test.ts   # 专项 19
```

### 7.2 iOS 侧（纯内存，无需夹具）

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild build-for-testing -scheme BrewPhase \
  -destination 'platform=iOS Simulator,id=C7C7F583-310C-43CE-B6ED-D4915F465154' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO -derivedDataPath build/DerivedData

xcodebuild test-without-building -scheme BrewPhase \
  -destination 'platform=iOS Simulator,id=C7C7F583-310C-43CE-B6ED-D4915F465154' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO -derivedDataPath build/DerivedData \
  -only-testing:BrewPhaseTests/SyncSpecialTests
```

### 7.3 跨端联调（真实 HTTP + 真实 SQLite）

```bash
# 终端 A：起真实桌面同步服务（临时库、端口 47899）
cd Desktop
npx tsx tests/integration/support/sync-harness.ts /tmp/bp-harness-out.json 47899

# 终端 B：跑跨端用例（夹具会把凭据广播到模拟器容器 Documents）
xcodebuild test-without-building -scheme BrewPhase \
  -destination 'platform=iOS Simulator,id=C7C7F583-310C-43CE-B6ED-D4915F465154' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO -derivedDataPath build/DerivedData \
  -only-testing:BrewPhaseTests/SyncCrossEndTests
```

> 关键前提：`test-without-building` **每次都会重装 App**，数据容器 UUID 随之
> 变化。若不用持续广播，测试会读到上一次的容器（凭据不存在）而 `XCTSkip`。
> 另外跑完后要停掉夹具（`pkill -f sync-harness.ts`），否则模拟器里会留下指向
> 已死端口的 `sync-harness.json`，下次跨端用例会连不上而不是跳过。

---

## 8. 建议的修复优先级

| 优先级 | 问题 | 理由 |
| --- | --- | --- |
| 1 | 负零指纹漂移（§5.1） | 永久假冲突且无法通过裁决消除；修复面很小（一个函数 + 金标） |
| 2 | 级联删除不清基线（§5.2） | 每轮固定失败，用户可见且无法自愈 |
| 3 | 重复配对不撤销旧 token（§5.5） | 安全面：失效设备仍持有效凭据 |
| 4 | 单条删除留孤儿媒体（§5.4） | 磁盘只增不减 |
| 5 | 基线丢失后复活（§5.3） | 需要 tombstone 或 UI 说明，属产品决策 |
| 6 | "改完立刻删"进冲突（§5.6） | 设计正确，补文案即可 |

---

## 附录 A：本轮新增/改动的测试资产

| 路径 | 说明 |
| --- | --- |
| `Desktop/tests/integration/sync-special.test.ts` | 新增，19 条 |
| `Desktop/tests/integration/support/sync-harness.ts` | 新增，跨端夹具 |
| `BrewPhaseTests/SyncSpecialTests.swift` | 新增，11 条 |
| `BrewPhaseTests/SyncCrossEndTests.swift` | 新增，3 条（本轮修正一处断言：该用例只 seed 5 条实体，`first.applied` 应为 5 而非 8） |

**生产代码改动：无。**

## 附录 B：本轮验证中修正的测试自身问题

| 问题 | 处理 |
| --- | --- |
| `testTinyNegativeCoordinateFingerprintDrift` 断言 `first.applied == 8` | 该用例只 seed tag/record/tagLink/canvas/node 共 5 条，断言已改为 5。原断言是从全实体用例复制而来，属夹具计数错误，非产品缺陷 |
| 跨端用例重跑撞 `UNIQUE constraint failed: record_tags.name` | 标签名加 UUID 后缀，保证多轮复用同一夹具库时唯一 |
| 跨端初版手搓 deletes 拿到过期指纹，被正确判成删除冲突 | 改为逐行复刻 `SyncManager` 的基线推进，夹具不再制造假冲突 |
