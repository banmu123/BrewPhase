# BrewPhase Remote MCP — 通信协议 · 生命周期与参考（§11–§16）

> **分册说明**：本册从 `REMOTE_MCP_PROTOCOL.md` 按整章拆出，章节号沿用全系列编号（未重新起算）。
> 本册：§11 生命周期事件、§12 多实例下的设备路由、§13 字段归属与校验、§14 完整时序示例、§15 Gateway HTTP 端点、§16 与 Local MCP 协议对照。
> 全系列索引见 `REMOTE_MCP_INDEX.md`。基线 `feature/remote-mcp` @ `fc96654`。
> 本册由原文档整章拆出（仅搬移 + 补导航，无内容变更）；**其后叠加 Phase 0 的
> P0-1 / P0-2 修订**，逐条见 `REMOTE_MCP_INDEX.md` §7。

---

## 11. 生命周期事件

**统一顺序原则（与安全 §4.1 一致）：① 先持久化授权状态 → ② 再异步清理连接/路由。
清理失败不回滚已持久化的撤销。**

这里有两个**不同层次**的顺序，不要混为一谈：

| 顺序 | 说的是 | 规则 |
|---|---|---|
| **授权状态顺序** | 「撤销」什么时候生效 | 先写状态（DB），再清理连接。清理失败也不放行 |
| **凭证使用顺序** | 本地/服务端的凭据文件何时删 | 必须**先完成所有需要凭据的请求**（断连、suspend），再删凭据。反了则请求发不出去 |

§11.1 讲的是**凭证使用顺序**（先断连再清凭据）；§11.2 讲的是**授权状态顺序**
（先持久化再清理）。两者不矛盾。

### 11.1 用户退出 Cloud 登录

```
Desktop account-service.signOut()
  → 1. remote.disconnect()：发 bye(reason=signout) → close 1000
  → 2. 尽力 POST /mcp-devices/{self}/suspend（仅本设备）
  → 3. 清本地 account 凭据（现有行为：删 credentials.json）
  → 4. 保留 remote/device.json（设备身份不随登录作废）

Cloud 收到 bye / 检测到 close：
  → 删该设备的连接表项
  → 不撤销 mcp_grants（grant 属于 user，其它设备可能还在用）
  → 不断开该 user 的其它设备
```

**为什么先断连再清凭据**：断连和 `suspend` 都需要 Bearer/device_token；
先清凭据会导致这两个请求发不出去，Cloud 只能等心跳超时（最长 60s），
用户会看到「已退出但设备仍显示在线」。

**为什么不清 `device.json`**：设备身份是机器的属性，不是会话的属性。
每次登出都要求重新走确认码，会让用户放弃使用。

### 11.2 设备撤销

```
① 持久化（同步，事务）
   Cloud: mcp_devices.status = 'revoked', revoked_at = now()
   —— 提交后，任何转发前查状态都会拒（即使 ② 全失败）

② 清理（异步，可失败）
   Cloud: DELETE 路由表项（先删表，避免竞态中还有请求被转发）
   Cloud: 向该连接发 bye(reason=revoked) → close 4003

③ Desktop 收到 4003
   删除 userData/remote/device.json（私钥）
   linkState = 'blocked'
   界面「远程已断开」→ 不重连
```

**注意顺序变化**：Phase 1.0 写的是「先断连再删路由表」，现在改为
**先持久化 → 再删路由表 → 再发 bye**。删路由表在发 bye 之前，是因为
「连接还在但表项已删」的唯一后果是这条连接收不到新请求（无害）；
反过来「表项还在但连接已死」会让请求打到死连接上（有害）。

### 11.3 Grant 撤销（设备保留）

```
① Cloud: mcp_grants.revoked_at = now()（单条，按 grant_id 精确撤销）
② Cloud: **先停路由**（该 grant 的后续请求直接 GRANT_REVOKED），grant_epoch + 1
③ Cloud → Desktop: grant_update{op:"revoke", grant_ctx, reason}
④ Desktop: 移除上下文 → 清该 grant_ctx 的全部缓存（含 inflight 占位）
   → 在途请求完成后不回传数据，回 GRANT_REVOKED
⑤ Desktop → Cloud: grant_update_ack{grant_epoch, applied}
⑥ 撤销该 grant 的 refresh（若使用独立 mcp_sessions，见 OQ-3）
⑦ **不**断开设备连接
⑧ **不**影响该 user / 该设备的其它 grant
```

**撤销是「先停路由，后通知」，顺序不能反**：若先发帧再改库，两者之间到达的
`req` 仍会被转发——虽然 Desktop 可能已清上下文，但那是运气，不是保证。

**`policy` 帧不再需要**：`grant_update` 就是策略下推帧（协议 §6.5）。
Phase 1.0 曾把它写成「可选增强、第一版不做」；P0-1 后它变成**必需**——
没有它，Desktop 无法在撤销后立即失效，只能等下一次握手。

### 11.4 本地开关关闭（本地优先）

```
① Desktop（同步，权威）
   写 local_state['remote.enabled'] = 'false'
   linkState 立即置为 'idle'
   对内存中任何在途/新到的 req 直接回 REMOTE_DISABLED

② Desktop（异步，可失败）
   POST /mcp-devices/{self}/suspend
   → 无论成功与否，都断开 WSS（close 1000）

③ Cloud
   status = 'suspended'；删路由表项并 close 4005（若连接仍在）

后续请求：
  - Cloud 仍认为在线（② 失败时）→ 请求发到 Desktop → Desktop 回 REMOTE_DISABLED
  - Cloud 已标 suspended → 直接回 DEVICE_SUSPENDED
```

**`REMOTE_DISABLED` 与 `DEVICE_SUSPENDED` 的语义不同**：
前者是「Desktop 本地拒绝了」（Cloud 可能还以为在线），
后者是「Cloud 知道设备被暂停」。两者都不可重试，但排障含义不同——
有 `REMOTE_DISABLED` 说明 Cloud 状态同步失败，这正是要观测的信号。

### 11.5 用户切换（A 登出 → B 登录）

**这条不在 Cloud 侧处理，全部在 Desktop 侧拦截。** 因为 Cloud 只知道
「设备 X 属于用户 A」，它没有任何依据判断「此刻桌面端登录的是 B」——
除非 Desktop 主动上报，而那又是一条新的信任假设。

```
B 登录成功 → remote.prepareFor(uB)
  device.boundUserId === uB  → 允许 resume；但仍需用户手动开开关
  device.boundUserId !== uB  → 强制阻断：
      local_state['remote.enabled'] = 'false'
      linkState = 'blocked'
      **不建立任何出站连接**（因此 Cloud 侧该设备变为离线）
      保留 device.json（含旧的 boundUserId，供用户主动解绑）
      界面：需要先解绑并重新注册
```

**为什么不在 Cloud 侧「改绑」**：`mcp_devices.user_id` 改成 B 等于把 A 的设备
资产静默转给 B。正确做法是 B 走一次全新注册（新 `device_id`），
旧行由 A 在自己的 Web 设置页删除。

**验证**：ST-4（A 登出 B 登录 → 不继承 A 的设备授权）。

### 11.6 设备 Token / 密钥轮换

```
① Desktop → POST /mcp-devices/{self}/rotate（Bearer 旧 device_token）
   body: { new_public_key, ts, sig = Ed25519_旧私钥("brewphase.remote.rotate.v1\n"
           + device_id + "\n" + new_public_key + "\n" + ts) }
② Cloud：用**旧公钥**验签通过 → 单条 UPDATE 覆盖 public_key + token_hash
   → 返回新 device_token（唯一一次）
   → **立即**将该 connection_id 标记为 `rotating`
③ Cloud：删路由项 → bye(rotated) → close 4010
④ Desktop：**先落盘**新凭据（新私钥 + 新 token + 同一 boundUserId）→ 用新凭据重连
```

**`rotating` 状态的语义**：从 ② 提交到 ③ 的 close 之间，该连接上到达的
**任何 `req` 一律回 `DEVICE_UNAUTHORIZED`**，不进入 Desktop 的准入链。
理由：凭据已经换了，旧连接不再代表当前设备身份；
如果继续放行，「轮换」就只是换了个 token，旧连接的安全语义没有变化。

**已在执行中的请求**：允许其完成（它用的是旧连接建立时的授权，且只读无副作用）。
`OQ-14` 记录这一取舍，Phase 1.2 需明确并测试。

**为什么新 token 必须在 ② 的响应里返回**：轮换的本质是「换一套凭据」。
若不返回新 token，设备只能重新走一遍注册（再要一次确认码），
那就不是轮换而是重注册。明文只出现一次，Cloud 只存 `sha256`。

**失效关系一览**：

| 对象 | 失效时刻 | 机制 |
|---|---|---|
| 旧 `device_token` | ② 的 UPDATE 提交 | `token_hash` 被覆盖 |
| 旧公钥 | 同上 | `public_key` 被覆盖 |
| 旧连接上的新请求 | ② 之后立刻 | `rotating` 标记 → `DEVICE_UNAUTHORIZED` |
| 旧路由表项 | ③ | 显式删除 |
| 旧 WSS 连接 | ③ | close `4010` |

**验证**：ST-3（轮换后旧连接发新请求 → 拒绝）。

---

## 12. 多实例下的设备路由

### 12.1 问题

WSS 是长连接，连接只存在于**某一台** Gateway 实例的内存里。ChatGPT 的
`POST /mcp` 可能打到任意实例（LB 轮询），因此必须有跨实例的「这台设备连在哪」。

### 12.2 第一版：单实例（运维约束，无法技术强制）

```ts
// 接口先定好，实现可以是内存
interface ConnectionRegistry {
  bind(userId, deviceId, conn: { connectionId, instanceId }): Promise<void>
  unbind(userId, deviceId): Promise<void>
  lookup(userId, deviceId): Promise<{ connectionId, instanceId } | null>
  touch(userId, deviceId): Promise<void>   // 心跳续约
  listByUser(userId): Promise<Array<{ deviceId, connectionId, instanceId }>>
}
```

内存实现的 `instanceId` 恒为 `"gw-a"`。

**必须诚实说明：单副本无法在应用层技术上强制。** 两个副本会各自维护一份内存路由表，
设备连到 A、请求打到 B 时表现为 `DEVICE_OFFLINE`（看起来像设备掉线，实际是部署错误）。
因此只能靠三层约束：

| 层 | 做法 |
|---|---|
| 启动断言 | `GATEWAY_EXPECTED_REPLICAS` 环境变量（默认 `1`）；`> 1` 时**拒绝启动**并打印「需要 Phase 1.4 的共享路由表」 |
| 就绪探测 | `/ready` 增加 `instance_id` 与 `connection_count`；运维可据此发现「两台都在接流量」 |
| 部署文档 | README / 部署清单写明：Phase 1.2–1.3 期间 `replicas` 必须为 1，滚动更新用 `maxSurge=0, maxUnavailable=1` |

换 `instance_id` 的能力保留，是为了 Phase 1.4 换 Redis 实现时**不需要改协议**。

**`OPEN QUESTION` `OQ-12`**：`GATEWAY_EXPECTED_REPLICAS` 是否可被运维误配为 1
而实际跑 2 副本？**答**：无法完全防止——这是运维约束，不是安全边界。
缓解：`/ready` 暴露 `instance_id`（每个副本随机生成并打印启动日志），
运维可对比 LB 后端清单。**不阻塞**。

### 12.3 多实例：Redis（Phase 1.4）

```
key:    mcp:conn:{user_id}:{device_id}
value:  {connection_id, instance_id, device_id, last_pong_at}
TTL:    90s（每次 ping 续期，比心跳间隔长，防抖动误删）

路由：
  1. lookup → instance_id
  2. instance_id == self  → 本地 Map 取 socket，直接转发
  3. 否则 → PUBLISH mcp:route:{instance_id} {req, reply_channel}
           等待 reply_channel 上的应答（超时 = 转发超时）
  4. lookup 为空 → DEVICE_OFFLINE
```

替代方案（不引 Redis）：Postgres `LISTEN/NOTIFY`。延迟可接受（<50ms），
但每条请求都要一次跨实例通知，QPS 高时数据库压力明显。**推荐 Redis**，
理由：它的 pub/sub 语义与「路由表 + TTL」正好匹配，且未来限流也可以共用
（现有 `rate-limit.ts` 已注明需要共享存储）。

### 12.4 路由表的一致性要求

| 要求 | 原因 |
|---|---|
| `bind` 必须在 `hello_ok` **之前**完成 | 否则握手成功但请求打进来时查不到 |
| `unbind` 必须在 close 处理里执行 | 否则路由到死连接 |
| TTL 必须 > 心跳间隔 × 2 | 防一次 ping 丢失就把在线设备判死 |
| 撤销设备时**先持久化状态**，再删表、再发 bye | 见 §11.2；清理失败也不能放行 |
| 顶替（§4.5）时**先 bind 新连接**，再断旧 | 避免空窗 |

---

## 13. 字段归属与校验

### 13.1 谁生成什么

| 字段 | 生成方 | 是否被对方校验 | 说明 |
|---|---|---|---|
| `v` | 双方各自填 | ✅ 版本区间（§1.1 公式） | 不允许中间件改 |
| `ts` | 发送方 | ⚠️ 仅握手时校验 ±120s | 其余帧只用于诊断；**不用于算耗时** |
| `device_id` | **Cloud**（注册时） | ✅ 必须与 token 归属一致 | 客户端自报一律忽略 |
| `nonce` | Desktop | ✅ 120s 去重（原子 check-and-record） | 每次握手新值 |
| `sig` | Desktop | ✅ Ed25519，覆盖 `device_id\nnonce\nts` | 不含版本号（版本由服务端强制） |
| `connection_id` | **Cloud** | ⚠️ **只在 `hello_ok` 出现一次**；后续帧不携带 | 属于连接上下文（§4.5） |
| `instance_id` | **Cloud** | — | 只用于诊断 |
| `heartbeat_ms` / `max_inflight` / `allowed_tools` | **Cloud** | Desktop 取交集 | Cloud 是策略源（**连接级**上限） |
| `grant_epoch` / `grants[]` | **Cloud** | ✅ 逐项校验 + 原子替换 | 逐 grant 的授权上下文（§6.5） |
| `grant_ctx`（在 `req`） | **Cloud** | ✅ 必须命中本地上下文 | **请求里唯一的授权引用** |
| `grant_id` / `client_id` / `client_name` / `scopes` | Cloud（在上下文中，**不在 `req`**） | ✅ 只从上下文取 | 不再出现在请求帧 |
| `id`（`delivery_id`） | **Cloud** | ✅ 响应必须回显；重投必须复用 | Desktop 不得自造 |
| `request_hash` | **Cloud** | ✅ 必须与 `{v, tool, arguments}` 重算值一致 | 只校验同 id 未被换内容，**不参与跨 id 合并**（§8.2） |
| `tool` | Cloud（来自 MCP） | ✅ 白名单 + 存在性 | — |
| `arguments` | Cloud（来自 MCP） | ✅ Zod | Desktop 不信任任何字段 |
| `deadline_ms` | **Cloud** | ✅ 必须尊重 | Desktop 不得延长 |
| `data` / `error` | Desktop | Cloud 不透传未登记 code | — |

**已移除的字段**：`idem`（Phase 1.0 的去重键）。理由见 §8.1–8.3。
若未来需要「意图指纹」用于诊断，字段名必须是 `intent_digest` 且**明确不参与去重**。

**`request_hash` 与 `idem` 的区别（最容易混淆的一点）**：

| | `idem`（已移除） | `request_hash`（Phase 1.0.2） |
|---|---|---|
| 计算对象 | `{tool, arguments}` | `{v, tool, arguments}` |
| 是否跨 `delivery_id` 比较 | **是**（这就是 bug 来源） | **否**，只在同一 `delivery_id` 内比 |
| 命中后的行为 | 回放缓存（可能是陈旧数据） | 只是「允许走缓存」，内容不同则拒绝 |
| 能否合并两个独立查询 | 会（错误） | 绝不 |

### 13.2 三条反伪造规则

1. **`user_id` 永远不出现在任何帧里。** Cloud 从 token 派生，Desktop 也不需要
   （本地库本来就只有一个用户）。请求里出现即视为协议违规并记安全事件。
2. **`device_id` 不参与路由决策。** 路由键是 `(token → user_id, connection)`。
   `device_id` 只用于审计与多设备场景的展示。
3. **Desktop 不根据请求帧里的自报字段决策。** `grant_ctx` 只是引用；真正的
   grant / client / scope 全部来自 Cloud 下发的上下文。Desktop 仍按上下文状态 +
   本地开关 + `boundUserId` + 白名单 + scope 判定；上下文本身也要校验归属与版本，
   不因为「Cloud 说合法」就放行（安全 §2.7.3）。

### 13.3 敏感数据不进日志（协议层约束）

| 位置 | 规则 |
|---|---|
| Cloud HTTP 日志 | 只 `method/path/status/duration`（现有 `app.ts` 已如此） |
| Cloud `/mcp` 结构化审计 | 可记 `jti` **前 8 位**、`grant_id`、`client_id`、`tool`、`delivery_id`、状态；**不记** token 原文、参数、结果。`jti` 是 Token 级标识（安全 §3.2.1），不构成请求级追踪 |
| Cloud WSS 日志 | 只 `device_id` 前 8 位、`tool`、`status`、`duration_ms`、`error_code`、`delivery_id` |
| 帧内容 | **永不**记录 `arguments` / `data` / `error.message` |
| Desktop 日志 | 可记完整 `error.message`（本地），但不记 `data`；可记 `grant_id` / `delivery_id`（审计表无这些列） |
| 审计表 | `mcp_operation_log`：`client_id='remote:<device_id>'` + tool / entity / success / error_code，**无参数无结果**（安全 §6.5） |

---

## 14. 完整时序示例

### 14.1 正常查询

```
ChatGPT → POST /mcp  tools/call search_records {search:"埃塞", limit:20}
Gateway:
  JWT ok → sub=u1, sid=s1；查 mcp_grants → grant=g1, scope 含 records:read ✔
  device d1 属于 u1 ✔；grant_epoch=7 已 ack ✔
  registry.lookup(u1, d1) → {conn_01J, gw-a} ✔
  生成 delivery_id=req_01J8Z9K2M4, request_hash=sha256({v,tool,args}),
      deadline=now+15000, grant_ctx=gc_7 → WSS
Desktop:
  开关 on ✔ / 帧合法 ✔ / 未过期 ✔ / grant_ctx=gc_7 已知且 active ✔
  / ctx.bound_user_id=u1 == boundUserId ✔ / tool ∈ effective_tools(g1) ✔
  / records:read ∈ effective_scopes(g1) ✔ / hash 一致 ✔
  缓存 (gc_7, req_…) 未命中 → executeTool('search_records', args) → 20 条（has_more=true）
  审计尝试写入：client_id='remote:0b7c…', tool=search_records, success=1
  res ok:true, duration_ms=118 (monotonic), cached=false
  → 写入缓存 {grant_ctx:gc_7, delivery_id, request_hash, ok, data, completedAtMono}
Gateway → ChatGPT: structuredContent={items:[…],limit:20,offset:0,has_more:true}
```

**同一次调用中审计失败的情形（必须单独理解）**：

```
Desktop:
  ... executeTool 成功 → data 已就绪
  审计尝试写入 → SQLite 抛错
  → console.error('[remote] audit write failed', err)
  → consecutiveFailures += 1；lastFailureAt = now
  → **仍然发送** res ok:true, data=（原样）
  → 设置页显示告警：「最近 1 次远程访问未能写入审计记录」
```

`res` 与审计结果无关——这是安全 §6.5.5 三段分离的直接体现，
也是 ST-10 的验收内容。

### 14.2 设备离线

```
ChatGPT → POST /mcp
Gateway: registry.lookup(u1,d1) → null
→ tool result isError:true, {error:{code:"DEVICE_OFFLINE",retryable:true}}
（日志只记 tool + code，不记 search 关键词）
```

### 14.3 超时 + 迟到结果

```
t=0      Gateway 发 req(delivery=req_x), deadline_ms=t+15000
         Desktop 收到，remaining=15000 → expiresAtMono = perf.now()+15000
t=15000  Gateway 未收到 res
         → 回 ChatGPT {code:"REQUEST_TIMEOUT", retryable:true}
         → 发 cancel(req_x, reason:"gateway_timeout")
t=15020  Desktop 执行完成，检查 perf.now() >= expiresAtMono（或已收到 cancel）
         → **不发送 res**（丢弃结果）
         → 审计 success=false, error_code=REQUEST_TIMEOUT
t=15021  Cloud 收到迟到 res（若 Desktop 因 bug 发送）→ 无对应 waiter，**忽略**
```

### 14.4 参数完全相同但两次独立调用（Phase 1.0.1 必须正确）

```
10:00  ChatGPT 第 1 次: search_records{search:"埃塞"} → delivery=A → 执行 → 返回 5 条
10:01  用户又冲了 1 杯并记录
10:05  ChatGPT 第 2 次: search_records{search:"埃塞"} → delivery=B
       （参数与 A 完全相同，但 delivery 不同）
       → **必须重新执行** → 返回 6 条

若按 Phase 1.0 的 idem=sha256(tool+args) 去重 → 会回放 A 的 5 条
→ 用户看到过期数据且无从察觉。这就是移除 idem 的原因。
```

### 14.5 撤销后重连尝试

```
Web 撤销设备
  → Cloud ① status='revoked'（持久化，先做）
  → Cloud ② 删路由项 → bye(revoked) → close 4003
Desktop: 收到 4003 → 删 device.json → blocked → 不重连 → 界面「远程已断开」
若 Desktop 因 bug 仍重连 → hello → Cloud 校验 status=revoked → close 4003
                          （第二次之后 Cloud 对该 device_id 限流，1 次/分钟）
```

---

## 15. Gateway 必须暴露的 HTTP 端点

| 方法 | 路径 | 用途 | 备注 |
|---|---|---|---|
| `POST` | `/mcp` | MCP Streamable HTTP | 用 SDK `createMcpHandler` + `WebStandardStreamableHTTPServerTransport` |
| `GET` | `/.well-known/oauth-protected-resource` | RFC 9728 保护资源元数据 | SDK `buildOAuthProtectedResourceMetadata` |
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 AS 元数据 | SDK `oauthMetadataResponse` |
| `POST` | `/register` | DCR（RFC 7591） | 是否需要「待确认」（见安全文档 §9） |
| `GET` | `/authorize` | 授权（含 consent 页） | **必须接受非 127.0.0.1 的 redirect_uri**（与现有登录 OAuth 的关键差异） |
| `POST` | `/token` | `grant_type=authorization_code\|refresh_token` | **必须支持 `grant_type`**（与现有 `/oauth/token` 的差异） |
| `POST` | `/revoke` | RFC 7009 | 可选 |
| `POST` | `/mcp-devices/register` | 设备注册（§3.2） | 需用户 Bearer |
| `POST` | `/mcp-devices/{id}/confirm` | 用户确认码（§3.3） | Web 设置页 |
| `POST` | `/mcp-devices/{id}/credentials` | 领取 device_token（§3.4） | 需 Bearer + 请求体 `claim_secret`（**不入 URL**） |
| `GET` | `/mcp-devices` | 设备列表 | 不含 token |
| `POST` | `/mcp-devices/{id}/rotate` | 轮换（§3.5） | 需 device_token + 旧私钥签名 |
| `POST` | `/mcp-devices/{id}/suspend` \| `/resume` | 暂停 / 恢复 | Bearer 或 device_token |
| `DELETE` | `/mcp-devices/{id}` | 撤销 | Bearer |
| `GET` | `/health` | 存活 | 已有 |
| `GET` | `/ready` | 就绪（新增 `instance_id` / `connection_count`） | 扩展现有 |

`/mcp` 必须：
- 校验 `Authorization: Bearer`，失败返回 401 + `WWW-Authenticate: Bearer resource_metadata="…"`
- 校验 `Host` 与 `Origin`（SDK 的 `hostHeaderValidationResponse` / `originValidationResponse`）
- 请求体上限 256 KB（MCP 请求本身不含大数据）
- 不支持 `GET` 的 SSE 长连接（第一版只要请求-响应；ChatGPT 若要求 SSE，Phase 1.3 再加）

### 15.1 OAuth 相关的三层要求必须分开（Phase 1.0.1）

| 层 | 内容 | 当前状态 |
|---|---|---|
| **A. MCP 官方协议要求** | Streamable HTTP（`POST /mcp`，可选 SSE）、`initialize` / `tools/list` / `tools/call`、RFC 9728 保护资源元数据、`WWW-Authenticate` 带 `resource_metadata`、RFC 8707 `resource` 参数、PKCE S256 | SDK 已提供实现（`createMcpHandler`、`WebStandardStreamableHTTPServerTransport`、`buildOAuthProtectedResourceMetadata`、`requireBearerAuth`、`checkResourceAllowed`）——**协议层不用手写** |
| **B. ChatGPT 实际接入要求** | 是否必须 DCR、是否必须 `outputSchema`、是否发送 `notifications/cancelled`、是否要求 SSE `GET /mcp`、`resource` 是否必填 | **未验证**（OQ-B/OQ-C）。**Phase 1.0.1 不得断言任何一条**，Phase 1.3 用真实客户端验收 |
| **C. BrewPhase 自身安全策略** | `redirect_uri` 精确匹配（不走通配）、scope 必须在同意页逐项展示、`aud` 绑定 resource、token 15 分钟、撤销立即生效 | 已设计（本文 + 安全文档），与 A/B 无关，**不因 ChatGPT 的要求而放宽** |

**不允许的推断**：不能说「ChatGPT 一定要求 DCR」或「ChatGPT 一定不支持 refresh」。
这些只能由真实联调确定。Phase 1.0.1 只把它们列为验收门禁项。

### 15.2 `/mcp` 的请求级重放语义（Phase 0 / P0-2）

| 项 | 决策 |
|---|---|
| `jti` 的层级 | **Token 级**：一个 access token 一个值，`exp` 前不变（安全 §3.2.1） |
| 同一 token 多次 `tools/call` | **合法且常态**；禁止以「`jti` 重复」为由拒绝 |
| 请求级去重 | v1 **不做** per-request nonce；8 个工具全部只读，重放只造成重复读 |
| 重试识别 | MCP `Idempotency-Key`（客户端提供时）或网关 `delivery_id`；**不用 `jti`** |
| 审计关联 | 可记 `jti` 前 8 位 + `grant_id` + `delivery_id`（§13.3） |
| 写工具 | 开放前必须改为发送者约束（DPoP）或 per-request nonce（`OQ-16`） |

**为什么 HTTP 层不需要 nonce**：能重放一个带 Bearer 的 HTTP 请求的攻击者，
通常已经拿到了 token——他可以直接构造新请求，nonce 拦不住。真正有效的是
短 TTL、`aud` 绑定、每次转发查 grant/scope，以及未来的发送者约束。
反过来，给每个请求加 nonce 会引入客户端状态，且对只读工具没有收益。

---

## 16. 与 Local MCP 协议的对照

| 项 | Local MCP | Remote Link |
|---|---|---|
| 传输 | Unix socket / Named Pipe | WSS |
| 帧 | NDJSON（一行一帧） | 一帧一 JSON |
| 认证 | `bp_mcp_*` token（每请求查库） | `bp_dev_*` + Ed25519 握手；MCP JWT 在 HTTP 层 |
| 版本 | `protocolVersion: 1`（整数，严格相等） | `v: 1`（区间协商 + 未知字段忽略） |
| 超时 | 客户端 30s 硬编码（服务端无 deadline） | `deadline_ms` 绝对时间 + monotonic 计时，双层预算 |
| 取消 | 无 | `cancel` 帧 |
| 重投去重 | `mcp_idempotency` 表（写工具，`(client_id,key)` 唯一） | 内存 LRU 按 **`(grant_ctx, delivery_id)`**（只读，256 条 / 8 MiB / 60s，断线清空） |
| single-flight | 无（同步 handler） | **无**（理由同左，见 §8.4） |
| 执行入口 | `routeBridgeRequest` → `HANDLERS` | **同一个 `executeTool`**（架构 §6.5） |
| 错误码 | 12 个 `MCP_ERROR_CODES`，`{code,message}` | 19 个，`{code,message,retryable}` |
| 审计 | `mcp_operation_log`，**只记写工具** | 同表，**只读也记**，`client_id='remote:<device_id>'` |

**不合并两套协议**：NDJSON 单行帧适合本地流式追加，JSON 帧 + 心跳适合长连接；
强行统一会让本地链路背上心跳与重连的复杂度，而它根本不需要。
**但执行层必须合并**——那是业务逻辑，一份就够。
