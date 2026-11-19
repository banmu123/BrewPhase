# BrewPhase Remote MCP — 实施阶段 · 后续阶段与门禁（Phase 1.2–1.5 / §4–§6）

> **分册说明**：本册从 `REMOTE_MCP_PHASES.md` 按整章拆出，阶段号/章节号沿用全系列编号。
> 本册：Phase 1.2 / 1.3 / 1.4 / 1.5、§4 全阶段共同门禁（含 §4.1 测试矩阵归属）、§5 依赖关系图、§6 实际交付。
> 全系列索引见 `REMOTE_MCP_INDEX.md`。基线 `feature/remote-mcp` @ `fc96654`。
> 本册由原文档整章拆出（仅搬移 + 补导航，无内容变更）；**其后叠加 Phase 0 的
> P0-1 / P0-2 修订**，逐条见 `REMOTE_MCP_INDEX.md` §7。

---

## Phase 1.1B.1 — Desktop 协议与安全边界收口

范围与验收见 `REMOTE_MCP_PHASES.md` §1B.9（同一阶段，不另立章节编号）。
这里只记**它如何改变 1.2 的开工条件**：

| 对 1.2 的影响 | 内容 |
|---|---|
| 接入校验的真值来源变了 | 1.2 的 `/device-link` 必须按协议 §4.3 的 10 步实现，**不能**照抄 Mock 的简化版（Mock 不做 nonce 去重、不做多实例路由、不做 OAuth） |
| `hello` 字段与签名已冻结 | Cloud 侧验签必须用 `helloSigningPayload` 的同一份规范串；字段集变更需递增版本前缀 |
| `serviceable` 是 Desktop 上报的提示 | 1.2 的路由可以据此暂停派发，但**不得**据此跳过 grant/scope 校验 |
| 注册端点契约已定 | §3.2/§3.3/§3.4 的请求/响应形状已在 Mock 上跑通；1.2 照实现即可，`claim_secret` 只存 `sha256`、领取必须条件 UPDATE |
| Desktop 侧注册客户端已就绪 | `createHttpDeviceRegistrar` 已实现；1.2 之后只需把「用户 Bearer 从哪来」接到 AccountService（当前 `RemoteService.register()` 在没有 registrar 时**明确抛错**，不伪造成功） |

**仍然阻塞 1.2 的项**：无。1.1B.1 的验收项与方法见 §1B.9。

---

## Phase 1.2A — Cloud 设备面（1.2 的第一个子阶段）

**范围**：表结构 + 注册 / 确认 / 领取 / 管理 API + Desktop 注册客户端接入真实 Cloud。
**不含**：WSS Gateway、`/device-link`、Ed25519 握手、ConnectionRegistry、心跳、
req/res 转发、grant_update 在线同步、MCP OAuth（属 1.2B / 1.3）。

| # | 1.2A 已落地 | 依据 |
|---|---|---|
| B1 | `mcp_devices`（含 `grant_epoch INTEGER NOT NULL DEFAULT 0`） | 协议 §3；安全 §2.3 |
| B2 | `register` / `confirm` / `credentials` / `GET 列表` / `GET 详情` / `suspend` / `resume` / `DELETE` | 协议 §3.2–§3.5 |
| B3 | 一次性领取：条件 UPDATE + `RETURNING` 行数 | 协议 §3.4 |
| B4 | 状态机单条原子 UPDATE；`revoked` 终态 | 安全运维 §4.0 |
| B10 | 迁移 `0001_remote_mcp_devices` + `startSweep` 清理过期 pending | 本文 §2.1 |
| B12 | 两表**无外键、互不级联** | 安全运维 §4.1 规则 2 |

**实现时补齐的两处契约缺口**（已回写协议 §3.3 / §3.4）：

- 「还没确认」必须回 **202** 而不是 4xx：Desktop 的轮询把 4xx 当终态，
  回 4xx 会让一次正常注册在第一次轮询就死掉。原文只写了「否则 409」。
- 「已 active 再确认」原文自相矛盾（同一格既 409 又 200），取**幂等 200**。

**1.2A 的两处已知取舍**（必须在 1.2B 之前决定是否收紧）：

| 取舍 | 说明 |
|---|---|
| 注册的并发配额 | 「同一用户 ≤5 台」在事务里做「查计数 → 插入」，两个并发注册可能各自读到 4 而都插入（得到 6 台）。配额不是安全边界（用户只能多注册自己的设备），但若要严格需加部分唯一索引或行锁 |
| `token_expires_at` 已入库但无人校验 | 30 天的 device_token 寿命现在只写不读；**1.2B 的握手第 4 步必须校验它**，否则「token 永不过期」 |

---

## Phase 1.2B — Cloud WSS Gateway

范围：B5–B9、B11、B13、B14。前置条件是 1.2A 的管理面已经能签发并撤销设备凭证。

### 2.0 子阶段划分（Phase 1.2B.1 定稿）

1.2B 太大，拆成两个可独立验收的子阶段。**分界线是「连接层 / 转发层」**：

| 子阶段 | 范围 | 状态 |
|---|---|---|
| **1.2B.1** | B5（WSS 接入 + hello 握手）、B6（ConnectionRegistry）、B7（心跳）、B9（撤停联动）、B11（运维断言） | ✅ **已完成** |
| **1.2B.1.2** | 连接生命周期与设备准入的并发收口（P1 幽灵路由 / P2 撤停与握手竞争） | ✅ **已完成**（见 §2.0.1） |
| **1.2B.2.1** | B13（设备凭据轮换 + 连接级 `rotating`） | ✅ **已完成**（见 §2.0.2） |
| **1.2B.2.2** | B8（req/res/cancel 转发）、B14（转发前跨用户校验）、`grant_update` 在线同步 | ✅ **已完成**（见 §2.0.3） |

#### 2.0.1 Phase 1.2B.1.2：两个竞态与修复

1.2B.1 的实现**功能正确但顺序不对**。两个竞态都不需要特殊条件就能触发，
而且当时 377 条测试全绿——因为它们只检查终态，不检查「中途是否 bind 过」。

**P1：握手期间的 close 会留下幽灵路由**

| 步骤 | 发生了什么 |
|---|---|
| 1 | hello 到达，握手进入 `verifyHandshake`（await 数据库） |
| 2 | 客户端断开 → close 事件 → 旧 `onClosed` 设 `closed = true`；此时 `userId` 还是空串，**没有** unbind |
| 3 | 握手恢复，继续 bind（`registry` 里多了一条表项） |
| 4 | `sendJson(hello_ok)` 失败 → 再调 `onClosed` → **被 `closed` 幂等闸门挡住，直接返回** |
| 5 | 结果：registry 里有一条指向死 socket 的路由，`connection_count` 永远是 1 |

根因是把「连接已关闭」和「路由已清理」当成**同一个事实**。现在拆成三个独立事实
（`closing` / `bound` / `released`），并让清理不再复用同一个幂等闸门：
`converge()`（幂等，负责定时器与 live 表）与 `releaseRoute()`（可重入，
负责 unbind）分开。**迟到 bind 的清理只能由 binder 自己在恢复执行时完成**，
因为那时 `converge()` 早已跑完。

**P2：撤停与握手抢跑，已撤销的设备能重新上线**

| 步骤 | 发生了什么 |
|---|---|
| 1 | `verifyHandshake` 读到 `status = active`（快照） |
| 2 | 握手开始 `loadGrantRows`（await） |
| 3 | HTTP `suspend`/`revoke` 提交成功 |
| 4 | `disconnectDevice()` 查 registry：**还没有这条连接**，直接返回（无事可做） |
| 5 | 握手恢复，bind → 一台已 revoked 的设备出现在路由表里 |

根因是把 `verifyHandshake` 的设备快照当成「在这之后依然有效」。现在准入是
**独立的一次事务**（`cloud/src/link/admission.ts`）：

```sql
BEGIN;
SELECT id, user_id, status, token_hash, token_expires_at, grant_epoch
  FROM mcp_devices WHERE id = $1
   FOR UPDATE;          -- 与任何 UPDATE mcp_devices SET status=... 争同一把行锁
-- 锁内重验 token_hash / status / token_expires_at
-- 锁内 registry.bind(...)
COMMIT;                 -- 线性化点
```

**为什么选行锁而不是进程内 per-device mutex**：

| 方案 | 谁必须记得参与 | 失效方式 |
|---|---|---|
| 进程内 mutex | **每一个**写设备状态的代码路径（现在 3 条，将来更多） | 新增一条写路径忘了加锁 → 静默回归 |
| **PG 行锁（采用）** | **没有人**——`UPDATE mcp_devices SET status` 自动持有行锁 | 写路径无法绕过 |

行锁把「必须参与互斥」从一个约定变成了数据库事实。这正是任务书要求
「不能只在握手内部加锁」的落地方式。

**线性化后只允许两种结果**：

```
① 握手先拿锁 → bind → COMMIT → suspend 的 UPDATE 才提交
   → cleanupConnection 查得到连接 → bye + close 4005

② suspend 的 UPDATE 先提交 → 握手在锁内读到 suspended
   → 拒绝 + close 4005，不 bind
```

不存在第三种（DB 已停/已撤销、registry 仍认为在线）。

**测试**：`cloud/tests/link/link-concurrency.test.ts`（16 条）。用可控 Deferred
在精确的 await 边界暂停，**不用 `setTimeout` 制造竞态**；行锁的判据是
`pg_stat_activity` 里出现 `wait_event_type = 'Lock'`（数据库自己的状态，
不是时间猜测）。

**变异验证**（证明测试真的在防回归，不是自说自话）：

| 变异 | 被抓到 |
|---|---|
| 迟到 bind 不自我清理 | T9 ✅ |
| 去掉 `FOR UPDATE` | T7 / T8 ✅（`no lock waiter appeared`） |
| 准入不重验 `suspended` | T5 ✅ |
| 准入不重验 `revoked` | T6 ✅ |
| 准入不重验 `token_expires_at` | 准入终审组 ✅ |
| 取消信号恒为 false | T1 / T2 / T3 / T4 / T10b ✅ |
| 停机不等进行中的握手 | T9b ✅ |
| 顶替时不标 `closing` | **不可观测**——`onFrame` 还有 `state === 'handshaking'` 兜底，两者行为等价。属防御性加固，如实记录而非假装被测到 |

**一个记录在案的协议行为**（不是缺陷）：同一设备并发发起两个握手时，
**后完成 bind 的赢**，先完成的会被 `drain` + `4006` 顶替。这是协议 §4.6
「后到者赢」的直接结果。Desktop 侧不会并发发起同设备握手，所以现实中不发生；
写成断言会与协议冲突，因此只在文档记录。

**1.2B.1 的验收边界（必须原样引用，不许省略）**：
> 只证明 Cloud Gateway 能**安全接入设备、验证身份、维护连接与心跳**。
> 它**不代表** Cloud 已经能向 Desktop 转发 MCP 请求——那条链路在 1.2B.2。

**1.2B.1 实际交付**：

| 项 | 落地 |
|---|---|
| WSS 接入 | 同一个 `http.Server` 上挂 `upgrade`（`ws` 的 `noServer` 模式 + `@hono/node-server` 的 `createServer` 注入），**不开第二个端口** |
| 模块 | `cloud/src/link/{link-server,handshake,connection-registry,nonce-store,heartbeat,schemas,index}.ts` + `cloud/src/server.ts`（生产与测试共用同一个装配函数） |
| 迁移 | `0002_mcp_grant_epoch`：只给 `mcp_grants` 加 `epoch INTEGER NOT NULL DEFAULT 1` + `CHECK (epoch >= 1)` |
| 帧上限 | 传输层 `maxPayload = 1 MiB`；ws 的超限 close `1009` 被翻译成协议要求的 **4009**（否则 Desktop 会按「可重连」处理，一个客户端 bug 变成重连风暴） |
| 黄金向量 | `fixtures/remote-mcp/hello-v1.json`，Cloud 与 Desktop 的测试**读同一个文件** |
| 测试 | Cloud **224 → 377**（+153，7 个新文件） |

**1.2A 遗留的两处取舍，本次处理结果**：

| 取舍 | 结果 |
|---|---|
| `token_expires_at` 无人校验 | ✅ **已修**：握手第 4 步改为读 `token_expires_at`；协议 §4.3 第 4 步同步修正（原文写的是 `expires_at`，那会让每台设备在注册 5 分钟后被判死） |
| 注册并发配额可能多出一台 | ⏸ **不修**：需要部分唯一索引或行锁，而配额不是安全边界（用户只能多注册自己的设备）。留作运维容忍项 |

#### 2.0.2 Phase 1.2B.2.1：设备凭据轮换与 `rotating`

范围只有 B13，但它是**唯一一个会主动作废自己凭据**的端点，所以判据不是
「轮换成功」，而是「旧身份不可能再被当作有效设备」。

**两处顺序约束**（都不是风格问题）：

| 顺序 | 写反的后果 |
|---|---|
| DB 提交 → 清连接 → `bye(rotated)` → close `4010` | 先断连接：旧凭据仍然有效，攻击者拿旧 token 重新握手回来 |
| 新凭据**落盘** → 换内存 → 重连 | 先重连：新 token 只在响应里出现一次，没落盘就永久丢失（Cloud 不补发） |

**`rotating` 是连接级状态，不是设备状态**。`mcp_devices.status` 仍只有
`pending/active/suspended/revoked`：轮换中的设备**可以**立刻用新凭据握手，
「能不能握手」与「旧连接能不能被路由」是两个判据，共用一个字段必然做错。

`lookup()` 在 `rotating` 时返回 `null`（不可路由），`lookupByDevice()` 仍返回
（还得能关掉它）。`markRotating` 必须带 `connectionId` 比对，否则会误标
刚重连上来的新连接。

**Desktop 侧的 4010 有歧义，必须按阶段区分**：

| 收到 4010 时 | 含义 | 处置 |
|---|---|---|
| 我们正在等轮换的 HTTP 响应（`requesting`） | 自己这次轮换的旧连接被关掉 | 什么都不做，等新凭据 |
| 已经在用新凭据连（`reconnecting`） | 又有人换了这台设备 | blocked，不重连 |
| 根本没在轮换 | 别处换了这台设备 | blocked，不重试 |

只看「有没有轮换任务在跑」会把第二种当成第一种吞掉：socket 已死、状态停在
connecting、没有任何定时器——连接永久假死，而日志里只有一行
「closed 4010 during rotation」。

**验收结果**（实际执行，不是设计意图）：

| 验收项 | 结果 |
|---|---|
| 旧 token 立即失效（401） | ✅ 同一事务覆盖 `token_hash`；并发下只有一个成功 |
| 旧公钥不能再握手 | ✅ 握手读的是被覆盖后的 `public_key` |
| 篡改签名 / device_id / 新公钥 → 拒绝 | ✅ 4 条（含「用另一把私钥伪造」） |
| suspended / revoked 不能轮换 | ✅ 409（并发路径与串行路径错误面一致） |
| 与 suspend / revoke 并发 | ✅ 行锁串行；两种线性化结果都测了 |
| 离线设备轮换 | ✅ 200，且不伪造连接 |
| `rotating` 后路由项被清除 | ✅ `lookup` null / `lookupByDevice` 仍可见 |
| 旧连接 close `4010` + `bye(rotated)` | ✅ |
| 迟到的 close 不删新连接 | ✅ connectionId 比对 |
| 落盘失败 | ✅ blocked，且不拿旧凭据重连 |
| 网络结果未知 | ✅ blocked，不重试（重试必然 401，会把「未知」变成「确定失败」） |
| 账户切换 / 登出 | ✅ 结果丢弃，不写旧账户目录 |
| 并发触发 | ✅ 单飞，`rotate` 只调一次 |
| 新旧密钥 | ✅ 每次重新生成；新私钥只经 safeStorage 落盘 |

**测试基线**：Cloud 393 → **432**（+39）；Desktop 1219 → **1245**（+26）。

**明确没做**（属 1.2B.2.2）：`req`/`res`/`cancel` 转发、`grant_update` 在线同步、
`install` 未 ack 阻断、`max_inflight` 调度、`delivery_id` 缓存、`deadline_ms` 预算、
MCP OAuth、`/mcp`、写工具、Redis 多实例。

> **ST-3 只覆盖了一半**：「轮换后旧连接发新请求 → 拒绝」需要 `req` 转发才有
> 判据点。现在能证明的是「旧连接被摘除路由 + close 4010」与「旧凭据无法再握手」。

#### 2.0.3 Phase 1.2B.2.2：请求转发、并发安全与 Grant 在线同步

这是 1.2B 的最后一个子阶段：Cloud 第一次**真的**能把一条工具调用送到设备上，
并把真实结果拿回来。它不开放任何公网端点（`/mcp` 属 Phase 1.3），
所以验收判据全部落在「授权边界」与「生命周期收敛」上。

**六个不可交换的顺序**

| 顺序 | 写反的后果 |
|---|---|
| 准入（三身份 + grant + 设备 + token）→ 预留槽位 → 写出 | 先占槽位再查库，一次越权尝试会占掉一个正常请求的名额 |
| DB 准入 → **重新核对 connectionId** → 写出 | 从查库到写出的窗口里连接可能被顶替，请求会落到别人的会话上 |
| `revoke` 本地停路由 → 结束在途请求 → 发帧 → 等 ack | 先发帧：从「帧已写出」到「本地停路由」之间仍会派发已撤销的 ctx |
| 每个 settle **恰好一次** → 归还三层计数 → pump 队列 | 漏 pump：释放出来的槽位要等下一条请求完成，队列会一直停泊 |
| 超时 → `REQUEST_TIMEOUT` + `cancel(gateway_timeout)` | 只返回超时而不 cancel：设备白做一次查询（只读，可接受；但不 cancel 就永远不知道） |
| 断线 → 该连接全部 pending 立刻 `DEVICE_OFFLINE` | 等 sweep 发现 deadline：调用方白等 15 秒 |

**三层在途计数**（`request-registry.ts`）：连接 `max_inflight`(2) / 设备 2 / 用户 4。
只做连接级在 Phase 1.4 多设备时直接失效；只做用户级挡不住「一台设备被打满」。
三层都记，代价是三个 `Map`，收益是「不需要在支持多设备时重写热路径」。

**两种 epoch 仍严格分离**：`mcp_devices.grant_epoch`（设备级，`grant_update` 的新旧门槛）
与 `mcp_grants.epoch`（单 grant，scope 变更 +1）。派发时两个都要对：前者决定
「这条连接上的上下文是否最新」，后者决定「`req` 引用的这条 grant 是否还是当前版本」。

**验收结果**（实际执行，不是设计意图）：

| 验收项 | 结果 |
|---|---|
| 正常往返（字段集 / hash / deadline / meta） | ✅ 34 条端到端（含 deadline / cancel） |
| ST-1：A 的 grant + B 的身份（两个方向） | ✅ `USER_MISMATCH`，且**一个 req 帧都没发** |
| 设备表归属被篡改（只查 grant 的实现会漏） | ✅ `USER_MISMATCH` |
| ST-3 剩余一半：轮换后旧连接不再收 req | ✅ 新凭据重连后恢复 |
| `rotating` 期间派发 | ✅ `DEVICE_UNAUTHORIZED` |
| 三层限流 / 队列满 / 排队超预算 | ✅ `DEVICE_BUSY`；排队项不发 cancel |
| deadline / 迟到 res / 断线 / 重复 res / 未知 res / 畸形 res | ✅ 各自收敛，不二次结算 |
| 取消（排队中 / 已发出） | ✅ `REQUEST_CANCELLED` + `cancel(client_cancelled)` |
| install 未 ack 不可路由 | ✅ `GRANT_CONTEXT_INVALID` |
| install `applied=false` → 整台设备停路由 | ✅ `syncLag` |
| revoke ack 超时 → 整台设备停路由 | ✅ `syncLag`；重连后由快照恢复 |
| revoke 先停路由再发帧 | ✅ 帧到达、未 ack 时派发已被拒 |
| scope 变更换 ctx（旧缓存不可回放） | ✅ `replaceGrant`：revoke 旧 → ack → install 新 → ack |
| 单 grant epoch 与库不一致 | ✅ 拒发（防「scope 已变、ctx 未更新」） |
| 设备离线 / rotating 时的同步 | ✅ 返回 `offline`，不伪造帧 |
| 两端 `request_hash` 同一串 | ✅ 共享 `fixtures/remote-mcp/req-v1.json` |
| 两端 `req` 字段集一致 | ✅ Cloud 接口 ↔ Desktop `remoteReqSchema` 合同测试 |

**测试基线**：Cloud 432 → **528**（+96）；Desktop 1245 → **1265**（+20）。

**明确没做**（属 Phase 1.3）：公网 `/mcp`（Streamable HTTP）、MCP OAuth / DCR、
`/authorize` / `/token`、Inspector 与 ChatGPT 真实连接、写工具、Redis 多实例、
`OAuth` 侧的授权落库（本阶段只做「下发 + 等 ack」）。

> **本阶段完成不代表已经支持 ChatGPT 连接。** 它证明的是内部远程请求传输与
> 授权机制已经打通，且任何一条越权/迟到/撤销后的路径都收敛到明确的错误码。

#### 2.0.4 Phase 1.2B.2.2-R1：派发、撤销与取消的竞态加固

1.2B.2.2 的验收全部通过，但它测的是**稳定态**：撤销之后不再派发、取消之后
不再发送。R1 补的是**窗口内**：检查通过了，而在写出去之前世界变了。

四个问题、一个共同形状——「先检查、后 await、再写」：

| # | 位置 | 缺陷 | 修法 |
|---|---|---|---|
| P0 | `dispatchToolCall` 最终核对 | 最终 `lookup` 的 await 在 `reserve()` **之前**，撤销的 `rejectByGrantCtx` 看不到这条请求 | `reserve` 提到 await 之前，`settled` 之后不再写 |
| P1 | 同一处 | `lookup` 对 rotating 返回 `null`，被映射成可重试的 `DEVICE_OFFLINE` | 用 `ConnSync.rotating` 区分：rotating → `DEVICE_UNAUTHORIZED` |
| P1 | AbortSignal | signal 已 aborted 时先结算、随后仍无条件 `sendEntry` | 进入前直接返回；`sendEntry` 首行判 `settled`；新增内部事实 `frameSent` |
| P1 | 重复 `install` | 只挡 `ack_timeout`，`rejected` 之后继续安装 → ack 把路由「恢复」 | 只有 `applied` / `not_installed` 才继续；三失败各自独立返回与记日志 |

**线性化边界**：`reserve()` 是「撤销能不能看见这条请求」的唯一判据。
它必须早于任何并发敏感的 `await`。

**验收结果**（实际执行）：

| 验收项 | 结果 |
|---|---|
| 撤销落在最终核对期间（请求已登记、未写出） | ✅ `GRANT_REVOKED`；Desktop 零 req；计数归零 |
| 同上，另一条 grant 的往返当投递屏障 | ✅ 帧数恰好 +1（被拦下的那条从未出现） |
| 请求已在途后被撤销 | ✅ `GRANT_REVOKED`；迟到 res 被忽略；调用方拿不到撤销前的数据 |
| 轮换落在同一窗口 | ✅ `DEVICE_UNAUTHORIZED`（`retryable=false`），**不是** `DEVICE_OFFLINE` |
| 进入前已 abort | ✅ `REQUEST_CANCELLED`；`lookupByUser` / `lookup` 调用数均为 0（⇒ 未查库）；计数 0 |
| 已登记、未写出时 abort | ✅ 不写 req、不发 cancel（`frameSent=false`）；计数归零 |
| 已写出后 abort | ✅ `cancel(client_cancelled)` 照旧（best-effort，同步 handler 不可中断） |
| 重复 install：旧 ctx 撤销被拒 | ✅ 返回 `rejected`；只有 1 条 `grant_update`；`syncLag=true`；另一条 grant 也停路由 |
| 重复 install：撤销超时 | ✅ 返回 `ack_timeout`；不发第二条 install |
| 拒绝之后再 install | ✅ `sync_lag`；迟到 ack 不能恢复路由 |
| 真实进程（`dist/` + 真 PG + 真 ws） | ✅ 26/26；同一脚本在修复前的构建上第一个判别点即失败 |

**测试基线**：Cloud 528 → **540**（+12，新增 `tests/link/dispatch-race.test.ts` 7 条）；
Desktop 不变（本阶段未改 Desktop 代码）。**无新增迁移，无新增协议字段**
（`frameSent` 是 Cloud 进程内状态）。

**变异验证**（把生产代码退回修复前，用新测试跑）：6 条新用例失败，
其中「轮换」那条的实际返回是 `DEVICE_OFFLINE / retryable=true`——正是待修的 bug。

**遗留**：「reserve 之后、写出之前」这段窗口在 Cloud 侧已由 `settled` 判据关闭，
但 `admitDispatch` 那两次查库仍在 `reserve` 之前。它不构成撤销窗口（撤销此时
还看不到请求，但请求也还没占槽位、没写帧，最终核对会拦下它）；把它进一步收窄
需要「先登记后查库」，代价是越权尝试会短暂占用槽位——留待后续阶段评估。

#### 2.0.5 Phase 1.2B.2.2-R2：`syncLag` 的连接级 fail-closed 收口

R1 修的是「派发与撤销」；R2 修的是「`syncLag` 置位之后，**队列里的其他 grant**
还能不能出去」。答案是：修复前能。

**根因**（不是推测，先复现再改）：

```
连接上 Grant A（同步失败）与 Grant B（健康）
B：req1 → sent，req2 → sent，req3 → queued

A 的 grant_update → applied=false → syncLag = true
  rejectByGrantCtx(A 的 ctx) 命中 0 条        ← 队列里那条是 B 的
req1 的 res → settle → pump → promote(req3) → sendEntry   ← 无闸门
  ⇒ B 的 req3 被写进一条「授权状态不可信」的连接
```

`syncLag` 原来只是 `dispatchToolCall` 入口 / 最终核对里的一个判断，而队列项
**不重新经过**那些判断。

**修法**（三处同时成立，§9.6）：

| 位置 | 变化 |
|---|---|
| `markSyncLag(conn, cause)` | `syncLag` 的唯一赋值点：置位 + 记原因 + **立刻**结算本连接全部排队项 + 泵一次 |
| `RequestRegistry.rejectQueuedByConnection` | 新方法：只拒绝 `queued`，已写出的不动，不归还任何计数（它们从未占过） |
| `sendEntry()` / `sendGate()` | 写帧前的最后一道：已结算 / 连接在 / 未 rotating / 未 `syncLag` / ctx 仍是当前映射（**不查库**） |
| `pump()` | 改为「promote → 逐条过闸门 → 再 promote」的循环，重入用 `pumping` 标志压平 |

四条失败路径（`applied=false` / ack 超时 / 帧未写出 / 重复 install 的撤销失败）
全部收敛到 `markSyncLag`；`offline` 也置 `syncLag`（帧没写出去 ≠ 对端状态已知）。
三种原因各自保留日志与 `inspect().syncLagCause`。

**验收结果**（实际执行）：

| 验收项 | 结果 |
|---|---|
| `applied=false` 后其他 grant 的排队项 | ✅ 那一刻即 `GRANT_CONTEXT_INVALID`，不等任何 res |
| 同上，完成在途请求触发的 pump | ✅ 零新 `req`；已写出的两条仍能正常 `res` |
| ack 超时（推到真实 ack deadline，排队预算 60s） | ✅ 排队项立即收敛；`syncLagCause=ack_timeout` |
| 帧写不出去（只让 `grant_update` 失败） | ✅ 返回 `offline`，事件 `link_grant_sync_offline`，**不**报 `ack_timeout` |
| 连接已收敛后的迟到失败 | ✅ 不影响新连接（新 `connectionId` 上 `syncLag=false`） |
| 连接 A 的 `syncLag` 对连接 B | ✅ B 的排队项照常 promote 并写出 |
| 同一队列项二次结算 | ✅ 第二次返回 false，计数不变 |
| 恢复 | ✅ 迟到 ack / install / 派发全部仍 blocked；重连后恢复 |
| 真实进程（`dist/` + 真 PG + 真 ws） | ✅ 25/25；同一脚本在修复前的构建上 **19/25**，且多写出一条 `req` |

**测试基线**：Cloud 540 → **557**（+17）；Desktop 1265 不变（未改 Desktop 代码）。
新增 `tests/link/sync-lag.test.ts`（9 条，forwarder 级 + 可控传输）与
`grant-sync.test.ts` +4、`request-registry.test.ts` +4。
**无新增迁移、无新增协议字段、无新增错误码**（`syncLagCause` 只在 `inspect()` 里）。

**变异验证**（5 个变异，4 个被抓）：

| 变异 | 结果 |
|---|---|
| `sendGate` 去掉 `syncLag` 判断 | 1 条失败（专门的「闸门兜底」用例） |
| `markSyncLag` 不清队列 | 5 条失败 |
| `rejectQueuedByConnection` 连已写出的也拒 | 7 条失败 |
| `syncLag` 原因可被二次失败覆盖 | 1 条失败 |
| `sendGate` 的 `!conn` 分支改错错误码 | **未抓到**——该分支在当前流程下不可达（`onConnectionLost` 总是先结算该连接的全部请求），属纯防御 |

**遗留**：`sendGate` 的 `!conn` 分支与 `markSyncLag` 的「连接已收敛」分支都是
不可观测的防御路径，如实记录；`syncLag` 仍不阻止 `revokeGrant` 的后续帧
（撤销本身必须能发出去），这是设计选择而非缺陷。

### 2.1 范围

| # | 能力 |
|---|---|
| B1 | 表 `mcp_devices`：`id, user_id, name, platform, public_key, status(pending\|active\|suspended\|revoked), confirm_code_hash, claim_secret_hash, expires_at, token_hash, token_issued_at, key_rotated_at, last_seen_at, grant_epoch INTEGER NOT NULL DEFAULT 0, revoked_at, created_at`（`grant_epoch` 为 Phase 0 / P0-1 新增，设备级单调计数） |
| B2 | 端点：`POST /mcp-devices/register`、`POST /mcp-devices/{id}/confirm`、`POST /mcp-devices/{id}/credentials`（**请求体传 `claim_secret`，不入 URL**）、`GET /mcp-devices`、`POST /mcp-devices/{id}/rotate`、`POST /mcp-devices/{id}/suspend`、`POST /mcp-devices/{id}/resume`、`DELETE /mcp-devices/{id}` |
| B3 | **凭证领取闭环**：`claim_secret` 生成/只存哈希/一次有效；领取用**条件 UPDATE + RETURNING** 保证原子（协议 §3.4） |
| B4 | 设备状态机：`pending → active → suspended ⇄ active`；任意状态 `→ revoked`（安全 §4.0 S2）。**状态转换只用单条 UPDATE，不做多步** |
| B5 | WSS 接入：`/device-link`，握手校验 9 步 + `hello_ok` 构造（协议 §4.3 共 10 项），含 Ed25519 验签与**原子 nonce 去重** |
| B6 | 连接表：`ConnectionRegistry` 内存实现 + 接口定稿；顶替时**先 bind 新、再断旧** |
| B7 | 心跳：`ping`/`pong`、60s 无 `pong` 断连、`last_seen_at` 更新 |
| B8 | 转发：`req`/`res`/`cancel` + **`grant_update`/`grant_update_ack`**；`deadline_ms` 原样传播，`max_inflight` 限流，`drain` 时停路由；**`install` 未 ack 前不得为该 grant 路由**，`revoke` 先停路由再发帧（协议 §6.5） |
| B9 | 撤销：**先持久化 `status`**，再删路由、再发 `bye`/close（协议 §11.2） |
| B10 | 迁移 `0001`：`mcp_devices` 表 + **`mcp_grants` 表（最小列，见安全 §2.2）** + `startSweep` 清理过期 pending。**`mcp_grants` 必须在 1.2 建**：B14 / ST-1 的跨用户校验要读它，而 ST-1 是 1.2 的发布阻断项 |
| B11 | 运维：`/ready` 暴露 `instance_id`、`connection_count`；`GATEWAY_EXPECTED_REPLICAS>1` 拒绝启动 |
| B12 | **设备与 grant 的关系**：两表无外键、互不级联；撤销设备不撤 grant（安全 §4.1 规则 2） |
| B13 | **轮换的 `rotating` 状态**：② 提交后旧连接上的新 `req` 立刻回 `DEVICE_UNAUTHORIZED`（协议 §11.6） |
| B14 | **`mcp_devices` 与 grant 的跨用户校验**：转发前查 `grant.user_id == device.user_id`（ST-1） |

### 2.2 涉及模块

```
cloud/src/mcp-devices/{service.ts, routes.ts, claim.ts, rotate.ts}
cloud/src/link/{link-server.ts, handshake.ts, connection-registry.ts, forwarder.ts}
cloud/src/db/schema.ts                  （加 2 表：mcp_devices、mcp_grants；不动现有 6 张）
cloud/src/db/migrations/0001_remote_mcp.sql
cloud/src/app.ts                        （挂新路由；不碰现有 9 条）
cloud/tests/{mcp-devices,link}/*.test.ts
```

> **`auth_sessions.session_kind` 不会加**（OQ-3 已于 1.3.0 定稿）：MCP 的
> refresh 走独立两层（`mcp_sessions` 身份 + `mcp_refresh_tokens` 每代凭据），`auth_sessions` 保持零改动。详见
> `REMOTE_MCP_PHASE_1_3_DESIGN.md` §9。

### 2.3 测试要求

- 注册：公钥长度非法 / 设备数超限 / 重复公钥 → 各自 4xx ≥ 6 条
- **领取闭环**：无 claim → 403；错 claim → 403；未 active → 409；
  **并发两请求只有一个成功**（`Promise.all`，断言 1 个 200 + 1 个 409）≥ 8 条
- **凭证传输（1.0.3 新增）**：`claim_secret` **只出现在请求体**——断言
  (a) 请求行与 query 不含它；(b) 访问日志不含请求体；(c) 错误响应体不回显；
  (d) 用哨兵 claim（`SENTINEL-CLAIM-4b1d`）跑一次后 grep 全部日志 0 命中 ≥ 4 条
- 确认：错码 / 过期 / 已 active 幂等 / 错 5 次锁定 ≥ 6 条
- 握手校验 9 步逐项负例（token 错 / pending / suspended / revoked / nonce 重放 /
  ts 偏移 / 签名错 / 版本无交集 / 重复连接顶替）≥ 18 条
- **撤销顺序**：撤销后即使 `unbind` 抛错，用旧 token 握手仍被拒（断言）≥ 2 条
- 轮换：旧 token 立即失效、`rotating` 窗口内新 req 被拒、旧连接被 close `4010` ≥ 6 条
- 心跳：3 次丢失断连、`last_seen_at` 正确 ≥ 5 条
- 转发：正常 / 设备离线 / `max_inflight` 超限 / deadline 到点 / cancel / drain ≥ 10 条
- **Grant 上下文（P0-1）**：`hello_ok.grants` 只含同 user 且未撤销的 grant；
  `install` 未 ack 不路由；`revoke` 先停路由再发帧；ack 超时 → `grant_sync_lag`
  并暂停向该设备路由所有 grant ≥ 8 条
- **安全矩阵 ST-1 ~ ST-3、ST-11 ~ ST-12**（安全 §7.1）| 5 条，**全部发布阻断**
- 迁移：幂等、可重复跑、不破坏现有 6 张表 ≥ 3 条
- **回归**：现有 cloud **161** 条全绿

### 2.4 验收标准

1. 两台设备不能同时在线（旧连接被 `4006` 顶掉，旧设备侧**不重连**）。
2. 撤销设备后，用旧 `device_token` 握手返回 `4003`，且 `registry.lookup` 为 null。
3. **先 bind 后 `hello_ok`**：用一个在 `hello_ok` 后立刻发 `req` 的测试证明不丢。
4. **撤销顺序可测**：让 `unbind` 人为抛错，断言后续握手仍被拒（持久化优先）。
5. **并发领取只有一个成功**（条件 UPDATE 生效）。
6. **ST-1 / ST-2 / ST-3 / ST-11 / ST-12 全部通过**（跨用户 grant、token-signature 错配、
   轮换窗口、Cloud 重启不重放、撤销后握手）。
7. 已有 9 条身份路由的响应体逐字节不变（快照测试）。
8. 现有 6 张表结构未变（对比 `information_schema.columns` 快照）。
9. **Grant 上下文（P0-1）**：`hello_ok.grants` 只含 `grant.user_id == device.user_id`
   且 `revoked_at IS NULL` 的 grant；`install` 未 ack 时该 grant 的 `req` 不得转发；
   `revoke` 后旧 `grant_ctx` 在 Cloud 侧即被拒（ST-1 的补充，不替代 ST-1）。
10. **迁移幂等**：`grant_epoch` 列对已有行取默认值 0，重复执行不报错。

> **Phase 1.2B.1 的实际结果**（对照上表，只覆盖 B5/B6/B7/B9/B11）：
>
> | 验收项 | 结果 |
> |---|---|
> | 两台设备不能同时在线 | ✅ 旧连接收到 `drain{grace_ms:0}` + close `4006` |
> | 撤销后旧 token 握手 `4003`、`lookup` 为 null | ✅ |
> | 先 bind 后 `hello_ok` | ✅ `hello_ok.connection_id` 与 registry 表项逐字相同 |
> | 撤销顺序可测（`unbind` 人为抛错） | ✅ 注入后仍拒绝旧 token |
> | 并发领取只有一个成功 | ✅（1.2A 已验） |
> | ST-1 / ST-2 / ST-11 / ST-12 | ST-2 ✅、ST-11 ✅、ST-12 ✅；**ST-1 属 1.2B.2**（没有 `req` 就没有「转发前校验」） |
> | 9 条身份路由响应不变 | ✅ 1.2A 的 224 条测试原样全绿 |
> | 6 张旧表结构未变 | ✅ 真实基线逐列比对 |
> | Grant 上下文快照 | ✅ `hello_ok.grants` 只含同 user 且未撤销；`grant_update` 属 1.2B.2 |
> | 迁移幂等 | ✅ 0002 重复执行不改变数据，旧行 `epoch = 1` |
>
> **1.2B.1.2 追加**：上面这张表里的「✅」在 1.2B.1 时都只验证了**终态**。
> 并发收口之后，同样的条目改为结构断言（`bind` 调用次数、锁等待、定时器状态），
> 见 §2.0.1。
>
> **`rotating` 已在 1.2B.2.1 落地**（§2.0.2）：标记、摘路由、`bye(rotated)`、
> close `4010` 全部实现且可测。剩下的是「转发层读到 `rotating` 时回
> `DEVICE_UNAUTHORIZED`」——它随 `req` 转发一起进 1.2B.2.2，
> 接口 `isRotating(deviceId)` 与 `ConnectionInfo.rotating` 已经就位。


### 2.5 风险

- 首个长连接服务：Cloud 单实例重启时来不及发 `drain`，连接全断 → 设备退避重连。
  **接受**，但需在文档写明「重启会让在线设备短暂 DEVICE_OFFLINE」。
- `@hono/node-server` 的 `websocket` 注入需实测（`serve({ websocket: { upgrade } })`）。
- 单副本无法技术强制（协议 §12.2）：靠启动断言 + `/ready` + 部署清单。
- **与 1.1B 并行时的接口漂移**：靠 §5 的三条硬条件约束（协议冻结 + 同一 Mock 向量 + 独立验收）。
- **「1.2 通过」被误读为「链路打通」**：1.2 的 Mock Device 是按文档手写的对端，
  只能证明 Cloud 侧符合文档。集成结论必须留到 1.3 真实联调，见 §5.1 的验收边界表。

---

## Phase 1.3 — Cloud MCP 前端与独立 OAuth AS

> **本节的实现要求已由 Phase 1.3.0 重新冻结。** 完整设计（规范对照、
> 双时代策略、OAuth 时序、Discovery 结构、OQ-3 决策、数据表草案、
> 测试矩阵、`NOT VERIFIED` 清单）见
> **`REMOTE_MCP_PHASE_1_3_DESIGN.md`**。当本节与该文件冲突时以该文件为准。
>
> **1.3.0 修订了四处会直接写错实现的说法**：
> 1. `initialize` 属 **legacy** 时代；2026-07-28 的 modern 客户端用逐请求
>    `_meta` + `server/discover`，**没有** `initialize`。两者都要服务。
> 2. `GET /mcp` 的 SSE 流已被规范**移除**，恒返回 `405`；不是「以后再加」。
> 3. DCR 已**弃用**（`MAY`），不是唯一注册路径；CIMD 才是规范首选。
> 4. 协议层会话（`Mcp-Session-Id`）已被移除；我们**不生成**任何协议层会话。
>    OQ-3 的「会话」指的是 OAuth refresh 容器，两件事无关。

### 3.0 拆分（1.3.0 冻结）

| 子阶段 | 主题 | 产出 |
|---|---|---|
| **1.3.0** | 规范对齐与设计冻结 | 本文件 + `REMOTE_MCP_PHASE_1_3_DESIGN.md`；**零代码** |
| **1.3.0-R1** | 浏览器授权闭环 + Session 两层模型 + 最小权限 | 只改文档 |
| **1.3.1-A** | **数据层**：迁移 `0003` 五张表 + Drizzle schema + 约束测试 | ✅ **已完成**（见 §3.6） |
| **1.3.1-B** | Refresh Token 核心服务（签发 / 轮换 / 重放 / 90 天上限）+ Session 生命周期 | ✅ **已完成**（见 §3.7） |
| **1.3.1-C1** | Access Token + 浏览器 Cookie 基础设施；修 Grant 撤销竞态 | ✅ **已完成**（见 §3.8） |
| **1.3.1-C2a** | authorize / login / Provider callback 浏览器授权基础流程 | ✅ **已完成**（见 §3.9） |
| **1.3.1-C2b** | Consent GET/POST（同意页 + grant upsert + 授权码签发） | 待开工 |
| **1.3.1-C3** | token / revoke / discovery / CIMD / DCR | 待开工 |
| **1.3.2** | Streamable HTTP 与工具服务 | `POST /mcp`（dual-era）、Bearer + audience + grant 回查、8 个只读工具、错误面、日志纪律 |
| **1.3.3** | 真实客户端联调 | Inspector、ChatGPT、Grok、refresh 行为、撤销/离线/异常恢复、回填 `NOT VERIFIED` |

### 3.1 范围（1.3.1 + 1.3.2）

| # | 能力 | 子阶段 |
|---|---|---|
| C1 | `POST /mcp`：`createMcpHandler(...).fetch`（SDK 已内部封装 transport，**不再手接** `WebStandardStreamableHTTPServerTransport`） | 1.3.2 |
| C2 | 工具面：8 个只读工具，schema 与 Desktop `TOOL_DEFINITIONS` 一致（一致性测试） | 1.3.2 |
| C3 | MCP OAuth AS：`/mcp/oauth/authorize`、**`/mcp/oauth/login`**、**`/mcp/oauth/callback/:provider`**（MCP 专用，非复用 Desktop 的）、**`GET/POST /mcp/oauth/consent`**、`/mcp/oauth/token`（`authorization_code` + `refresh_token`）、`/mcp/oauth/register`（DCR，**默认关闭**）、`/mcp/oauth/revoke` | 1.3.1 |
| C4 | 元数据：`/.well-known/oauth-protected-resource`（含 path-inserted 变体）、`/.well-known/oauth-authorization-server` | 1.3.1 |
| C5 | 表：`mcp_oauth_clients`、`mcp_auth_requests`、`mcp_auth_codes`、`mcp_sessions`、`mcp_refresh_tokens` 五张（**`mcp_grants` 已在 1.2 建**，本阶段只写入 grant，不重建）——**1.3.1-A 已落地为 0003** | 1.3.1-A ✅ |
| C6 | Scope 校验：Cloud 侧**逐 grant**（每次 `/mcp` 回查 `mcp_grants`）+ Desktop 侧**逐请求**（按 `grant_ctx`） | 1.3.2 |
| C7 | challenge：**401** = `Bearer resource_metadata="…"`（**不带 `scope`**）；**403** = `Bearer error="insufficient_scope", scope="<缺的那一个>", resource_metadata="…"` | 1.3.2 |
| C8 | 日志纪律：只 tool/status/duration/error_code/delivery_id/**`jti` 前 8 位**/`grant_id`（安全 §3.2.1、协议 §13.3） | 1.3.2 |
| C9 | **MCP 专用 JWT**：`signMcpAccessToken` / `verifyMcpAccessToken`，`aud = MCP_RESOURCE`（= `<baseUrl>/mcp`，≠ `brewphase-desktop`）；**不改**现有 `signAccessToken` | 1.3.1 |
| C10 | **会话归属**：**独立 `mcp_sessions`（身份）+ `mcp_refresh_tokens`（每代凭据）两层**（OQ-3 已定，见设计 §9）；`sid` 跨刷新不变；`absolute_expires_at` 不可变；**不改** `auth_sessions` | 1.3.1 |
| C11 | **真实客户端验收**（见 §3.4 门禁表）——只有 1.3.3 能做 | 1.3.3 |
| C12 | **浏览器授权会话**：签名 Cookie `bp_mcp_bs`（`HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/mcp/oauth` / 30 min / 不滑动）、TOFU 绑定、CSRF | 1.3.1 |
| C13 | **最小权限 scope**：401 省略 `scope`；`tools/list` 不需业务 scope；`tools/call` 缺 scope 才 403 且只报缺的那个；consent 页可逐项取消；step-up 扩权 | 1.3.1（consent 收窄）+ 1.3.2（403/step-up） |

### 3.2 关键差异（与现有登录 OAuth）

| 项 | 现有 `/oauth/*` | 新增 MCP AS |
|---|---|---|
| 路径组 | `/oauth/*` | **`/mcp/oauth/*`**（元数据仍在根 `/.well-known/*`，RFC 要求）；consent 在 `/mcp/oauth/consent` |
| 浏览器会话 | **无**（Desktop 是应用内开系统浏览器 + 本机回环回调） | **签名 Cookie `bp_mcp_bs`**（仅 `/mcp/oauth` 路径，30 min） |
| 授权请求表 | `oauth_transactions` | **`mcp_auth_requests`**（新建，两者不共用） |
| 授权码表 | `oauth_codes` | **`mcp_auth_codes`**（新建，含 `grant_id` / `scope` / `resource`） |
| 会话表 | `auth_sessions` | **`mcp_sessions` + `mcp_refresh_tokens`** |
| `redirect_uri` | **只允许** `http://127.0.0.1:<port>/callback`（正则硬编码） | 注册表**精确匹配**（可 https，可 localhost），**不用通配** |
| `grant_type` | 无此字段（`tokenRequestSchema` 只有 code/verifier/redirect_uri） | 必须支持 `authorization_code` + `refresh_token` |
| scope | 无（JWT 无 scope claim） | 必须携带、必须校验、必须在同意页逐项展示 |
| `aud` | 硬编码 `brewphase-desktop` | `MCP_RESOURCE`（新常量），两套 token 互不通用 |
| 会话表 | `auth_sessions` | `mcp_sessions`（独立，生命周期不同） |
| 客户端 | 只有第一方 Desktop | 第三方（ChatGPT 等） |
| 用户同意 | 无 consent 页 | **必须有**（逐项列 4 个 scope） |

**必须新建路由组，不得改动现有 `/oauth/authorize` 的白名单**——那条白名单是
Desktop 登录的安全边界，放宽它等于允许任意站点做 redirect 劫持。

**同样不得复用 Desktop 的登录链路。** Phase 1.3.0-R1 核对真实代码后确认
（设计 §1.5）：Cloud **没有任何 Cookie**、`/auth/*` **全是 Bearer**、
`handleProviderCallback()` 会签发 `oauth_codes` 并重定向到 **127.0.0.1**。
因此 MCP 必须有自己的浏览器授权流程：`mcp_auth_requests` + MCP 专用
Provider 回调 + `/mcp/oauth/consent`。可复用的只有 Provider 适配器
（参数化的 `cloudRedirectUri`）与 `findOrCreateUserWithIdentity()`。

**协议版本策略**（1.3.0 新增，实现必须遵守）：`POST /mcp` 同时服务
modern（2026-07-28）与 legacy（2025-06-18/25），用
`createMcpHandler(..., { legacy: 'stateless' })`；**不发** `Mcp-Session-Id`；
`GET`/`DELETE` 恒 `405`。见设计 §3。

### 3.3 测试要求

- 授权码：PKCE S256、一次性、60s、`redirect_uri` 严格匹配 ≥ 14 条
- **浏览器授权会话**（Cookie 签名 / `Path` / `HttpOnly` / `SameSite` / TTL / 篡改）≥ 10 条
- **Consent 闭环**（未登录→登录→同意；拒绝；全不选；过期；绑定不匹配；CSRF）≥ 14 条
- **首次用户**：库中无此用户 → 走完 12 步后 `users` +1、`mcp_grants` +1 ≥ 3 条
- **90 天绝对期限**（设计 §9.9 A1–A8）≥ 8 条：跨 4 个 30 天窗口不续命
- **刷新后旧 Access Token 仍有效 / `sid` 不变** ≥ 6 条
- scope：请求多于授予 → 拒；token 的 `scope` 与 grant 一致 ≥ 8 条
- **最小权限**：仅 `records:read` 调 `list_beans` → 403 + `scope="coffee:read"`；
  `tools/list` 返回按 grant 过滤的子集（**不是** 403）≥ 6 条
- **Step-up**：403 → 重新 authorize → 新 token → 重试成功 ≥ 6 条
- **`aud` 隔离**（双向）：Desktop 登录 token 打 `/mcp` → 401；MCP token 打
  `/auth/me` → 401 ≥ 6 条
- 刷新：轮换 / 重放撤族 / 宽限窗口 / **绝对上限（90 天，锚 `created_at`）** ≥ 10 条
- 三方隔离矩阵（设计 §9.6）：MCP 登出不踢 Desktop、Desktop 登出不撤 MCP ≥ 14 条
- Discovery：PRM（root + path）/ AS 元数据 / `iss` / `issuer` 逐字符一致 ≥ 10 条
- CIMD SSRF：私网 / 回环 / 重定向 / 超大 / 超时 / 非 JSON ≥ 10 条
- `/mcp`：无 token → 401 + `WWW-Authenticate`；错 `aud` → 401；撤销 grant → 403 ≥ 10 条
- **协议面错误码**：头体版本不一致 → `400` + `-32020`；不支持版本 → `400` + `-32022`；
  未知方法 → `404` + `-32601`；`GET`/`DELETE` → `405` ≥ 16 条
- **双时代**：modern `server/discover` 与 legacy `initialize` 各一遍 ≥ 8 条
- **`/mcp` 重放语义（P0-2 回归门禁，ST-25 / ST-26）**：同一 access token 连续 10 次
  `tools/call` 全部成功；并发 2 次同 `jti`、来源指纹不同 → 两次都成功、只告警不返回 4xx
  （安全 §3.2.1、生命周期 §15.2）≥ 4 条。**任何「按 `jti` 去重」的实现都会让本组测试变红**
- **Grant 上下文（P0-1，Cloud 侧）**：`revoke` 后必发 `grant_update` 且 `epoch` 严格递增
  （重发同 `epoch` 视为幂等、不得降级）；`install` 未 ack 前不向该 `grant_ctx` 路由；
  同一设备两个 grant 的 `req` 各自携带自己的 `grant_ctx`，路由互不串 ≥ 10 条
- **审计可关联**：Cloud 日志能由 `jti` 前 8 位 + `grant_id` 还原一次调用的 grant 与客户端，
  但不含 token 原文、工具参数、结果 ≥ 3 条
- 工具一致性：Cloud 的 8 个 schema 与 Desktop 深度相等（fixture 对比）
- 日志：用含哨兵字符串的参数跑一次，grep 日志与 DB，0 命中
- **回归**：Cloud 557 条全绿（只增不减）+ Desktop 1265 条全绿；现有 9 条身份路由响应不变；
  `auth_sessions` 的 `information_schema` 逐列相同；`grep` 证明没有任何
  `UPDATE mcp_sessions SET absolute_expires_at`

### 3.4 验收标准

1. **双时代连通**：用现代请求完成 `server/discover` → `tools/list`（8 个）→
   `tools/call search_records`；用 legacy 请求完成 `initialize` → 同上。
2. 撤销 grant 后同一 token 立即 403（不是等 15 分钟）。
3. 授权页正确列出 4 个 scope 与对应数据范围的可读描述，**且允许逐项取消**
   （只有 `records:read` 也能完成授权；随后调 `list_beans` 得到 403 而非空结果）。
3b. **一个从未访问过 BrewPhase 的新用户**能走完全程：授权入口 → 登录页 →
   Google/GitHub → 回到 `/mcp/oauth/consent` → 看到 4 项权限与回调域名 → 批准 →
   `redirect_uri?code=…&state=…&iss=…`。全程无「请先在网页端登录」这类前置。
4. 现有 Desktop 登录流程**完全不受影响**：`/oauth/authorize` 传非 127.0.0.1
   的 `redirect_uri` 仍返回 400；登录 token 仍只能用于 `/auth/*`；
   `auth_sessions` 的 `information_schema` 逐列不变。
5. **同 token 多次调用不被误杀（P0-2）**：一个 15 分钟 TTL 的 access token 在其生命周期内
   连续完成 10 次 `tools/call` 全部成功（ST-25）；日志里只有 `jti` 前 8 位，无完整 token、
   无工具参数、无结果。**「按 `jti` 去重」的实现直接判不通过**。
5b. **会话寿命**：连续刷新 5 次后 `sid` 不变、旧 Access Token 仍可用；
   注入时钟跨过 90 天后刷新返回 `invalid_grant`（会话不可续命）。
6. **撤销的授权闭环（P0-1，Cloud 侧）**：撤销 grant 后 Cloud 在该 WSS 上发
   `grant_update`（`epoch+1`）→ Desktop 回 `grant_update_ack` → 之后同 token 的新调用 403；
   若 ack 超时，按 fail-closed 处理：Cloud **暂停向该设备路由全部 grant**（不只被撤销的
   那一个），直到重新握手（协议 §6.5.2 规则 3）。
   **注意**：`/mcp` 的 403 不依赖 ack——准入在 Cloud 内完成，撤销对 HTTP 侧是立即的。

**真实客户端验收门禁（1.3.3 独有，缺一不可通过）**：

| # | 门禁 | 通过判据 | 失败后果 |
|---|---|---|---|
| G1 | OAuth 授权完成 | ChatGPT 能走完 authorize → consent → token，拿到可用于 `/mcp` 的 token | 阶段不通过 |
| G2 | **legacy 时代**：`initialize` + `tools/list` | 列出 8 个工具且描述可读（若客户端用 legacy） | 阶段不通过 |
| G2' | **modern 时代**：`server/discover` + `tools/list` | `supportedVersions` 含客户端所选版本，列出 8 个工具 | 阶段不通过 |
| G3 | 一次真实 `tools/call` | 返回真实数据（与桌面端一致） | 阶段不通过 |
| G4 | 撤销后立即失效 | Web 撤销 grant 后：(a) ChatGPT 下一次调用收到 403（Cloud 侧立即，不等 token 过期）；(b) 撤销瞬间已在途的调用，Desktop 回 `GRANT_REVOKED` 且**不回传数据**（P0-1 闭环） | 阶段不通过 |
| G5 | 离线语义 | 关闭桌面端后，ChatGPT 收到 `DEVICE_OFFLINE` 而不是超时/空结果 | 阶段不通过 |
| G6 | 注册方式与 `resource` 参数 | **记录实测**：客户端用预注册 / CIMD / DCR 中的哪一种；是否发送 `resource` | 不阻塞通过，但必须记录 |

> **G2 与 G2' 至少一条通过；两条都通过更好**（说明 dual-era 生效）。
> G6 里的「是否发送 `resource`」是**最高危未知项**：若客户端不发，
> 严格校验会导致连不上，届时的取舍见设计 §14 的 N5。

**不得把 Mock 结果当成 G1–G5 的证据。** 若无法进行真实联调，本阶段只能标记为
`NOT VERIFIED`，并按 1.0.1 的 OQ-B/OQ-C 保留开放状态。

### 3.6 1.3.1-A 已交付（数据层）

| 项 | 落点 |
|---|---|
| 迁移 | `cloud/src/db/migrations/0003_mcp_oauth.sql`（`_journal` idx 3 + `0003_snapshot.json`） |
| Schema | `cloud/src/db/schema.ts`：`mcpOauthClients` / `mcpAuthRequests` / `mcpAuthCodes` / `mcpSessions` / `mcpRefreshTokens` |
| 约束测试 | `cloud/tests/mcp-oauth/{schema,refresh-tokens,relations,compat}.test.ts`（**42 条**） |
| 关键约束 | `UNIQUE(session_id) WHERE consumed_at IS NULL`（部分唯一索引）；6 条 CASCADE 外键；`client_id` 零外键 |
| 兼容性 | 既有 8 张表的列 / 约束 / 索引与「只应用 0000–0002」逐字相同 |

**同阶段修正文档**：浏览器 Cookie 的 `Path` 从 `/mcp` 收窄到 `/mcp/oauth`，
consent 页随之从 `/mcp/consent` 挪到 `/mcp/oauth/consent`（理由见设计 §5.3.1）——
否则 `bp_mcp_bs` 会被发送到真正的数据端点 `POST /mcp`。

**1.3.1-B 的入口条件**：`mcp_refresh_tokens` 的部分唯一索引必须先在库里（本阶段
已建并有 3 条回归测试盯着），否则轮换服务的「当前这代」判据在并发下不成立。

### 3.7 1.3.1-B 已交付（Refresh Token 与 Session 生命周期）

| 项 | 落点 |
|---|---|
| 服务 | `cloud/src/mcp-oauth/sessions.ts`：`createMcpSession` / `rotateMcpRefreshToken` / `getMcpSessionState` / `revokeMcpSession` / `revokeMcpSessionsByGrant` |
| 审计 | `db/audit.ts` 新增 5 个 `mcp_*` 事件类型（`event_type` 是 text 且无 CHECK，**不加列、不迁移**） |
| 测试 | `tests/mcp-oauth/{refresh-token-service,absolute-expiry,session-lifecycle}.test.ts` = **44 条** + 夹具 `tests/helpers/mcp-oauth.ts` |
| 常量 | `MCP_SESSION_ABSOLUTE_TTL_MS = 90d`、`MCP_REFRESH_TOKEN_TTL_MS = 30d`、`MCP_REFRESH_REUSE_GRACE_MS = 30s` |
| 哈希域 | `pepperedSha256Hex(pepper, "mcp-refresh", raw)`，与 Desktop 的 `"refresh-token"` 域**物理隔离** |
| 迁移 | **无**（本阶段不新增迁移） |

**三个必须记住的实现细节**：

1. **锁顺序恒为「先 refresh 行、后 session 行」**。反过来会让两个并发刷新各自
   持有 session 锁再互等对方的 refresh 锁——死锁。宽限判定分支同样遵守这个顺序。
2. **`absolute_expires_at` 与 `created_at` 没有任何 UPDATE 路径**：A8 用
   「剥注释后的源码扫描 + 运行期全列快照比对（除 `last_used_at`）」双重证明，
   而不是靠注释声称。
3. **撤销必须先提交、再抛错**：事务内返回结论（`grace` / `reuse` / `rejected`），
   提交后写审计并抛 `invalid_grant`。在事务内直接抛异常会把撤销一起回滚。

**宽限期不是幂等恢复**：宽限内重放同样只得到 `invalid_grant`，客户端拿不到
上一代新 token（v1 明确不做恢复，理由见设计 §9.10.1）。

**同阶段修正**：设计 §9.9 的 A1/A3 两处数字与 30 天 token TTL 不自洽
（A1 少了初始那一代；A3 的 +31d 必然先撞 token 过期），已在设计文档中修正，
语义不变。

### 3.8 1.3.1-C1 已交付（Access Token / 浏览器 Cookie / Grant 竞态收口）

| 项 | 落点 |
|---|---|
| 常量 | `cloud/src/mcp-oauth/constants.ts`：`MCP_SCOPES`、`parseScopeClaim` / `formatScopeClaim`、`mcpResourceFor(baseUrl)`、Cookie 名与属性 |
| Access Token | `cloud/src/mcp-oauth/tokens.ts`：`signMcpAccessToken` / `verifyMcpAccessToken` / `McpTokenError` |
| 浏览器 Cookie | `cloud/src/mcp-oauth/browser-session.ts`：`createBrowserSession` / `setBrowserSessionCookie` / `readBrowserSessionCookie` / `clearBrowserSessionCookie` / `assertBrowserSessionKey` / `browserBindingHash` |
| env | `MCP_BROWSER_SESSION_KEY`（**可选**，≥32 字节；见下「为什么不在启动时强制」）+ `.env.example` |
| 竞态修复 | `createMcpSession` 读 Grant 时加 `.for("update")` |
| 测试 | `tests/mcp-oauth/{grant-race,tokens,browser-session}.test.ts` = **54 条** |
| 迁移 | **无** |
| 路由 | **无**（本阶段不挂载任何 HTTP 端点） |

**JWT claims**：`sub` / `sid` / `iss` / `aud`(= `MCP_RESOURCE`) / `iat` / `exp` / `jti` / `scope`。
**没有** `client_id`——客户端身份由 `sid → grant_id` 反查，放进 JWT 只是又一处可能与 Grant 不一致的副本。

**双向 audience 隔离**是这一层唯一的安全边界：两套 token 共用 `JwtKeyRing`，
靠 `aud` + `iss` 的强制校验分开。测试用「同 sub 同 sid 的两份 token」做同位对照，
排除「因为 claims 不同才失败」的可能。

**Cookie 的 Path 是 `/mcp/oauth`**（不是 `/mcp`）：Cookie 的 Path 是前缀匹配，
写 `/mcp` 会把授权 Cookie 送到真正的数据端点。代价是 consent 页必须在
`/mcp/oauth/consent`——两者是同一个决定的两面。

**为什么 `MCP_BROWSER_SESSION_KEY` 不在启动时强制**：Cloud 现在同时服务
Desktop 登录。把它设成必填会让「只跑 `/oauth/*` 的部署」因为一个尚未启用的
能力而起不来——那是把新功能的门禁变成旧功能的故障。正确纪律是 **C2 挂载
`/mcp/oauth/*` 时，缺密钥就不注册那些路由**（fail-closed 在能力边界上）。

**Grant 竞态**：不加锁时存在「撤销完成之后又长出一条有效 Session」的窗口
（撤销事务已经跑完，扫不到未来才插入的行）。加锁后只剩两种合法结果，由
PostgreSQL 行锁串行化保证；测试用 `pg_blocking_pids()` 把「确实在等锁」
变成可观测事实，不靠 sleep 猜时序。

**锁顺序约定：grant 行永远在 session 行之前。** 撤销路径与创建路径一致，
20 轮并发无 `40P01`。

### 3.9 1.3.1-C2a 已交付（authorize / login / provider callback）

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts`：`GET /mcp/oauth/authorize`、`/login`、`/callback/:provider` |
| 业务层 | `cloud/src/mcp-oauth/authorize-flow.ts`：参数校验、建行、TOFU 绑定、Provider 占用、State 原子消费、写 user_id |
| 登录页 | `cloud/src/mcp-oauth/login-page.ts`：纯静态 HTML、无脚本、无外部资源、全量转义 |
| 启用边界 | `cloud/src/mcp-oauth/enablement.ts` + `app.ts`：密钥不合格就不注册路由组 |
| 测试 | `tests/mcp-oauth/{authorize-route,login-route,callback-route,route-enablement,authorize-flow}.test.ts` = **98 条** |
| 迁移 | **无** |

**启用边界为什么是「能力」而不是「进程」**：`MCP_BROWSER_SESSION_KEY` 缺失
或不合格时，`/mcp/oauth/*` 三个路由**根本不注册**（404），而 `/oauth/*`、
`/auth/*`、`/mcp-devices/*` 照常工作。把密钥设成进程必填会让「只跑 Desktop
登录的部署」因为一个未启用的能力起不来——那是把新功能的门禁变成旧功能的故障。

三条拒绝理由（都只进日志、不含密钥片段）：
`missing_browser_session_key` / `browser_session_key_too_short` /
`browser_session_key_reused_from_jwt`。

**三条一次性语义**（都有对应并发测试）：

| 动作 | 判据 |
|---|---|
| TOFU 绑定 | 条件 UPDATE `WHERE browser_binding_hash IS NULL`；两个浏览器只有一个命中 |
| 占用 Provider 流程 | 条件 UPDATE 带 `provider IS NULL OR provider = $same`；换 provider → 409 语义的 400 |
| 消费 Provider State | 读一次区分五种原因 → **条件 UPDATE `WHERE provider_consumed_at IS NULL`** 才是判据 |

**Provider State 与 Nonce 只落哈希**。Nonce 的哈希**不加域前缀**——Google
适配器验证 ID Token 时算的是 `sha256(idToken.nonce)`，加前缀会让所有 Google
登录失败。Mock 适配器会校验这一点（不是「假装成功」）。

**同一 rid 只能属于一个 Provider**：`provider_conflict` 时不静默切换。

**用户拒绝 vs 交换失败**：前者 302 回客户端带 `error=access_denied`（并删行、
清 Cookie），后者 500 `server_error`（也删行）。**不把交换失败伪装成用户拒绝**
——那会让客户端以为用户放弃，而实际是服务端坏了。

**Cookie 不跨界**：把 `bp_mcp_bs` 发给 `/auth/me` 仍是 401、发给 `/oauth/token`
仍是 400（有测试）。

**未做（C2b）**：`GET/POST /mcp/oauth/consent`、grant upsert、授权码签发。
`csrf_hash` 目前是**一次性丢弃明文的随机占位**：满足 NOT NULL 且**永远不可能
匹配任何提交**（fail-closed）。C2b 渲染同意页时必须重新生成并覆盖。

**sweep 扩展**：过期或已消费超过 1 小时的 `mcp_auth_requests` 由 `startSweep`
清理，避免「点了授权又放弃」把表撑大。

### 3.10 1.3.1-C2b 已交付（Consent / Grant / 授权码）

C2 的后半。授权流程现在能一路走到「客户端拿到 `code`」，Cloud 侧不再有
404 的断点；token 兑换仍属 C3。

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts` 追加 `GET/POST /mcp/oauth/consent` |
| 业务层 | `cloud/src/mcp-oauth/consent-flow.ts`：前置校验、CSRF 轮换、deny 原子删除、allow 事务 |
| 页面 | `cloud/src/mcp-oauth/consent-page.ts`：纯静态 HTML、无脚本、全量转义 |
| 在线同步 | `cloud/src/mcp-oauth/grant-sync.ts`：按 `inspectForwarder()` 决定 install / replace / skip |
| 审计 | `mcp_consent_allowed` / `mcp_consent_denied` / `mcp_consent_csrf_mismatch` / `mcp_auth_code_issued` / `mcp_grant_sync_failed`（无迁移） |
| 测试 | 新增 7 个文件 **104 条**；C2a 回归 **+13 条**（login 24→29 / callback 23→28 / authorize-flow 13→16） |
| 迁移 | **无** |

**C2a 的四处回归**（本阶段一起修）：

| 问题 | 修法 |
|---|---|
| 服务端拉 `authorize` 后，真实浏览器首次进 `/login` 没有 Cookie → 被锁死 | 仅当 `browser_binding_hash IS NULL` 时新建会话并 TOFU；已绑定的行仍 fail-closed；callback 永不匿名建会话 |
| 所有 Provider `error` 都映射成 `access_denied` | 只把 `access_denied` 原样回传；其余（含 `server_error`）一律 `server_error` |
| Provider 交换失败返回 Cloud 500 页面 | 用已验证的 `redirect_uri` 302 回客户端，带 `error=server_error` + 原 `state` + `iss` |
| 旧 State 的拒绝回调可能删掉同一 rid 上新发起的授权 | `DELETE` 条件补 `provider_state_hash` / `provider` / `browser_binding_hash` / `consumed_at IS NULL` / `expires_at > now` |

**同意页的十道门**：rid 格式、行存在、未过期、Provider 已消费、`user_id`
非空、provider 合法、Cookie 有效、绑定一致、未被别的流程消费、请求 scope
非空。绑定不匹配与过期都会**删行**（前者还写审计）；其余只给 400 页面。

**CSRF**：每次渲染重新生成 32 字节明文并覆盖 `csrf_hash`，明文只进 HTML
隐藏字段；POST 用 `constantTimeEqual` 比对。不匹配 → 删行 + 审计 + 400。
表单只收 urlencoded，`rid`/`csrf`/`decision` 重复即 400。

**Step-up**：已有 active grant 的 scope ⊆ 本次请求且新增了 scope 时，
已有项在页面上勾选且 `disabled`（不提交），服务端按**并集**补回；因此
`final ⊆ requested` 是结构事实。非 Step-up 按勾选覆盖，支持收窄。
`no_scope_granted`（允许但一个都没勾）按拒绝处理。

**Grant upsert**：`INSERT … ON CONFLICT (user_id, client_id, resource) DO UPDATE`。
新建 epoch=1；scope 未变不涨；scope 变了 +1；已撤销后再次授权 +1 并清
`revoked_at`。**不做「先 SELECT 再 INSERT」**——不存在的行没有可锁对象。

**授权码**：32 字节明文只在 302 的 `Location` 出现一次；库内
`sha256("mcp-code:"‖code)`；TTL 60 秒；scope/resource/redirect_uri/
code_challenge 继承授权请求。grant upsert、code 插入、删授权请求**同一事务**，
删行命中数 ≠ 1 就整体回滚。

**在线 Grant 同步**：

| 情形 | 动作 |
|---|---|
| 新 grant / 撤销后重新激活，且设备在线 | `installGrant()` |
| scope 变了、旧 ctx 已安装 | `replaceGrant()` |
| scope 未变且已安装 | 不发帧 |
| 无在线设备 | 不同步，等下次 `hello_ok` 快照 |

ack 超时 / `applied=false` / 离线都**不回滚数据库**：授权与设备在线状态是
两个生命周期。转发层会 fail-closed（该连接或该 grant 不可路由），设备重新
握手时 `hello_ok` 按数据库重建快照——这条路径不依赖那次在线同步成功。

**实测与门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**912 passed / 56 files**（C2a 基线 795 / 49，**+117**）；Desktop
`typecheck` / `test` / `build` / `mcp:build` 通过，**1265 passed / 89 files**，
`stdio.mjs` 911.67 kB 不变；**无新增迁移**；无 `skip` / `todo`。

**变异验证 13/13 全部被抓**。其中 `M13`（ack 失败仍把 ctx 当作已安装）
第一版**存活**：`syncLag` 也会让派发失败，于是「只看派发结果」看不出差别。
修法是直接断言转发层的事实——`inspectForwarder().connections[].grants[].installed`
必须是 `false`。

**未做（C3 / 1.3.2 / 1.3.3）**：`/mcp/oauth/token`、`/revoke`、PRM、AS
metadata、CIMD、DCR、`POST /mcp`、工具面、真实客户端联调。授权码兑换时创建
Session 也属 C3（`mcp_sessions` 在 C2b 里**一行都不写**）。

### 3.11 1.3.1-C2b-R1 已交付（绑定失败的条件删除）

C2b 的安全加固，不是新功能。修的是同一类问题：**按 `rid` 直接删**在两个
「绑定不匹配」分支里会删掉用户刚重新发起的授权（同一 `rid` 换了一把新的
`provider_state_hash`）。

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `/callback/:provider` 的 `binding_mismatch` | `deleteAuthRequest(rid)` | `deleteMismatchedProviderRequest(...)` |
| `handleProviderDenied` 的失配分支 | `deleteAuthRequest(row.id)` | 同上 |

**条件（值全部来自刚才那次 SELECT）**：

```
id = :rid
provider_state_hash = :state_hash      ← 本次读到的那把
provider = :provider
browser_binding_hash = :stored_binding ← 行内读到的（不是请求携带的）
provider_consumed_at IS NULL
expires_at > :now
RETURNING id
```

命中 0 行 = 状态已变（重新发起 / 换 Provider / 已消费 / 已过期 / 换绑定）：
**不删、不审计、不重定向**，对外仍 400。只有命中 1 行才写
`mcp_browser_binding_mismatch`。

**`ConsumeOutcome` 的变化**：`binding_mismatch` 从「只有 `rid`」改成携带
`provider` / `stateHash` / `storedBindingHash` 的独立分支，让路由层有能力做
条件删除；其余失败原因收窄为不带清理信息的分支。

**测试（+11 条，Cloud 912 → 923）**：

| 用例 | 判据 |
|---|---|
| 正常回调：旧 State 的失配回调不能删除新授权 | 行仍在、state 是 S2、无审计、`exchangeCount=0` |
| 拒绝：旧 State 的失配拒绝回调不能删除新授权 | 行仍在、无 `mcp_provider_denied` |
| 正常拒绝：旧 State 的拒绝回调也不能删除新授权 | 同上（保护 `deleteDeniedProviderRequest` 的 state 判据） |
| 拒绝路径状态未变时仍清理并审计 | 行被删 + 审计 1 条 |
| `deleteMismatchedProviderRequest` 六条判据 | 命中 1 次 + 每个条件各破坏一次均命中 0 行 |

交错全部用**行锁 + `pg_stat_activity` 的 Lock 等待**构造：外部事务持行锁，
回调的 DELETE 停在锁上，确认「确实有后端在等锁」后才更新 State 并提交。
没有 sleep，也没有重试碰运气。

**变异（5/5 被抓）**：失配清理去掉 state 判据（路由 / 业务层）、正常拒绝去掉
state 判据、两处把预期绑定换成请求绑定——各自都有具体用例转红。

**门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**923 passed / 56 files**；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变；**无新增迁移**、
**无新增路由**、**未改 Desktop 生产代码**。

**C2b 整体状态**：授权流程到「302 带 code」为止完整可用；`/mcp/oauth/token`
兑换与之后的一切仍属 C3（未实现）。

### 3.12 1.3.1-C3a 已交付（Token Endpoint：授权码兑换与 Refresh 轮换）

授权链路现在闭环到「客户端拿到可用的 Access Token」。C2b 签出的 60 秒授权码
终于可兑换；`mcp_sessions` / `mcp_refresh_tokens` 从本阶段开始**真正被写入**。

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts`：`POST /mcp/oauth/token` + 独立限流桶 `mcp-token` |
| 业务层 | `cloud/src/mcp-oauth/token-flow.ts`：`exchangeAuthorizationCode` / `exchangeRefreshToken` |
| Session 服务 | `sessions.ts` 拆出 `createMcpSessionInTransaction(tx, …)`；`createMcpSession()` 变成「事务包装 + 审计」 |
| 授权码哈希 | `mcpAuthCodeHash` 从 `consent-flow.ts` 移到 `authorize-flow.ts`（签发与兑换共用一份） |
| 错误码 | `errors.ts` 新增 `invalid_client`(401) / `invalid_scope`(400) / `unsupported_grant_type`(400) |
| 测试 | 5 个新文件 **70 条**（token-code 19 / token-refresh 20 / token-atomicity 6 / token-route 18 / token-invariants 7） |
| 迁移 | **无** |

#### 事务边界（这是本阶段的核心）

```
BEGIN
  ① SELECT mcp_auth_codes … FOR UPDATE
  ② 校验：未消费 / 未过期 / client_id / redirect_uri / resource / PKCE S256
  ③ 条件 UPDATE 消费（consumed_at IS NULL + expires_at > now）→ RETURNING
  ④ createMcpSessionInTransaction(tx, …)   ← 同一个 tx
  ⑤ COMMIT
→ 事务外：签 JWT、写审计、在线 Grant 同步
```

不允许「先消费授权码、再调 `createMcpSession()`」：那会出现「码被烧掉、Session
没建起来」的窗口，用户只能重新走浏览器授权。`createMcpSessionInTransaction()` 内部
对 Grant 取 `FOR UPDATE`，锁序 **grant → session**，与撤销路径一致。

并发兑换同一个 code：只有一个命中条件 UPDATE，另一个拿 `invalid_grant`，
因此不会出现第二条 Session 或第二条初代 Refresh Token（有 3 条用例钉住）。

#### Refresh 的客户端绑定（本阶段补的安全缺口）

`rotateMcpRefreshToken()` 新增三个**可选**入参 `clientId` / `resource` /
`requestedScope`，全部在**改动任何状态之前**判定：

| 入参 | 判据 | 失败 |
|---|---|---|
| `clientId` | = `mcp_sessions.client_id` | `invalid_client` 401 |
| `resource` | = `mcp_sessions.resource` | `invalid_grant` |
| `requestedScope` | ⊆ `issued_scope ∩ grant.scopes`（逐项严格校验） | `invalid_scope` 400 |

**顺序是安全要求**：绑定校验必须排在「宽限外重放 → 撤销整个 Session」之前。
否则一个拿着别人 Refresh Token、`client_id` 写错的请求就能触发破坏性撤销 ——
错误客户端反而拿到了一个原语。锁序仍是 **refresh 行 → session 行**。

`effectiveScope` 也是先算后写：交集为空时 `no_scope` 拒绝且**不消费旧代**
（消费了客户端就彻底没凭据了）。

#### Access Token

复用 `signMcpAccessToken()`：`iss = baseUrl`、`aud = mcpResourceFor(baseUrl)`、
`sub = session.userId`、`sid = mcp_sessions.id`、`jti` 随机、`scope = 本次实际签发`。
`expires_in` 取 `ctx.env.accessTokenTtlSeconds`，不硬编码。与 Desktop Access
Token 靠 `aud` + `iss` 双向隔离。

#### 请求面与错误

只接受 `application/x-www-form-urlencoded`（≤ 8 KiB，单字段 ≤ 512）；
**任何字段重复即 `invalid_request`** —— `Object.fromEntries` 的「后者覆盖前者」
会让「校验值」与「使用值」不是同一个。`/mcp/oauth/token` 完全不读 `bp_mcp_bs`。

| 错误 | 状态 |
|---|---:|
| `invalid_request` | 400 |
| `invalid_client` | 401 |
| `invalid_grant` | 400 |
| `invalid_scope` | 400 |
| `unsupported_grant_type` | 400 |
| `server_error` | 500（固定文案） |

非 `AppError` 的异常在路由层换成 `serverError("token issuance failed")`：drizzle 的
message 带整条 SQL 与全部参数（code_hash、refresh hash 都在里面），原样透出即凭据泄露。

#### 审计非阻断

Session 与 Refresh 的审计在提交之后写，失败只记 `mcp_audit_failed`，
**不回滚已经签发的凭据**。否则会出现「token 已在库里、客户端却拿到 500」。

#### 门禁（实际执行）

| 项 | 结果 |
|---|---|
| Cloud `typecheck` / `lint` / `build` | 通过 |
| Cloud `pnpm test` | **993 passed / 61 files**（C2b-R1 基线 923 / 56，**+70 / +5**） |
| Desktop `typecheck` / `test` / `build` / `mcp:build` | 通过；**1265 passed / 89 files**；`stdio.mjs` 911.67 kB 不变 |
| 新增迁移 / 新增路由 | **无 / 1 条**（`POST /mcp/oauth/token`） |
| 既有 Session / Refresh 测试 | 44 条全绿（未放宽任何旧断言） |

#### 变异（8/8 被抓）

去掉消费的 `consumed_at IS NULL`、去掉授权码并发保护（`FOR UPDATE`）、去掉
PKCE 校验、把 Session 创建移出授权码事务、初代 Refresh 改明文存储、去掉
Refresh 客户端绑定校验、去掉重放保护、把 `effectiveScope` 换成 Grant 全量 scope。

**M6 第一版存活**：变异脚本的锚点先命中了另一处同形代码（`bindingRejection`
在正常分支与 consumed 分支各出现一次），等于只删了一半。修正锚点后转红
（`token-route` 2 条失败）。

#### 未做（C3b / 1.3.2 / 1.3.3）

`POST /mcp/oauth/revoke`、PRM、AS Metadata、CIMD、DCR、`POST /mcp`、8 个只读工具、
Streamable HTTP、真实客户端联调。**C3a 到此为止，未进入 C3b。**

### 3.13 1.3.1-C3a-R1 已交付（Token 请求体与媒体类型硬化）

C3a 的请求面收口，不动业务判据。三处边界问题都在**授权码兑换之前**，所以
兑换、轮换、错误映射与 Desktop OAuth 全部零改动。

| # | 原实现 | 问题 | 修法 |
|---|---|---|---|
| 1 | `body.length > 8192` | `.length` 是 UTF-16 码元数：3000 汉字 = 3000 长度 / 9000 字节，配额被放大三倍 | 累计 `Uint8Array.byteLength` |
| 2 | 先 `c.req.text()` 再判大小 | 上限事后生效，任意大的请求先读进内存 | 边读边累计，超限 `cancel()` reader |
| 3 | `contentType.startsWith(…)` | `…-evil` 后缀只因前缀相同被当成表单 | 按 RFC 9110 结构解析 type/subtype/参数 |

**读取顺序**：`Content-Length` 合法性与早退 → 流式累计（>8192 立即 cancel）
→ 合并字节 → `TextDecoder("utf-8", { fatal: true })` → `URLSearchParams`。

- `Content-Length` 只作早退优化：缺失走流累计，撒谎（声称 10 实际 9000）仍被累计值拒掉；
  存在但非法（空值 / 负数 / `1.5` / `1e3` / `0x10`）直接 400。
  **判据是 `/^\d+$/`**——`Number("")` 是 0，用 `Number.isInteger()` 会把空头当零字节放行。
- Content-Type：只接受 `application/x-www-form-urlencoded`（大小写不敏感）+
  可选 `charset=utf-8`（大小写、空格、引号不敏感）；`-evil`、未知参数、空参数、
  缺 `=`、`charset=iso-8859-1`、JSON、multipart 一律 400。
- 非法 UTF-8 **fail-closed**（不替换 U+FFFD）：宽松解码会把垃圾字节变成一串
  看起来正常但已被改过的参数值。
- 顺序固定「先截断再解码」，避免两条拒绝理由互相掩盖。

**新增测试 16 条（`token-route` 18 → 34，Cloud 993 → 1009 / 61 files）**：

| 组 | 条数 | 覆盖 |
|---|---:|---|
| 请求体字节上限 | 9 | 小于上限可兑换、多字节超限、无 Content-Length 累计、CL 提前拒绝、CL 撒谎、CL 非法值、8192 恰好通过、8193 拒绝、1 MiB 流只读 ≈9 KiB |
| Content-Type 严格解析 | 4 | charset 各种写法接受、非法后缀/未知参数/未知 charset 拒绝、缺头拒绝、重复字段仍拒绝 |
| UTF-8 严格解码 | 3 | 非法字节、截断的多字节序列、合法中文不误拒 |

全部用例都断言数据库状态（`mcp_auth_codes.consumed_at` / `mcp_sessions` /
`mcp_refresh_tokens`），不只看 HTTP 状态码。

**变异 7/7 被抓**：

| 变异 | 抓住它的用例 |
|---|---|
| 用 `.length` 代替字节（读完后判） | 多字节超限（2 条转红） |
| 读完整 body 再判大小 | 1 MiB 流式计数（上界失败） |
| `startsWith` 前缀匹配 | `-evil` 后缀（2 条转红） |
| 不校验 Content-Length 合法性 | 合法表单 + 非法 CL（返回 200） |
| 非 fatal UTF-8 解码 | 非法字节（返回 200 并消费授权码） |
| 只信 Content-Length、不做流累计 | CL 撒谎 / 无 CL 超限（5 条转红） |
| 接受任意 charset 与未知参数 | `charset=iso-8859-1`（返回 200） |

> **三条变异第一版存活**，暴露的都是**测试自身**的问题，不是实现：
> ①媒体类型用例传了对象而不是字符串正文，400 来自「grant_type is required」；
> ②非法 UTF-8 用例只发了半截表单，宽松解码后仍死在「缺 client_id」而错误码相同；
> ③Content-Length 非法值用例同样缺字段。把用例改成「完整合法表单 + 只破坏一个维度」
> 之后 7/7 转红。

**门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**1009 passed / 61 files**；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、无新增路由、未改 Desktop 生产代码。**

**C3a 状态**：已完成，并经 R1 完成请求边界修订。C3b（revoke / discovery /
CIMD / DCR）仍未开始。

### 3.14 1.3.1-C3a-R2 已交付（字段限长与 Content-Type 参数唯一性）

R1 收口了「请求体总量」和「媒体类型」，但单字段 512 字符的限制只落在
`requireField()` 上：`scope` 通过 `form.get()` 读取、未知扩展字段直接进 Map，
两条路径都没有长度检查。另外一个头里可以写两次 `charset`。

| 问题 | 修法 |
|---|---|
| `scope` 600 字符能走到 `parseScopeParam` | 在 `parseTokenForm()` 建 Map 的循环里统一判定 `value.length > 512` |
| 未知扩展字段无上限（只受 body 8 KiB 约束） | 同上，一视同仁 |
| `charset=utf-8; charset=UTF-8` 被接受 | `isFormContentType()` 记录 `seen` 参数名，重复即拒（大小写不敏感、值相同也拒） |

要点：

- **保留 `requireField()` 的检查**作为第二道，防未来别的调用路径绕过 `parseTokenForm()`。
- 未知扩展字段仍然**忽略**，但只忽略语义，不忽略长度。
- 错误文案**不回显字段名**：参数名由请求方控制，拼进描述是日志注入面。
- 上限语义是 **512 个 JavaScript 字符单位**（与既有 `MAX_TOKEN_FIELD_LENGTH` 一致），
  不是字节——字节维度的约束由 8 KiB body 上限承担。

**新增测试 7 条（`token-route` 34 → 41，Cloud 1009 → 1016 / 61 files）**：

| 用例 | 判据 |
|---|---|
| scope 恰好 512 → 200 | 边界是 512 不是 511；授权码被消费、Session 与初代 Refresh 各 1 行 |
| scope 513 → 400 | `invalid_request`；码未消费、Session/Refresh 零行 |
| 未知扩展字段 513 → 400 | 同上 |
| 未知扩展字段 512 → 200 | 仍被忽略，兑换不受影响 |
| 必填字段超长（code 700）→ 400 | 必填路径同样走统一判据 |
| 重复 charset（4 种写法）→ 400 | 值相同 / 仅大小写不同都拒 |
| 单个 charset → 200 | 与重复声明区分开 |

顺带重构了测试里的填充构造器：原 `paddedForm` 用一个 7000 字符的 `pad` 撑
body，现在会先撞字段上限——改成按目标字节数精确拼多个 ≤500 字符的字段，
「8 KiB 边界」那几条用例才继续测的是字节维度。

**变异 3/3 被抓**：删除统一限长（2 条转红）、允许参数重复（1 条）、
边界放宽到 513（2 条，512 与 513 两侧同时失守）。

**门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**1016 passed / 61 files**；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、无新增路由、未改 Desktop 生产代码。**

**C3b 未开始**（`/revoke`、PRM、AS Metadata、CIMD、DCR）。

### 3.15 1.3.1-C3b 已交付（Token Revocation / RFC 7009）

`POST /mcp/oauth/revoke` 落地。撤销粒度是 **Session**，不是 Grant——这是设计
§9.11 第 1 行早已冻结的行为，本阶段只是把它实现出来并钉住。

| 项 | 落点 |
|---|---|
| 路由 | `cloud/src/routes/mcp-oauth.ts`：`POST /mcp/oauth/revoke` + 独立限流桶 `mcp-revoke` |
| 业务层 | `cloud/src/mcp-oauth/revoke-flow.ts`（`revokeToken`） |
| 错误码 | `errors.ts` 新增 `unsupported_token_type`（400） |
| 表单 | **复用** `parseTokenForm()`（8 KiB / 512 字符 / 重复字段 / 严格 Content-Type） |
| 撤销 | **复用** `revokeMcpSession({ reason: "client_revoke" })`，条件更新 `WHERE revoked_at IS NULL` |
| 迁移 | **无** |

**响应语义**：

| 情况 | 结果 |
|---|---|
| 有效未消费、未过期、Session active 的 Refresh Token | 200 空体 |
| 随机值 / 不存在 / 已消费旧代 / 已过期 / Session 已撤销或已过期 | 200 空体（RFC 7009 §2.2：无效 Token 不产生错误） |
| 有效 MCP Access JWT | 400 `unsupported_token_type` |
| 缺 token / 重复字段 / 媒体类型错 / 超限 | 400 `invalid_request` |

**对 RFC 7009 §2.1 的 SHOULD 偏离**：RFC 建议撤销 Refresh Token 时连带撤销该
授权下的 Access Token。本项目以 Session 为凭证家族边界，`/mcp` 按 `sid` 回查
状态——Session 撤销后它签出的所有 JWT 立即失效，SHOULD 的**效果**达成，但
不走「撤销 Grant」这条更粗的路径（一次客户端登出不该清掉用户在别处的授权）。

**`token_type_hint` 只当提示**：不按 Hint 分流，先查 Refresh 哈希、未命中才验
Access JWT。因此 Hint 缺失 / 未知 / 甚至写成 `access_token` 都不影响正确撤销；
反向顺序会给攻击者一个「每个无效 token 都换一次签名验证」的 CPU 消耗点。

**无效 Token 无数据库副作用**：已消费的历史代不会撤销它的 Session（否则捡到
旧 token 就能踢掉合法会话）；Session 已过期不写 `revoked_at`（过期不是事件）；
Session 行与 Refresh Token 历史行一律不删。

**顺带修掉 R2 遗留**：重复字段的错误文案从 `parameter ${key} must appear
exactly once` 改成固定文案 `a parameter appears more than once`——字段名完全
由请求方控制（可含换行），拼进 description 是日志注入面。

**测试（+31，Cloud 1016 → 1047 / 62 files）**：

| 组 | 条数 | 关键项 |
|---|---:|---|
| 协议面 | 10 | 缺/空 token、JSON、multipart、重复字段、8 KiB、512 字符、空体 + no-store、Query 不生效、Cookie 不参与 |
| Session 级撤销（核心） | 3 | 同 Grant 两个 Session 只撤一个；Grant scope/epoch/revoked_at 全不变；Desktop `auth_sessions` 零写入；行不删除；跨 client 不受影响 |
| Token 生命周期 | 7 | 随机 / 已消费旧代 / 已过期 / Session 已过期 / Session 已撤销 / 重复撤销，全部 200 且无副作用 |
| `token_type_hint` | 7 | 四种 hint 都能撤 refresh；有效 JWT → 400 且不撤；过期 JWT → 200；Desktop JWT → 200 |
| 并发与审计 | 3 | 并发撤销都 200、审计仅 1 条；审计无明文；DB 异常 → 500 固定文案、不泄 SQL/表名/token |
| 服务层幂等 | 1 | 直接调 `revokeMcpSession` 两次：第二次 `revoked=false`、审计不重复 |

**变异 7/7 被抓**：删 `revoked_at IS NULL`、扩大成 Grant 批量撤销、不查
`consumed_at`、不查 `expires_at`、无效 Token 返 400、错误响应回显 Token、
重复撤销仍写审计。

**门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**1047 passed / 62 files**；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、未改 Desktop 生产代码。**

**C3c 未开始**（discovery / PRM / AS Metadata / CIMD / DCR）。

### 3.16 1.3.1-C3b-R1 已交付（Query Token 拒绝）

C3b 的一个请求面缺口：原实现只从表单取 `token`，于是
`POST /mcp/oauth/revoke?token=…` + Body 里再放一个合法值**会正常撤销**。

**修法**：路由最前面（`parseTokenForm()` 之前）判 `c.req.queries("token")`，
出现即 `400 invalid_request`——不看 Body 有没有合法值，也不把 Query 值当成
「备用输入」。理由：URL 会留在浏览器历史、代理日志、`Referer`、截图与工单里，
token 出现在那里就已经泄露，这种**请求形态本身**不接受。

`queries()` 对 `?token=`（空值）与 `?token=a&token=b`（重复）都返回非
`undefined`，三种形态一并挡掉；错误文案固定、不回显、不写审计。

**新增测试 11 条（`revoke-route` 30 → 41，Cloud 1047 → 1058 / 62 files）**：

| 用例 | 判据 |
|---|---|
| `?token=abc` / `?token=` / `?token=a&token=b` + 空 Body | 400 |
| `?token=secret` + Body 缺 token | 400（不回退到 Query） |
| `?token=secret` + Body 有效 | 400 + 零副作用 |
| Query 与 Body 相同 / 不同 | 400 + 零副作用 |
| `?token=`（空值）+ Body 有效 | 400 + 零副作用（「空值等于没传」不成立） |
| `?token=a&token=b`（重复）+ Body 有效 | 400 + 零副作用（不做「取第一个」） |
| 哨兵值 `QUERY-TOKEN-SENTINEL-2026` | 响应体、应用日志、审计都不含；连哈希都不出现（说明没算过） |
| 错误响应 | 仍带 `no-store` + `no-cache` |

「零副作用」= Session 仍 active、`consumed_at` 不变、无 `mcp_session_revoked`
审计、`mcp_grants` 前后逐字段相等、Desktop `auth_sessions` 零写入。

**变异 1/1 被抓**：移除 Query 检查后 6 条转红（五条「Body 有合法值」+ 哨兵用例）。

**门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**1058 passed / 62 files**；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、未改 Desktop 生产代码。**

### 3.17 1.3.1-C3b-R2 已交付（撤销的 client_id 绑定）

C3b 的协议缺口：撤销请求不要求 `client_id`，于是「拿着别人的 Refresh Token
来撤销」在协议层是成立的。本阶段把它补上。

| 项 | 落点 |
|---|---|
| 路由 | `POST /mcp/oauth/revoke` 用 `requireField(form, "client_id")` |
| 业务层 | `revoke-flow.ts`：refresh 查询改成 `⨝ mcp_sessions` 带出归属；Access JWT 用验签后的 claim |
| JWT | `signMcpAccessToken` / `verifyMcpAccessToken` 补回设计 §8.1 要求的 `client_id` claim（C1 时省略） |
| 迁移 | **无** |

**归属判定的顺序**（这是本阶段的核心）：

```
hash → 查 refresh 行（JOIN session 取 client_id）→ 比对 client_id
     → consumed_at → expires_at → Session active → revokeMcpSession()
```

比对必须排在**所有状态判定与写操作之前**：排在后面既泄露状态，又给错误客户端
留下破坏性原语。

| 请求 | 结果 |
|---|---|
| 缺 / 空 / 重复 / 超 512 字符的 `client_id` | 400 `invalid_request` |
| Refresh 归属 ≠ `client_id` | 401 `invalid_client`，零副作用 |
| Access JWT 的 `client_id` ≠ 请求值 | 401 `invalid_client` |
| Access JWT 的 `client_id` = 请求值 | 400 `unsupported_token_type` |

比较是**逐字符**的（不 trim、不改大小写）；归属以 `mcp_sessions.client_id` 为准，
**不查** `mcp_oauth_clients`（那是注册/元数据缓存，不回答「这枚凭据是谁的」）。

**JWT claim 的补回**：设计 §8.1 早就列了 `client_id`，C1 实现时以「`/mcp` 靠
`sid` 回查就够」为由省掉。撤销端点需要回答「这枚 token 属于哪个客户端」，
所以按设计补回；`verifyMcpAccessToken()` 现在强制要求该 claim，缺失即无效。
代价是三个手工签 JWT 的测试夹具（以及 claim 全集断言）需要同步——它们此前
一直在断言一个偏离设计的形状。

**测试（+16，`revoke-route` 41 → 57，Cloud 1058 → 1074 / 62 files）**：

| 组 | 条数 | 关键项 |
|---|---:|---|
| `client_id` 必填 | 5 | 缺 / 空 / 重复 / 超长 → 400；合法 → 200 |
| Refresh 归属 | 7 | A 撤自己 200；B 拿 A 的 → 401；大小写不同、带空格、不存在客户端 → 401；已消费旧代 + 错误 client → 401（证明归属早于状态）；同 Grant 两个 Session 互不影响 |
| Access JWT 归属 | 4 | 正确 → 400 unsupported；错误 → 401；签名篡改 → 200；claim 与 Session 归属一致 |

「零副作用」= Session active、`revoked_reason` 不变、Refresh 历史数组不变、
无撤销审计、`mcp_grants` 逐字段不变、Desktop `auth_sessions` 零写入。

**变异 3/3 被抓**：删 Refresh 比较（6 条转红）、删 Access 比较（1 条）、
不匹配时仍调用 `revokeMcpSession()`（6 条转红——这条证明「只断言 401」不够）。

**门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**1074 passed / 62 files**；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、无新增路由、未改 Desktop 生产代码。**

### 3.18 1.3.1-C3b-R2-R1 已交付（Access JWT 的 Session 状态校验）

R2 的漏判：Access 分支只比了 `claims.clientId` 与请求值，于是「Session 已撤销
的 JWT」被答成 `unsupported_token_type`（400）——在撤销端点上凭空给出「这枚
token 仍然活着」的信号。

**判定顺序**：

```
verifyMcpAccessToken()  → 失败则 not_found(200)
读 mcp_sessions（一次查询：clientId / revokedAt / absoluteExpiresAt）
  → 不存在 / 已撤销 / 已过期 → not_found(200)
claims.clientId ≠ session.clientId → not_found(200)
请求 client_id ≠ session.clientId → client_mismatch(401)
→ unsupported_token_type(400)
```

| 情况 | 结果 |
|---|---|
| 签名无效 / 已过期 / 不是 JWT / Desktop token | 200 空 |
| Session 不存在 / 已撤销 / 已过期 | 200 空 |
| JWT 的 `client_id` 与 Session 记录不符 | 200 空 |
| Session active，请求 `client_id` 不符 | 401 `invalid_client` |
| Session active，一切相符 | 400 `unsupported_token_type` |

三个判据不合并：**签名声明是否可信**（密码学）、**Session 是否仍然有效**
（数据库当前状态）、**请求方是否为该客户端**（协议声明）。前三类「无效」对外
必须同一个 200，否则端点变成存在性探针；401 只留给「凭据有效、但你说自己
不是它的主人」。

Access 分支全程只读：不调用 `revokeMcpSession()`，四个表零写入，无撤销审计。

**测试（+7，`revoke-route` 57 → 64，Cloud 1074 → 1081 / 62 files）**：

| 用例 | 判据 |
|---|---|
| Session active + 正确 client | 400 unsupported，Session 不变、无审计 |
| Session active + 错误 client | 401，Session 不变、无审计 |
| Session 已撤销 | 200 空体；`revoked_at` 不被覆盖、审计不新增 |
| Session 已过期 | 200 空体；不写 `revoked_at` |
| Session 不存在（sid 是随机 UUID） | 200 空体；两个 `mcp_sessions` 快照相等 |
| JWT claim 与 Session 归属不符 | 200 空体（**即使请求值 = claim 值**） |
| 三种「无效」不可区分 | 都是同一个 200 空体、无 JSON 错误体 |

零副作用通过 `expectInvalidAccessToken()` 统一断言：`mcp_sessions` 全表快照、
`revoked_reason`、Refresh 历史数组、`mcp_grants`、撤销审计数、`auth_sessions`。

**变异 3/3 被抓**：删 Session 状态检查（3 条转红）、删 claim↔Session 一致性
检查（1 条）、把已撤销映射成 `unsupported_token_type`（2 条）。

**门禁**：Cloud `typecheck` / `lint` / `build` 通过，`pnpm test`
**1081 passed / 62 files**；Desktop `typecheck` / `test` / `build` / `mcp:build`
通过，**1265 passed / 89 files**，`stdio.mjs` 911.67 kB 不变。
**无新增迁移、无新增路由、未改 Desktop 生产代码。**

### 3.5 风险

- **客户端注册方式未验证**（DCR 是否必需、是否支持 CIMD、是否发送 `resource`、
  是否支持 `refresh_token`）——1.3.3 的最大不确定性，必须尽早真实验证。
  设计已把三种注册方式全部留出入口，因此**不赌单一方式**。
- **`resource` 参数的严格性**：规范要求双向 MUST，但客户端可能不发（N5）。
  这是「合规」与「能连上」唯一可能正面冲突的地方。
- SDK 的双时代行为目前由实测锁定（设计 §1.3）；升级 SDK 必须重跑该表。
- HS256 对称密钥意味着 AS 与 `/mcp` 校验方共用同一 secret（同一进程内可接受）；
  若未来拆分服务，需改 RS256 或共享密钥管理——**本阶段不拆**。

---

## Phase 1.4 — 多实例与多设备

| # | 范围 |
|---|---|
| D1 | `ConnectionRegistry` Redis 实现（`mcp:conn:*` + pub/sub 路由），接口不变 |
| D2 | 限流改共享存储（现有 `rate-limit.ts` 的接口不变，换实现） |
| D3 | 多设备：`mcp_devices.is_primary` + 用户选择 + 单用户多连接（OQ-9 定稿后） |
| D4 | 滚动部署：`drain` 路径实测（`4011` → 退避重连） |
| D5 | 指标：在线设备数、转发延迟 P50/P95、错误码分布、`REMOTE_DISABLED` 计数（观测 Cloud 状态同步失败） |
| D6 | 解除单副本限制：移除 `GATEWAY_EXPECTED_REPLICAS` 启动断言 |

**验收**：两台 Gateway 实例 + 一台 Desktop，请求随机打到任一实例都能正确路由；
杀掉持有连接的那台，Desktop 在 5s 内退避重连到另一台，期间请求返回 `DEVICE_OFFLINE`
而不是挂起。**且 `GATEWAY_EXPECTED_REPLICAS=2` 启动断言不再阻止启动。**

**前置**：必须先有 Redis（或 PG `LISTEN/NOTIFY`）。部署形态待确认（OQ-A）。

---

## Phase 1.5 — 可选增强（需产品决策）

| 项 | 收益 | 代价 |
|---|---|---|
| E2E 加密（Desktop 生成会话密钥，Cloud 只转发密文） | Cloud 看不到数据 | Cloud 无法做结果过滤；密钥协商增加一轮；调试困难 |
| 写入工具（`create_record` 等） | 远程可记录 | 需要持久幂等 + 用户确认 UI + 更复杂的威胁模型 |
| `subscriptions/listen`（通知流） | 支持服务端推送（如记录变更） | **注意**：2026-07-28 已移除 `GET /mcp` 的 SSE 流，长连接通知改由 `subscriptions/listen` 承载。多实例下需要事件总线 |
| 断线排队 | 体验连续 | 与「明确失败优于延迟成功」冲突（协议 §10.3） |

**建议**：E2E 加密单独评估；写入工具至少等到 1.4 稳定后再做；断线排队**不做**。

---

## 4. 全阶段共同门禁

每个阶段结束必须跑并通过：

```bash
# Desktop
cd Desktop && pnpm typecheck && pnpm test && pnpm build && pnpm mcp:build
# Cloud
cd cloud   && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

| 门禁 | 基线（Phase 1.0 结束时实测，**1.0.1 / 1.0.2 未重跑**） |
|---|---|
| Desktop 单测 | 949 passed / 72 files |
| Cloud 单测 | 161 passed / 13 files |
| Desktop `typecheck` / `build` | ✅ / ✅ |
| `mcp:build` | ✅ 911.67 kB（`out/mcp/stdio.mjs`） |
| Cloud `typecheck` / `lint` / `build` | ✅ / ✅ / ✅ |

**Cloud 测试前置**：需 `brewphase-cloud-test-pg` 容器在 54329（当前在跑）。
容器不在时 `global-setup` 直接 throw，不是测试失败。

> Phase 1.0.1 / 1.0.2 **只改文档**，因此上表是引用值，不是本次执行结果。
> **任何后续阶段的实际数字必须来自当次运行。**

### 4.1 安全测试矩阵归属 + 发布阻断项汇总（跨阶段）

**测试用例的完整定义（阶段 / 位置 / 预期结果 / 阻断级别）在 `REMOTE_MCP_SECURITY_OPERATIONS.md` §7.1（ST-1~ST-26，共 26 条）。**
本节的职责是**认领**：每个阶段必须实现哪些用例、哪些未通过不得发布。

以下任一项未通过，**不得发布**（即使阶段验收的其他项都过）：

| 阻断项 | 所属阶段 | 依据 |
|---|---|---|
| CB-5 ~ CB-8（审计只记写工具的四条分支） | 1.1A | §1A.4 |
| ST-4（用户切换不继承设备） | 1.1B | 安全 §7.1 |
| ST-5（关开关时到达的 req 不进业务层） | 1.1B | 安全 §7.1 |
| ST-6（`request_hash` 不一致必须拒绝） | 1.1B | 安全 §7.1 |
| ST-7（同 `delivery_id` 只执行一次） | 1.1B | 安全 §7.1 |
| ST-8（不同 `delivery_id` 必须各执行一次） | 1.1B | 安全 §7.1 |
| ST-9（改系统时间不延长 deadline） | 1.1B | 安全 §7.1 |
| ST-10（审计失败时 `res.ok` 仍为 true，且计数可见） | 1.1B | 安全 §7.1 |
| ST-13（登出后 Cloud 连接表无残留项） | 1.1B + 1.2 | 安全 §7.1 |
| ST-14（忘记设备时云端不可达仍完成本地清理） | 1.1B | 安全 §7.1 |
| ST-16（执行中关闭开关后，同 `delivery_id` 重投必须重新走准入） | 1.1B | 安全 §7.1 |
| ST-17（用户切换后崩溃重启，不自动连旧设备） | 1.1B | 安全 §7.1 |
| ST-18（`grant_ctx` 无效必须拒，且不查缓存） | 1.1B | 安全 §7.1 |
| ST-19（上下文 `bound_user_id` 不匹配 → 阻断） | 1.1B | 安全 §7.1 |
| ST-20（同设备多 Client scope 隔离，缓存不串） | 1.1B | 安全 §7.1 |
| ST-21（撤销后旧请求不得回放缓存） | 1.1B | 安全 §7.1 |
| ST-22（撤销时在途结果不得外传） | 1.1B | 安全 §7.1 |
| ST-23（`grant_update` 重复/乱序/回退幂等） | 1.1B | 安全 §7.1 |
| ST-24（重连快照替换，旧上下文失效） | 1.1B | 安全 §7.1 |
| ST-25（同 token 连续 10 次调用不得被拒） | 1.3 | 安全 §7.1 |
| ST-26（同 token 并发 + 来源指纹不同 → 告警不拒绝） | 1.3 | 安全 §7.1 |
| ST-1（grant 与 device 跨用户必须拒） | 1.2 | 安全 §7.1 |
| ST-2（token 与签名错配必须拒） | 1.2 | 安全 §7.1 |
| ST-3（轮换后旧连接不得收新请求） | 1.2 | 安全 §7.1 |
| ST-11（重连不得重放旧请求） | 1.2 | 安全 §7.1 |
| ST-12（撤销后握手必须拒） | 1.2 | 安全 §7.1 |
| 哨兵字符串 0 命中 | 1.1B + 1.2 | 安全 §6.5.9 |
| 现有 9 条 Cloud 身份路由响应不变 | 1.2 | §2.4 |
| Local `TOOL_NAMES` 与 `stdio.mjs` 不变 | 1.1A + 1.1B | §1A.6 / §1B.7 |

**ST-13 是发布阻断项（Phase 1.0.3 修正）**：1.0.2 的阶段文档曾把它写成「不阻断」
（理由是「已在 ST-4/ST-14 的机制下覆盖」），但安全模型 §7.1 标的是 `✅ 是`。
**以安全文档为准**——它测的是「Cloud 侧连接表有没有残留」，ST-4 测的是「Desktop
不继承设备」，ST-14 测的是「本地清理」，三者断言对象不同，不能互相替代。
**除 ST-15 外，ST-1~ST-26 全部为发布阻断项。**

---

## 5. 依赖关系图

```
1.0.1 文档硬化（已完成）
   │  仅文档 + OAuth Spike 设计
   ▼
1.0.2 文档硬化（已完成）
   │  审计策略 / request_hash / 身份生命周期 / 阶段拆分 / 测试矩阵
   ▼
1.0.3 最终一致性修订（本次）
   │  ST-13 / 1.1B-1.2 依赖 / claim 传输 / 计数生命周期 / 竞态测试
   ▼
1.1A 共享执行层 ──► 1.1B Desktop Agent ──┬──► 1.2 Cloud 设备面 ──► 1.3 MCP 前端 ──► 1.4 ──► 1.5
   只抽 executeTool      设备身份/准入/审计  │   P1+P2+P3 全满足才并行
   不接远程 / 不建 WSS    Mock Gateway      │   否则串行：1.1B 完成后再开 1.2
   949 条 + CB-1..16 验收                   │
                                            └─ 并行 ≠ 跳过前置（§5.1）；两次 Mock 通过 ≠ 集成通过
```

**依赖关系的准确表述（Phase 1.0.3 定稿）**：

| 关系 | 表述 | 说明 |
|---|---|---|
| 1.1A → 1.1B | **硬依赖** | 1.1B 的 `executeTool` 调用面由 1.1A 产出；没有它就只能复制 handler |
| 1.1B → 1.2 | **条件依赖**（可并行） | 只有 P1/P2/P3 同时满足才是并行；否则退化为「1.1B 完成后串行开 1.2」 |
| 1.1B + 1.2 → 1.3 | **硬依赖** | 1.3 需要两端真实可跑；Mock 级通过不足以开 1.3 的联调门禁 |

### 5.1 「可并行」的三条硬条件

1.1B 与 1.2 **可以并行开发**，但必须同时满足以下三条，缺一不可。
另有一条**总前置**：**1.1A 已验收通过**（总原则「上一阶段不通过不开始下一阶段」
不允许被并行绕过——否则 1.1A 的等价性一旦被推翻，两端都要返工）。

| # | 条件 | 判定方式 |
|---|---|---|
| **P0** | **1.1A 已验收**：Local 949 条 + CB-1~CB-16 全过，`TOOL_NAMES` 与 `stdio.mjs` 不变 | §1A.6 验收单 |
| **P1** | **协议合同冻结**：双方实现的是同一份 `REMOTE_MCP_PROTOCOL.md` 的同一版本（当前 `v: 1`）；任何一方需要改帧结构，必须先改文档并通知另一方，不得私下扩展字段 | 双方指向同一 doc commit；文档里记录「协议冻结点」 |
| **P2** | **同一套 Mock 测试向量**：`Desktop/tests/helpers/mock-gateway.ts` 与 `cloud/tests/helpers/mock-device.ts` 使用**同一组**帧 fixture（同一份 JSON 文件），不是各自手写 | fixture 文件在共享位置，两边测试都 import 它 |
| **P3** | **各自独立验收，不联合验收**：1.1B 用 Mock Gateway 验收，1.2 用 Mock Device 验收；**不存在「两边一起测才算过」的阶段** | 各自 §1B.7 / §2.4 可单独执行 |

**如果 P2 做不到**（两边 fixture 各自维护），则**不允许并行**——
必须串行（1.1B 完成并冻结帧格式后再开 1.2）。因为「两边手写的 Mock」
几乎必然在某天开始不一致，而症状是「集成时才发现的诡异超时」。

**并行期的验收边界（最容易被夸大的一条）**：

| 已完成 | 能得出的结论 | **不能**得出的结论 |
|---|---|---|
| 1.1B 全部验收通过 | Desktop 侧符合协议 v1，准入链无漏洞 | ❌「远程链路已打通」 |
| 1.2 全部验收通过 | Cloud 侧符合协议 v1，连接管理正确 | ❌「ChatGPT 已经能查数据」 |
| 两者都通过 | 两端各自自洽 | ❌「端到端集成已验收」——Mock 是各自按文档手写的对端，**两端同时偏离文档时仍会各自通过** |

**端到端集成验收的唯一时机**：1.3 的真实联调（`/mcp` + 真实 Cloud WSS）。
在 1.3 之前，任何报告只能写「Mock 级通过」。

### 5.2 为什么 1.1A 必须先做

如果 Remote 先直接调 `HANDLERS` 跑起来，再回头抽执行层，
就要同时改「已跑通的 Remote 路径」与「Local 路径」——回归面翻倍。
**先抽取、后接入**，Local 的 949 条 + CB-1~CB-16 就是现成的等价性证明。

### 5.3 为什么 1.1A 可以完全独立

它只动 `src/main/application/mcp-tools/` 与 `request-router.ts` 一个文件，
不碰网络、不碰 IPC、不碰设置界面。失败时回滚一个纯重构即可。

---

## 6. 本阶段（1.0 / 1.0.1 / 1.0.2 / 1.0.3）的实际交付

| 文档 | 核心内容 |
|---|---|
| `REMOTE_MCP_ARCHITECTURE.md` | 27 工具实测、共享执行层（§6.5）、Bridge 边界、Cloud 9 路由、`redirect_uri` 硬限制、设备模型缺失、12 原则判定、8 工具面、B1–B7 阻塞项、**23 项 OQ 总表**、**阶段依赖三性质与「Mock ≠ 集成」**、**时间术语** |
| `REMOTE_MCP_SECURITY.md` | 五层权限、设备四凭证与注册闭环（`claim_secret` 走 POST 体）、4 个远程 scope、五个状态机、撤销顺序、审计方案 A、**审计三段分离与 best-effort 承诺（计数器为进程内状态）**、**启动即校验（不依赖 UI）**、**Grant 授权上下文（P0-1）**、**`jti` 语义（P0-2）**、T1–T19、**ST-1~ST-26 测试矩阵** |
| `REMOTE_MCP_PROTOCOL.md` | **19 个错误码 + 14 个 close code**、握手校验 9 步 + `hello_ok` 构造（共 10 项）+ **Grant 上下文帧（P0-1）**、**Unix epoch / monotonic 二分**、`delivery_id` + **`request_hash`**、六种重复投递情况、**缓存双上限 + 关闭开关即清空 + 逐 grant 键**、四个竞态场景 R1–R4、退避、撤销顺序、用户切换与轮换、多实例路由、OAuth 三层分离、**`/mcp` 重放语义（P0-2）** |
| `REMOTE_MCP_PHASES.md` | **1.1A / 1.1B 拆分**、CB-1~CB-16 行为对照表、Spike 五级状态码、**发布阻断项汇总（除 ST-15 外全部阻断）**、**并行四条件 P0–P3**、1.2/1.3（含真实 ChatGPT 门禁 G1–G6）/1.4/1.5 |

**未产生**：任何功能代码、数据库迁移、路由改动、配置改动、依赖变更、commit/push/merge。
**未执行**：任何 Spike、任何测试（三轮修订均为纯文档工作）。

> **Phase 0（P0-1 / P0-2）是 1.0.3 之后的独立一轮文档修订**，不改变上述 1.0.x 的交付结论，
> 也不改变阶段划分与阶段归属。它只做两件事：把 Grant 授权上下文闭环写进协议
> （`hello_ok.grants` / `grant_update` / `req.grant_ctx`，安全 §2.7、协议 §6.5），
> 把 `jti` 的语义定死为 **token 级、不做请求级去重**（安全 §3.2.1、生命周期 §15.2）。
> 逐条索引见 `REMOTE_MCP_INDEX.md` §7。
