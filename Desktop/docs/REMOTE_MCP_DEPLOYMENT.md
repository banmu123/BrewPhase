# BrewPhase Remote MCP — 部署约束（Phase 1.2–1.3）

> 适用版本：Phase 1.2B.1 之后的 Cloud。**这份文档只讲部署**，协议语义见
> `REMOTE_MCP_PROTOCOL.md`，安全边界见 `REMOTE_MCP_SECURITY*.md`。
>
> 一句话总结：**必须单副本**。下面每一节都是在解释「为什么」以及「误配长什么样」。

---

## 1. 单副本要求（硬约束）

WSS 是长连接，连接只存在于**某一台**实例的内存里（`ConnectionRegistry`）。
ChatGPT 的请求可能打到任意实例，于是：

| 配置 | 现象 |
|---|---|
| 1 副本 | 正常 |
| 2 副本 | 设备连到 A、请求打到 B → **随机的 `DEVICE_OFFLINE`**。设备明明在线，日志里没有任何错误 |

所以 Phase 1.2–1.3 期间 `replicas` **必须为 1**。

三层约束（都只是「尽早发现」，**没有一层能技术强制**）：

| 层 | 做法 |
|---|---|
| 启动断言 | `GATEWAY_EXPECTED_REPLICAS` 缺省 `1`；设为 `> 1` 时**进程拒绝启动**并打印需要 Phase 1.4 的共享路由表 |
| 就绪探测 | `GET /ready` → `{status, instance_id, connection_count}`；逐个拉 LB 后端，**看到两个不同的 `instance_id` 就已经是多实例了** |
| 部署清单 | 本节。`replicas: 1`、`maxSurge: 0`、`maxUnavailable: 1` |

> 启动断言防不住「运维写 `GATEWAY_EXPECTED_REPLICAS=1` 但实际起 2 副本」。
> 这是协议 §12.2 的 OQ-12，**接受为运维风险**，用 `/ready` 的 `instance_id`
> 人工比对来缓解。

---

## 2. 滚动更新

```yaml
# 单副本服务不能「先起新的再停旧的」：那会短暂存在两个实例，
# 而旧实例上的连接在新实例眼里根本不存在。
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 0          # 绝不允许同时存在两个实例
    maxUnavailable: 1    # 允许先停后起（会有一次短暂中断）
```

**更新期间的预期行为**（不是故障）：

1. 旧实例收到 SIGTERM → 停收新连接 → 对所有连接发 `drain{grace_ms:0}` + `bye` → close **1001**；
2. Desktop 看到 1001 → 按退避重连（1001 属「技术性关闭」，**应重连**）；
3. 新实例起来后，Desktop 重新握手 → 新的 `connection_id`、新的 `grant_ctx`。

**中断窗口** = 旧进程停机时间 + 新进程启动时间。期间所有远程请求都是
`DEVICE_OFFLINE`（可重试）。这是单副本的固有代价，不是 bug。

> 不要试图用「先起新的、再优雅排空旧的」来消除中断：那正是 `maxSurge > 0`，
> 也正是「设备连在旧实例、请求打到新实例」的那一类故障。

---

## 3. 进程重启的后果（必须写进用户可见的说明）

| 事件 | 影响 |
|---|---|
| 进程重启 | **所有在线设备断开**。Desktop 会收到 1001 并退避重连 |
| 进程崩溃 | 连接直接断（无 close frame），Desktop 看到 1006 后按退避重连 |
| 重启后 | 连接路由表清空；nonce 表清空（进程内实现，见协议 §4.3）；`mcp_devices` / `mcp_grants` 不受影响 |

**不会发生的事**：设备状态、grant、审计历史都不会因为重启丢失或改变
——它们在 PostgreSQL 里。重启只影响「谁此刻连着」。

---

## 4. 反向代理

WSS 与 HTTP **共用同一个端口**，反代只需要一条规则：

```nginx
location / {
    proxy_pass http://cloud:3000;
    proxy_http_version 1.1;

    # WebSocket Upgrade：三个头都要透传，缺一个就永远升不上去
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;   # map $http_upgrade $connection_upgrade { default upgrade; '' close; }

    # Host 校验看的是 Host，**不看 X-Forwarded-Host**。
    # 因此这里必须让 Host 保持公网主机名，而不是后端地址。
    proxy_set_header Host $host;

    proxy_read_timeout 3600s;   # 心跳 20s，但空闲连接不该被代理提前掐断
}
```

必须注意的三点：

| 项 | 说明 |
|---|---|
| `Host` 必须原样透传 | Cloud 用 `Host` 做白名单校验（`GATEWAY_ALLOWED_HOSTS`，缺省从 `BASE_URL` 推导）。改写后端地址会让所有 Upgrade 被 403 |
| **不要**依赖 `X-Forwarded-Host` | Cloud 完全不读它（客户端可写）。要传真实主机名，改 `Host` |
| `Sec-WebSocket-Protocol` 必须透传 | 它是 `brewphase.remote.v1` 的协商载体，被剥掉会得到 400 |

访问日志：**query 一律被拒**（`?token=...` 会 400），所以反代 access log
里不会出现设备凭证。但**仍然不要**把 `Authorization` 头写进日志。

---

## 5. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 与 WSS 共用 |
| `BASE_URL` | `http://localhost:3000` | 生产必须是 https；也是 Host 白名单的推导来源 |
| `DATABASE_URL` | — | 必填 |
| `GATEWAY_EXPECTED_REPLICAS` | `1` | **`> 1` 拒绝启动**；非正整数按环境校验失败 |
| `GATEWAY_ALLOWED_HOSTS` | 空（从 `BASE_URL` 推导） | 逗号分隔；留空不是「不校验」而是回退推导 |
| `CORS_ORIGINS` | 空 | **仅控制普通 HTTP CORS**（`app.use` 的 ACAO）。**WSS 的 Origin 白名单是 `BASE_URL` 的 Origin ∪ `CORS_ORIGINS`**——见 §5.1。留空不影响 Desktop 连 WSS，因为 Desktop 连的正是 `BASE_URL` 自己 |
| `LOG_LEVEL` | `info` | 连接事件在 `info` |

### 5.1 Origin 白名单：WSS 与 HTTP CORS 是两套

**WSS Upgrade 的 Origin 白名单 = `BASE_URL` 的 Origin ∪ `CORS_ORIGINS`**，
由 `resolveWebSocketAllowedOrigins(baseUrl, corsOrigins)` 构造（生产入口
`src/index.ts` 与测试夹具调用同一个函数）。

为什么 BASE_URL 要自动进白名单：**Electron 主进程的 `net.WebSocket` 会发送
Origin，值为目标 Cloud URL 自身的 Origin**。R1 用真实 Electron 45 抓握手头
确认了这一点——旧文档「原生客户端不发 Origin」的假设已被推翻。只给
`CORS_ORIGINS`（默认空）会让 Desktop 的每次 Upgrade 都被 403：真实设备
`2951ba0a` 拿到凭据后 15 分钟内被拒 16 次，全部 `stage=origin`，而 Host、
子协议、Bearer 形态全部通过。

要点：

- **精确比对**：无通配、无后缀匹配、端口与 scheme 都参与比对。
  `https://example.com` 不匹配 `https://evil.example.com`，
  `:3000` 不匹配 `:3001`。
- **配置非法即启动失败**：`BASE_URL` 或 `CORS_ORIGINS` 里混进通配、
  path、query、fragment、非 http(s) scheme，一律抛错——不静默丢弃
  （那会变成「配了没生效」），更不退化成放行所有。
- **不修改 `ctx.env.corsOrigins`**：BASE_URL Origin 只进 WSS 白名单。
- **普通 HTTP CORS 仍然只由 `CORS_ORIGINS` 控制**（`app.ts` 的
  `corsMiddleware`）。因此 `CORS_ORIGINS` 留空时，用 BASE_URL Origin 请求
  普通 HTTP 路由**不会**拿到 `Access-Control-Allow-Origin`——这是刻意的，
  修 Desktop 不能顺带扩大 HTTP 的允许来源。

`Origin` 不是设备身份认证：真正的设备身份仍由 `device_token`、数据库状态、
Ed25519 hello 签名与 nonce 共同验证。不带 Origin 的请求按既有规则放行进入
后续认证。

---

## 6. 健康检查

```jsonc
// GET /health → 200（只反映进程存活）
{ "status": "ok", "service": "brewphase-cloud", "time": "2026-11-18T06:00:00.000Z" }

// GET /ready → 200 / 503（额外探测数据库）
{ "status": "ready", "instance_id": "gw_4b10c923", "connection_count": 3 }
{ "status": "degraded", "detail": "database unavailable", "instance_id": "gw_4b10c923", "connection_count": 0 }
```

`connection_count` 是**路由表条目数**，不是 socket 数——它回答的是
「这台实例认为自己能路由到多少台设备」，正是多实例问题的核心量。

**不要**把 `/health` 当就绪探针：它不查数据库。反过来，把 `/ready` 当存活探针
会让一次数据库抖动触发容器重启——重启解决不了数据库。

---

## 7. 停机

进程收到 SIGTERM / SIGINT 后的顺序（`cloud/src/index.ts`）：

1. 停止接收新的 Upgrade（新连接得到 **503**）；
2. 停止所有心跳定时器；
3. 对所有连接发 `drain` + `bye`，再 close **1001**；
4. 等待 socket 真正关闭（上限 1s），超时则 `terminate()`；
5. 清空 `ConnectionRegistry`（此时 `connection_count` 必须为 0）；
6. 停止周期清理（`startSweep`）；
7. 关闭 HTTP Server；
8. **最后**关闭数据库连接池。

第 8 步必须最后：心跳收尾要写 `last_seen_at`，连接清理要读 `mcp_devices`。
先关池会让这些收尾动作全部抛错，日志里出现一堆「停机期间的数据库错误」，
真正的停机原因反而被淹没。

`terminationGracePeriodSeconds` 建议 **≥ 15s**（内部兜底是 8s 强制退出）。

**停机必须等进行中的握手**（Phase 1.2B.1.2）：一个卡在数据库查询上的握手
若在 `registry.clear()` 之后恢复并 bind，`connection_count` 会永远停在 1，
而那条连接永远不会再被处理。现在的顺序是：

```
accepting = false
shuttingDown = true          ← 必须先于任何 await（进行中的握手据此取消）
await waitForHandshakes(1s)  ← 必须在 registry.clear() 之前
await waitForClose(1s)
converge(每条连接)
registry.clear()
```

等待有 1s 上限：一个永不返回的查询不该拖住停机。超时后仍有兜底——
握手看到 `shuttingDown` 会自行收敛，那是结构保证，不依赖等待成功。

---

## 7.1 数据库权限

准入用了 `SELECT ... FOR UPDATE`（行锁），所以 Cloud 的数据库角色需要
`SELECT` 之外无额外权限——行锁不需要授权，但**只读副本不能用于准入**
（只读事务无法持写锁，会直接报错）。若用 PgBouncer 的
`transaction` 模式，事务内多语句是允许的；`statement` 模式**不行**。

## 8. 上线前自查

- [ ] `replicas: 1`，且 `maxSurge: 0`
- [ ] `GATEWAY_EXPECTED_REPLICAS` 未设置或等于 `1`
- [ ] `BASE_URL` 是公网 https 地址，且与反代透传的 `Host` 一致
- [ ] 反代透传 `Upgrade` / `Connection` / `Sec-WebSocket-Protocol` / `Host`
- [ ] `/ready` 里的 `instance_id` 在 LB 的所有后端上**只有一个值**
- [ ] 迁移 `0001` / `0002` 已应用（`pnpm --dir cloud db:migrate:prod`）
- [ ] 自定义 WSS 客户端能完成：Upgrade → hello → `hello_ok` → ping/pong → close 1001（停一次进程验证）
