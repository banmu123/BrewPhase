# R5-R3.4 · 真实设备首次配对闭环

> **本文档已扩展到 R5-R3.4.2。**
> 第一～七节是 **R5-R3.4 首轮**（基线 `5ca325c`）的原始记录，保留不改；
> 第八节起是 R5-R3.4.1 与 R5-R3.4.2 的审查发现、修复与**最新**实测数字。
> 本文档只覆盖设备配对生命周期，不含 MCP OAuth / 工具层。

基线：`5ca325c6c8a8c7788b3515ccf55c58b9fd01b6bd`（`feature/remote-mcp`，第一～七节）
后续：R5-R3.4.1 → `9fc485e01e0e1d9f006107ca2a74173a82df0846`；R5-R3.4.2 见第十四节
阶段：只做设备首次配对的注册 → 确认 → 领取 → 连线闭环，不重做 MCP OAuth / 工具层。

## 一、结论

| 项目 | 结果 |
|---|---|
| 确认能力（`DeviceRegistrar.confirm`） | 已接入 `POST /mcp-devices/:id/confirm` |
| 撤销能力（`DeviceRegistrar.revoke`） | 已接入 `DELETE /mcp-devices/:id` |
| Desktop 状态机 | 注册后停在 pending，**不再自动确认**；确认成功才领凭据 |
| Renderer | 真实配对面板（设备、平台、账号、确认码、有效期、两个动作） |
| Mock 文案 | 已删除（zh-CN / en-US 同步） |
| Desktop 门禁 | typecheck ✓ / 1306 测试 ✓ / build ✓ |
| Cloud 门禁 | typecheck ✓ / lint ✓ / 1703 测试 ✓ / build ✓ |
| 现有设备与 Grant | 未改动（`77f9f052` 全程在线，回归后仍 `online`） |

## 二、改动文件

**主进程**

| 文件 | 改动 |
|---|---|
| `src/main/remote/registration.ts` | 新增 `confirm()` / `revoke()`；`callWithBearer` 支持 `DELETE`；错误按状态码归一，错误对象不含确认码或响应体 |
| `src/main/remote/remote-service.ts` | `pendingRegistration` 增加展示字段；新增 `confirmRegistration()` / `cancelRegistrationNow()`；`publish()` 返回快照 |
| `src/main/remote/link-state.ts` | `buildStatus` 接受并可输出 `pendingRegistration` |
| `src/main/index.ts` | 注入 `currentUserLabel`（仅用于显示，不参与身份判定） |
| `src/main/ipc/register.ts` | 注册两条新通道 |

**契约与 IPC**

| 文件 | 改动 |
|---|---|
| `src/shared/contracts/remote.ts` | `remotePendingRegistrationSchema`、`REMOTE_CONFIRM_FAILURES`、confirm 请求/响应 schema、`RemoteConfirmResult` / `RemoteCancelResult`；`RemoteStatus.pendingRegistration`；`REMOTE_CHANNELS` 两条新键 |
| `src/shared/contracts/index.ts` | `RendererApi.remote.confirmRegistration / cancelRegistration`；`register` 返回完整 ticket |
| `src/shared/contracts/validation/ipc.ts` | 两条通道常量 + `z.void()` 入参（Renderer 不能传码或 deviceId） |
| `src/preload/index.ts` | 暴露两个方法 |

**Renderer**

| 文件 | 改动 |
|---|---|
| `features/settings/RemoteAccessPanel.tsx` | 真实待确认卡片 + 确认/取消动作 + 失败分类提示；删除本地 `pendingDevice` 状态 |
| `i18n/messages/{zh-CN,en-US}/settings.ts` | 新增配对文案 17 项；删除 `pendingMockNote` |

**测试**

| 文件 | 改动 |
|---|---|
| `tests/integration/remote-confirm.test.ts`（新） | 10 条：pending 不落盘、确认后领取落盘、只领一次、开关关闭不建连、配对后 WSS 握手、错码保留现场、账户切换不落盘、过期、取消撤销、云端不可达 |
| `tests/unit/remote-confirm-registration.test.ts`（新） | 18 条：confirm 的 200/400/401/403/404/409/410/429/非 JSON/网络、revoke 的 200/404/401/500/网络、请求形态与不泄漏 |
| `tests/helpers/mock-gateway.ts` | 支持 `DELETE /mcp-devices/:id` |
| `remote-registration` / `remote-user-gate` / `remote-rotation` | 更新白名单断言与 registrar 桩 |

**仓库卫生**

- `.gitignore` 增加 `/.workbuddy/memory/`；
- `git rm -r --cached .workbuddy/memory`（31 个文件取消跟踪，**本地文件全部保留**，未重写历史）。

## 三、API / IPC 变化

| 名称 | 方向 | 说明 |
|---|---|---|
| `POST /mcp-devices/:id/confirm` | Desktop → Cloud | 已有端点，本次接入。Body `{confirm_code}`，200 幂等，400/404/409/410/429 分别映射 |
| `DELETE /mcp-devices/:id` | Desktop → Cloud | 已有端点，本次用于「取消配对」；404 视为成功 |
| `remote:confirm-registration` | Renderer → Main | 无入参；返回 `{ok, reason, status}` |
| `remote:cancel-registration` | Renderer → Main | 无入参；返回 `{revoked, status}` |
| `remote:register` | Renderer → Main | 返回值扩展为 `{deviceId, deviceName, platform, confirmCode, expiresAt, accountLabel}` |
| `RemoteStatus.pendingRegistration` | Main → Renderer | `null` 或待确认展示信息（**不含** claim_secret / 私钥 / device_token） |

## 四、状态流转

```
配对新设备
  └─ POST /mcp-devices/register
       → status = pending, confirm_code 落库（hash）
       → 主进程内存持 claim_secret + 新私钥
       → Renderer 看到 pendingRegistration（码 / 设备 / 平台 / 账号 / 有效期）
       → 轮询 /credentials 拿 202（保持 pending，不落盘）

用户点「确认信任这台设备」
  └─ POST /mcp-devices/:id/confirm {confirm_code}
       ├─ 200 → 立刻 POST /credentials → device_token
       │        → safeStorage 加密落盘（device.json）
       │        → pendingRegistration = null，deviceId/boundUserId 就绪
       └─ 400/410/404/409 → 分类提示；除终态外保留现场可重试

用户点「取消本次配对」
  └─ 本地清理（停轮询、抹 claim_secret、清 pending）
       └─ DELETE /mcp-devices/:id
            ├─ 200/404 → revoked=true
            └─ 其它 → revoked=false（设备会自然过期，界面如实说明）

用户打开「允许远程访问」（与配对是两个独立动作）
  └─ identityGate: deviceId + deviceToken + privateKey + boundUserId + origin 全部匹配
       → WSS hello → hello_ok → online
```

## 五、测试结果（R5-R3.4 首轮）

> **数字已过期**，仅作历史记录。最新结果见[第十四节](#十四测试结果最新)。

| 套件 | 结果 |
|---|---|
| Desktop 全量 | **92 文件 / 1306 条通过**（新增 28 条） |
| Cloud 全量 | **82 文件 / 1703 条通过** |
| Desktop `typecheck` | 通过（`tsconfig.node.json` + `tsconfig.web.json`） |
| Desktop `build` | 通过 |
| Cloud `typecheck` / `lint` / `build` | 通过 |

说明：Desktop 仓库**没有 ESLint 配置**（无 `eslint.config.*`、无 `lint` script），任务书中的 lint 一项以 typecheck 覆盖；Cloud 的 `pnpm lint` 正常运行。

## 六、独立设备验收

**测试层（已完成，无 SQL 介入）**

`tests/integration/remote-confirm.test.ts` 用真实 HTTP 客户端 + 真实 `DeviceStore`（临时目录）+ 真实状态机跑完整闭环，其中：

- `注册后是 pending`：确认码可见、`device.json` 不存在、云端设备仍 `pending`；
- `确认成功后立刻领取并落盘`：`device.json` 出现，`pendingRegistration` 清空；
- `配对完成后用户打开开关 → 用刚拿到的凭据完成 WSS 握手`：`gateway.connections === 1` 且 `helloVerified === true`（用的是注册时那对密钥）。

**真实 GUI（未执行，原因）**

桌面端只有一份 `device.json`，在真实界面上再走一次「配对新设备」会覆盖现有在线设备 `77f9f052` 的凭据，等于删除/暂停一台正在服务的设备——与任务书 §8 的硬约束冲突。因此本阶段选择不在真实 GUI 上重复配对，改为上面那组等价集成测试。若需要真机验证，建议单独提供第二份 `userData` 目录后另开一次验收。

**现有能力未受影响**

重启桌面端加载新代码后实测：

| 调用 | 结果 |
|---|---|
| `tools/list` | 8 个工具 |
| `tools/call search_records` | `isError: false`，返回 1 条 |
| `tools/call list_canvases` | `isError: false`，返回 2 个画布 |
| 设备 `77f9f052` | `last_seen_at` 持续刷新，状态 `active` |

## 七、遗留问题（R5-R3.4 首轮）

> 第 1～6 条是首轮记录；本阶段新增的风险与未验证项见[第十五节](#十五仍然存在的风险与未验证项)。

1. **确认码的消费入口只有 Desktop 一处**。Cloud 端 `POST /mcp-devices/:id/confirm` 仍然没有网页/移动端界面；本次把 Desktop 做成入口，闭环成立，但「在手机上确认桌面设备」这种形态还没有。
2. **pending 过期不会主动推状态**。到点后要么用户点一次确认（得到 `expired`），要么等下一次广播；没有定时器在过期瞬间刷新界面。
3. **`confirm_attempts` 触顶后云端直接置 `revoked`**，Desktop 仍显示 pending 直到再次确认（届时返回 `device_state`）。这是可接受的，但提示语偏向「已被撤销」而不是「码错了太多次」。
4. **真实 GUI 二次配对未验收**（见第六节原因）。
5. **生产环境未部署**（任务书 §11 明确禁止）。
6. GitHub OAuth client secret 曾在对话中明文出现，轮换作为独立运维事项，不在本次代码改动范围内。

---

# 第二部分 · R5-R3.4.1 / R5-R3.4.2

## 八、R5-R3.4.1 审查发现的问题

独立审查在**配对完成判定**与**并发领取**上发现两处硬伤：

| # | 问题 | 根因 | 后果 |
|---|---|---|---|
| 1 | **确认成功被当成配对完成** | `confirmRegistration()` 在 `await claimOnce()` 之后无条件返回 `{ok:true}`，而 `claimOnce(): Promise<void>` 在 202 / 网络异常 / 409 / safeStorage 失败 / 换账户 / 被取消时**静默 return** | 界面显示「配对完成」，本地却没有可用凭据 |
| 2 | **轮询与手动确认并发领取** | 两条路径各自调 `claimOnce()`，无单飞；Cloud 的 `token_issued_at IS NULL` 原子守卫只让一个成功，另一个拿 409 → 409 路径去撤销、成功路径因 pending 已清而丢弃结果 | Cloud 上设备已激活，Desktop 却没有凭据 |

R5-R3.4.1 的修复（commit `9fc485e`）：

- `claimOnce` → `runClaim`，返回具名 `ClaimOutcome`（`claimed | pending | retryable_failure | terminal_failure | save_failed | superseded`）；
- `claimFlight` 单飞，轮询与手动确认共享；`confirmFlight` 让两次并发 confirm 复用同一结果；
- `ok: true` 的唯一条件是 `device_token` 已写进 safeStorage；
- 一次性 claim 失败**不重试**，改为撤销 + 清本地临时凭据；
- `RemoteStatus.pairingPhase` 驱动按钮文案；`REMOTE_CONFIRM_FAILURES` 增 6 项；
- `register()` 增加「有 pending / 已有 deviceId 就拒绝」两道守卫；
- 落盘之后补做账户复核，取消/顶替时用 `store.forget()`（代际 +1）撤掉已写入的凭据。

## 九、R5-R3.4.2 修复

### 9.1 任务 A：`register()` 缺主进程单飞

旧实现的两道守卫都在**同步段**，而 Cloud 请求在 `await` 之后：

```
调用①  检查 pending/deviceId 通过 ──► await registrar.register() ─┐
调用②  检查 pending/deviceId 通过 ──► await registrar.register() ─┤► Cloud 建了两台
                                                                  └► 后到的响应覆盖 pendingRegistration
```

修复（`remote-service.ts`）：

- 新增 `registerFlight`，**并发的第二次调用复用同一个操作**（只打一次 Cloud，两次拿到同一张 ticket）；
- 新增 `runRegister(userId)` 作为单飞体，**发请求前后各复核一次**：
  - 发请求前：`shuttingDown` / `pendingRegistration` / `deviceId` / `currentUserId()`；
  - 拍 `pairingEpoch` 快照 → `await reg.register()` → 复核 **代际、shutdown、pending、deviceId、账户**；
- 迟到的响应**不建立 pending**，改为按**发起时的用户身份**撤销 Cloud 设备后抛错；
- 错误文案区分三种结局（`...the cloud device was revoked` / `...could not be revoked` / `...the account changed ... remove ... manually`），清理失败同时写 `link.lastError`。

### 9.2 任务 B：统一取消与清理

新增 `pairingEpoch`（配对异步操作代际）与两个协调函数：

| 函数 | 职责 |
|---|---|
| `cancelRegistration(reason)` | **唯一**的失效入口：`pairingEpoch += 1` + 清 pending + 停轮询 + 抹 `claim_secret` + phase 归零 |
| `drainPairingFlights()` | 只等待：等 `registerFlight` 与 `claimFlight` 落定 |
| `invalidateAndDrainPairing(reason)` | 先失效、再等待（顺序不可调换） |

**代际必须在 `if (!pending) return` 之前 +1**：`register()` 的 HTTP 往返期间还没有 pending，那时「没有进行中的配对」恰恰意味着「这次迟到的响应必须作废」。

五个入口的接入方式：

| 方法 | 接入 | 理由 |
|---|---|---|
| `stop()` | `await invalidateAndDrainPairing('shutdown')` | 退出前必须收敛；`before-quit` 有 3s 总超时兜底 |
| `disable()` | 同步 `cancelRegistration('disabled')` → 断连 → `await drainPairingFlights()` | 立刻关 socket，但不能在返回时磁盘还在写凭据 |
| `forget()` | 同步失效 → 断连 → **`await drainPairingFlights()` → 再 `store.forget()`** | 顺序反了会让在途 save 拿到 stale-generation 而看不见它要撤的东西 |
| `prepareForSignOut()` | 同步失效 → **`await drainPairingFlights()`** → 断连 | **必须在账户凭据被清掉之前等完**，否则撤销拿不到 Bearer |
| `cancelRegistrationNow()` | `await invalidateAndDrainPairing(...)` → 用 `pending.userId` 撤销 | 取消必须等清理做完再报结果 |

### 9.3 `convergeCancelledClaim`：迟到的 claim 结果不再被丢弃

`claim()` 发出后用户可能立刻 `forget()` / `disable()` / `sign out()`，此时 `pendingRegistration` 已是 null。旧代码直接 `return superseded`，**把 Cloud 的应答扔了**：

| Cloud 的应答 | 扔掉的后果 |
|---|---|
| 未签发（202 / 网络 / 403 / 404 / 410） | 没有孤儿，扔掉**是对的** |
| **已签发（200）** | 设备已是 `active`、Token 却没人持有 → 永久孤儿 |
| 409 `credentials_already_issued` | 同上（Token 被别的请求拿走） |

现在：**先删本地（如已落盘）→ 再按发起时的身份撤销 → 撤不掉就 `noteCleanupPending()` 留痕**。
落盘之后才被取消的路径（`runClaim` 的 `replaced || accountChanged` 分支）同样补上了撤销。

### 9.4 身份铁律：`revokeDevice({ deviceId, userId })`

`registrar.revoke` 走用户 Bearer，而 Bearer 来自**当前**登录者。`revoke()` 把 404 当成功（身份正确时的幂等语义），于是**跨账户撤销会谎报「已撤销」**。

`revokeDevice` 先比对 `currentUserId() === userId`：

- 不一致 → **不发请求**、返回 `false`，由调用方如实报 `revoked: false` 或写 `cleanup pending`；
- `cancelRegistrationNow` / `convergeCancelledClaim` / `runRegister` 的迟到收尾 / claim 失败路径，**全部改走这一个入口**。

## 十、Cloud pending / active 孤儿设备处理原则

| 时机 | Cloud 状态 | 本地动作 | 是否撤销 |
|---|---|---|---|
| 注册响应迟到（forget / stop / sign out / 换账户） | `pending` | 不建立 pending | 身份未变 → 撤；已变 → 不撤，留痕 |
| claim 未签发就被作废 | `pending` | 无 | 不需要 |
| **claim 已签发、本地未落盘就被作废** | `active` + `tokenIssued` | 无（save 之前） | **必须撤** |
| **claim 已落盘、随后被取消/顶替/换账户** | `active` + `tokenIssued` | `store.forget()`（代际 +1 删文件） | **必须撤** |
| safeStorage 写不进去 | `active` + `tokenIssued` | 无 | **必须撤** |
| 撤销失败（网络 / 身份已失效） | 仍是 `active` | 无 | **不谎报**：`revoked: false` 或 `lastError = "device cleanup pending: …; remove it from the cloud device list"` |
| 正式配对设备的 `forget()` | `active` | 删 `device.json` | **不撤**（首轮既有语义，本阶段未改，见第十五节） |

**为什么正式配对的 `forget()` 不撤销**：它是「这台电脑不再持有凭据」，不是「这台设备不存在了」；改成撤销会让「临时解绑再登录」变成必须重新配对，属于行为变更，需单独评估后另开阶段。

## 十一、账户切换与 shutdown 的处理

| 场景 | 判据 | 动作 |
|---|---|---|
| register 在途 + 换账户 | `currentUserId() !== userId` | 不撤销（不跨账户）、不建 pending、抛 `…the account changed…`、`lastError` 指向手动清理 |
| claim 在途 + 换账户/登出 | 同上 | 不写盘、不撤销、`cleanup pending` 留痕 |
| save 在途 + 换账户 | `store.save` 后再复核一次身份 | 本地已写的凭据删掉 + 不撤销（身份已变） |
| 任意在途 + `stop()` | `shuttingDown` + 代际 | 迟到响应作废；身份仍有效则撤销 |
| 任意在途 + `prepareForSignOut()` | 代际 | **在 `accessToken()` 失效之前**等完收敛 |
| 账户已切换后的状态展示 | `reconcile()` → `enterBlocked()` | 保留 `deviceId` 但 `boundUserId` 仍是**旧账户** + `needsReauth` + `blockedReason`，绝不显示成「当前用户已配对」 |

## 十二、注册单飞机制（一图流）

```
register()                          ← 同步守卫：pending / deviceId / 登录态 / shuttingDown
  ├─ registerFlight 已存在 ──────────► 复用（同一张 ticket，Cloud 只被请求一次）
  └─ runRegister(userId)
       ├─ recheck() ── await claimFlight ── recheck()
       ├─ epoch = pairingEpoch            ← 快照必须在发请求这一刻拍
       ├─ await reg.register()
       ├─ 复核：shuttingDown | epoch 变了 | pending 非空 | deviceId 非空 | 账户变了
       │     └─ 撤销（仅身份未变时）→ 抛错，绝不建立 pending
       └─ 建 pending → phase=awaiting_confirm → publish → scheduleClaimPoll
```

## 十三、取消与清理的统一生命周期

```
任意取消入口
  ① cancelRegistration(reason)      ← 同步：pairingEpoch+1、清 pending、停轮询、抹 claim_secret、phase=idle
  ② drainPairingFlights()           ← await registerFlight + claimFlight
        ├─ 迟到的 register → 复核失败 → 撤销（或留痕）→ 抛错
        ├─ 迟到的 claim（未签发）→ superseded
        ├─ 迟到的 claim（已签发）→ 删本地 → 撤销 → superseded
        └─ save 中途被取消       → store.forget()（代际+1）→ 撤销 → superseded
  ③ 调用方自己的清理                ← store.forget() / 断连 / 上报
```

**顺序不可调换**：先等再失效会开出一个窗口，让在途 claim 先跑完成功分支把凭据落盘，然后才被判定作废。

## 十四、测试结果（最新）

本阶段（R5-R3.4.2）**实际执行**：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（`tsconfig.node.json` + `tsconfig.web.json`） | **通过（exit 0）** |
| `pnpm test`（含 `mcp:build`） | **95 文件 / 1361 条通过**（较上一阶段 94/1345 **新增 16 条**） |
| `pnpm build`（`electron-vite build`） | **通过（exit 0）** |
| `pnpm e2e`（全量 Playwright） | 第 1 次：**81 通过 / 2 失败 / 14 跳过**；第 2 次：**82 通过 / 1 失败 / 14 跳过** |
| `cloud/pnpm test`（协议未受影响） | **82 文件 / 1703 条通过** |

新增测试文件 `tests/integration/remote-pairing-lifecycle.test.ts`（**16 条**），逐条对应任务书 §四 的 12 个时序 + 4 条状态/安全边界：

| # | 用例 | 关键断言 |
|---|---|---|
| 1 | 两个 register 同时调用 | `registerCalls === 1`、两次拿到同一张 ticket、Cloud 只 1 台 |
| 2 | register 期间 forget | 不恢复 pending、Cloud 设备 `revoked`、`revokeOwners === ['user-a']` |
| 3 | register 期间 sign out | 不留旧账户设备、撤销用发起时身份 |
| 4 | register 期间换账户 | **`revokeCalls === 0`**（不跨账户）、`boundUserId` 为 null、`cleanup pending` 留痕 |
| 5 | register 期间 stop | 迟到响应作废、之后 `register()` 拒绝 |
| 6 | claim 期间 disable | 无 `device.json`、Cloud `revoked` |
| 7 | claim 期间 forget | **`tokenIssued` 为 true 且设备 `revoked`**（不留 active 孤儿） |
| 8 | claim 期间 sign out | 不写盘、**`revokeCalls === 0`**、孤儿被点名 |
| 9 | safeStorage 保存期间取消 | 磁盘无残留、代际 > 0、撤销身份与目标始终一致 |
| 10 | 连续两次 cancel | **`revokeCalls === 1`**、代际仍为 0（不重复清理） |
| 11 | 旧清理期间新注册 | 新 pending 存活、旧设备 `revoked`、新设备仍 `pending` |
| 12 | 正式配对设备不被误删 | cancel/disable/stop 后 `device.json` 与代际不变、`revokeCalls === 0`、`register()` 拒绝 |
| D1 | 账户变化后的状态 | `boundUserId` 仍是旧账户 + `needsReauth` + `blockedReason` |
| D2 | 取消中 vs 取消完成 | 完成前**不 publish**，完成后才广播 |
| D3 | revoke 失败 | `revoked === false` + `cleanup pending`（不谎报成功） |
| D4 | 日志无凭据 | 确认码 / `claim_secret` / `bp_dev_` / `device_token` / 私钥全部 0 命中 |

**时序控制方式**：全部使用 `Deferred` + Promise gate + 请求入口信号（`signals.registerStarted` 等），**不使用 `setTimeout` 猜竞态**。
**未处理 rejection**：每个 `afterEach` 收集 `unhandledRejection` 并断言为空。

**变异验证**（证明测试不是「写完就绿」）：

| 临时变异 | 结果 |
|---|---|
| 删掉 `if (registerFlight) return registerFlight` | 用例 1 **失败** ✓ |
| 把 `convergeCancelledClaim(...)` 换回 `return {state:'superseded'}` | 用例 7 **失败**（`expected 'active' to be 'revoked'`）✓ |

**E2E 失败的归因**（两次全量 + 基线对照，均已实测）：

| 用例 | 归因 | 证据 |
|---|---|---|
| `card-workspace.e2e.spec.ts:170` | **基线既有**，与本阶段无关 | `git stash` 到 `9fc485e` 后重建重跑，**同样失败** |
| `roundtable-workspace.e2e.spec.ts:289` | **时序抖动** | 同一份构建连跑 3 次：1 败 2 过；第 2 次全量运行已自行通过 |
| 14 条 skipped | 环境相关（Windows 专属 / 视觉截图 / 需要 AI 凭据），**非本轮引入** | 两轮全量一致 |

> **没有伪报「E2E 全绿」**：`pnpm e2e` 的 exit code 为 1，原因如上。

## 十五、仍然存在的风险与未验证项

1. **`card-workspace.e2e.spec.ts:170` 在基线上就失败**（原生视图宽度误差 304px）。属既有缺陷，本阶段未修——它与配对无关，修它需要单独的窗口几何排查。
2. **`roundtable-workspace.e2e.spec.ts:289` 存在抖动**（`left` 40 → 326）。同构建 1/3 概率失败，怀疑是拆出/归位时原生视图迁移的时序，未定位。
3. **退出时序**：`before-quit` 先 `accountService.dispose()` 再 `remote.stop()`。若此刻恰有 register 在飞，收尾的撤销拿不到 Bearer → 只能 `cleanup pending`。影响面仅限「退出瞬间正在配对」，Cloud 上的 pending 会在 `expiresAt` 后被服务端清扫。**未修**（调整 quit 顺序影响面更大，需单独评估）。
4. **跨账户孤儿只能留痕、不能自动清理**：换账户/登出期间 Cloud 已签发凭据时不允许跨账户撤销，只能写 `lastError` 提示用户手动到设备列表删除。这是「不跨账户」铁律的必然代价。
5. **`discardSavedCredential` 的「不删另一台设备」守卫当前不可达**：`register()` 已拒绝在 `deviceId` 存在时注册，因此该分支属防御性代码，没有直接用例。
6. **正式配对设备的 `forget()` 不撤销 Cloud 设备**（首轮语义，本阶段刻意保留，见第十节末）。
7. **真实公网部署 + WSS 真机 9 项验收 NOT VERIFIED**（需服务器授权）。
8. **设备 `77f9f052` 在线状态本阶段未重新实测**：第六节记录的是 R5-R3.4 首轮结果；本阶段未改动加载/连接路径，但也没有主动连真实 Cloud（避免覆盖在线设备凭据）。
9. **隐私政策 / Terms 未重写**；R4 遗留 FAIL（工具级 OAuth 触发、DCR、`securitySchemes`）未动——均不在本阶段范围。

## 十六、R5-R3.4.3 建议

按优先级：

1. **退出时序**：让 `before-quit` 在 `accountService.dispose()` **之前**先 `await remote.stop()`（或给配对收尾留一个「凭据仍可用」的窗口），消掉风险 3。
2. **跨账户孤儿的可见化**：现在只有一条 `lastError`。建议在设置页把「待手动清理的 Cloud 设备」做成一条显式提示（含设备名与跳转指引），而不是依赖用户去读「最近错误」。
3. **修 / 隔离 `card-workspace:170` 与 `roundtable-workspace:289`**：两个都与配对无关，但会让每次 `pnpm e2e` 的 exit code 为 1，掩盖真正的新失败。
4. **真机验收**：拿到服务器后跑公网部署 + WSS 真机 9 项（含 Host/Origin 负例）。
5. **回到 R4 最高优先级 FAIL**：工具级 OAuth 触发（`securitySchemes` + `_meta["mcp/www_authenticate"]`）——它决定 ChatGPT 会不会自动弹授权，需要单独授权后进行。
