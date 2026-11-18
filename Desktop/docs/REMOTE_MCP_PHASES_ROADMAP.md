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
| **1.3.1** | MCP OAuth 基础设施 | 迁移 `0003`、`mcp_sessions`、authorize/token/register、PRM/AS 元数据、consent 页、与 Desktop 登录隔离 |
| **1.3.2** | Streamable HTTP 与工具服务 | `POST /mcp`（dual-era）、Bearer + audience + grant 回查、8 个只读工具、错误面、日志纪律 |
| **1.3.3** | 真实客户端联调 | Inspector、ChatGPT、Grok、refresh 行为、撤销/离线/异常恢复、回填 `NOT VERIFIED` |

### 3.1 范围（1.3.1 + 1.3.2）

| # | 能力 | 子阶段 |
|---|---|---|
| C1 | `POST /mcp`：`createMcpHandler(...).fetch`（SDK 已内部封装 transport，**不再手接** `WebStandardStreamableHTTPServerTransport`） | 1.3.2 |
| C2 | 工具面：8 个只读工具，schema 与 Desktop `TOOL_DEFINITIONS` 一致（一致性测试） | 1.3.2 |
| C3 | MCP OAuth AS：`/mcp/oauth/authorize`、**`/mcp/oauth/login`**、**`/mcp/oauth/callback/:provider`**（MCP 专用，非复用 Desktop 的）、**`GET/POST /mcp/consent`**、`/mcp/oauth/token`（`authorization_code` + `refresh_token`）、`/mcp/oauth/register`（DCR，**默认关闭**）、`/mcp/oauth/revoke` | 1.3.1 |
| C4 | 元数据：`/.well-known/oauth-protected-resource`（含 path-inserted 变体）、`/.well-known/oauth-authorization-server` | 1.3.1 |
| C5 | 表：`mcp_oauth_clients`、`mcp_sessions`、`mcp_auth_codes`（**`mcp_grants` 已在 1.2 建**，本阶段只写入 grant，不重建） | 1.3.1 |
| C6 | Scope 校验：Cloud 侧**逐 grant**（每次 `/mcp` 回查 `mcp_grants`）+ Desktop 侧**逐请求**（按 `grant_ctx`） | 1.3.2 |
| C7 | challenge：**401** = `Bearer resource_metadata="…"`（**不带 `scope`**）；**403** = `Bearer error="insufficient_scope", scope="<缺的那一个>", resource_metadata="…"` | 1.3.2 |
| C8 | 日志纪律：只 tool/status/duration/error_code/delivery_id/**`jti` 前 8 位**/`grant_id`（安全 §3.2.1、协议 §13.3） | 1.3.2 |
| C9 | **MCP 专用 JWT**：`signMcpAccessToken` / `verifyMcpAccessToken`，`aud = MCP_RESOURCE`（= `<baseUrl>/mcp`，≠ `brewphase-desktop`）；**不改**现有 `signAccessToken` | 1.3.1 |
| C10 | **会话归属**：**独立 `mcp_sessions`（身份）+ `mcp_refresh_tokens`（每代凭据）两层**（OQ-3 已定，见设计 §9）；`sid` 跨刷新不变；`absolute_expires_at` 不可变；**不改** `auth_sessions` | 1.3.1 |
| C11 | **真实客户端验收**（见 §3.4 门禁表）——只有 1.3.3 能做 | 1.3.3 |
| C12 | **浏览器授权会话**：签名 Cookie `bp_mcp_bs`（`HttpOnly` / `Secure` / `SameSite=Lax` / `Path=/mcp` / 30 min / 不滑动）、TOFU 绑定、CSRF | 1.3.1 |
| C13 | **最小权限 scope**：401 省略 `scope`；`tools/list` 不需业务 scope；`tools/call` 缺 scope 才 403 且只报缺的那个；consent 页可逐项取消；step-up 扩权 | 1.3.1（consent 收窄）+ 1.3.2（403/step-up） |

### 3.2 关键差异（与现有登录 OAuth）

| 项 | 现有 `/oauth/*` | 新增 MCP AS |
|---|---|---|
| 路径组 | `/oauth/*` | **`/mcp/oauth/*`**（元数据仍在根 `/.well-known/*`，RFC 要求）；consent 在 `/mcp/consent` |
| 浏览器会话 | **无**（Desktop 是应用内开系统浏览器 + 本机回环回调） | **签名 Cookie `bp_mcp_bs`**（仅 `/mcp` 路径，30 min） |
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
Provider 回调 + `/mcp/consent`。可复用的只有 Provider 适配器
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
   Google/GitHub → 回到 `/mcp/consent` → 看到 4 项权限与回调域名 → 批准 →
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
