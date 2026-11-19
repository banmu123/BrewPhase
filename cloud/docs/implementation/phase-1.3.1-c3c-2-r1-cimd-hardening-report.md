# BrewPhase Phase 1.3.1-C3c-2-R1 — CIMD Fetcher 安全加固 实施报告

> 日期：2026-11-19 · 分支：`feature/remote-mcp`
> 审查基线：`139731f`（C3c-2 交付点）
> 范围纪律：只修 R1-1 ~ R1-5；**不接入** `/mcp/oauth/authorize`，不动 DCR，不加迁移与依赖。
> 结果总览：**五项全部完成；Cloud 测试 1264 → 1333（+69）；五项指定变异 5/5 被抓；门禁全绿。**

---

## 1. 实际基线

| 项 | 任务书 | 实际 | 说明 |
|---|---|---|---|
| 分支 | `feature/remote-mcp` | `feature/remote-mcp` | ✅ |
| HEAD | `139731f` | `139731f` | ✅ |
| 远程 HEAD | 需核对 | `139731f`（`ls-remote` 实读） | ✅ 未假设 |
| 工作区 | 不得覆盖未提交修改 | 干净 | ✅ |

---

## 2. 修改文件清单

### 源码（2 个）

| 文件 | 变更 |
|---|---|
| `cloud/src/net/proxy-fetch.ts` | +251/−51：`openTunnel` 重写（按代理协议建连）、`connectToProxy` / `sendConnect` / `proxyEndpoint` / `connectAuthority` / `TunnelOptions`、`readResponseBody` / `readPinnedResponse`、`ResponseBodyStream` / `BodyReadResult` / `ResponseHeadLike`；明文目标 + HTTPS 代理改为明确失败 |
| `cloud/src/mcp-oauth/cimd.ts` | +95/−6：`withDeadline`（DNS 真截止时间）、`performance.now()` 单调时钟、`GLOBAL_UNICAST_V6`（2000::/3 白名单）、`classifyHttpStatus` |

### 测试（3 个 + 1 组 fixture）

| 文件 | 条数 | 覆盖 |
|---|---:|---|
| `cloud/tests/net/proxy-fetch.test.ts` | 13 → **20** | HTTPS 代理 TLS、自签名拒绝、凭据隔离、IPv6 authority、拒绝后不回退、代理协议一致性 |
| `cloud/tests/net/pinned-request.test.ts` | 17 → **28** | `readResponseBody` / `readPinnedResponse`：5120/5121、分块、无 CL、低报 CL、byteLength、超限停读 |
| `cloud/tests/mcp-oauth/cimd.test.ts` | 132 → **183** | DNS 预算 7 条、IPv6 范围 8 条、状态分类 20+ 条 |
| `cloud/tests/fixtures/`（新增） | — | 自签名证书 + README（说明是测试材料、生产代码不读） |

**无新增依赖、无新增迁移、未改 Desktop 生产代码。**

---

## 3. R1-1：HTTPS Proxy CONNECT

### 根因

`parseProxyUrl()` 接受 `http:` 与 `https:`，但 `openTunnel()` 一律用 `http.request()` 建连。
`https://` 代理会被**明文**访问：`Proxy-Authorization` 以明文走一跳，代理侧看到的是一条
未加密的 CONNECT 请求。更糟的是它「看起来能工作」——只要对端恰好容忍明文。

### 修复

```
connectToProxy(proxy)
  ├ http:  net.connect({host, port})
  └ https: tls.connect({host, port, servername, ca?})   ← 默认校验证书
        ↓
sendConnect(socket, authority)   ← http.request({ createConnection: () => socket })
        ↓
openTunnel() 返回裸 socket（TLS 由调用方按目标域名叠加）
```

- 证书校验：`tls.connect` 不传 `rejectUnauthorized`，走默认 `true`；`TunnelOptions`
  只有 `ca` 字段，**没有**关闭校验的通道。
- `Proxy-Authorization` 只出现在 CONNECT 请求头里，不会进入隧道（测试断言目标侧
  只收到业务字节）。
- CONNECT 目标仍是调用方校验过的 **pinned IP**；`connectAuthority()` 负责 IPv6 方括号。
- 失败不静默：连不上/被拒/握手失败都抛错，`openTunnel` 不会退回直连。

### 测试

| 用例 | 判据 |
|---|---|
| HTTPS 代理完成 TLS 后再发 CONNECT | 代理侧 `seen === ["93.184.216.34:443"]` |
| 自签名证书默认被拒 | `rejects.toThrow(/certificate|self-signed/i)`，且 `seen` 为空、目标 0 连接 |
| 代理凭据只发给代理 | 代理收到 `Basic base64(alice:s3cret)`；echo 目标只收到 `ping` |
| IPv6 authority | `CONNECT [::1]:443`；已带方括号不重复加 |
| 代理拒绝不回退 | 502 → 抛错，目标服务器 `connections === 0` |
| 明文目标 + HTTPS 代理 | 明确抛错，不发明文 |

**与既有实现的兼容**：`createProxyFetch` 仍调用 `openTunnel(proxy, target)`（三参），
HTTPS 代理因此自动获得正确行为；Provider 的 HTTP 代理用例保持原样通过。

---

## 4. R1-2：DNS 总超时

### 根因

`await deps.resolve(...)` 之后才检查耗时。DNS Promise 一直 pending 时，代码永远停在
await 上——总预算形同虚设。

### 修复

```ts
const startedAt = deps.monotonic();               // performance.now()
const resolved = await withDeadline(deps.resolve(host), budget);
// timeout → transient timeout（不发请求）
// error   → transient dns_failure
const remaining = budget - (deps.monotonic() - startedAt);
if (remaining <= 0) return transient("timeout", ...);
// request 拿 remaining，connectTimeout = min(3s, remaining)
```

`withDeadline` 的两条纪律：

```ts
const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({kind:"timeout"}), ms); });
const settled = work.then(v => ({kind:"value", v}), e => ({kind:"error", e}));   // 永不 reject
return await Promise.race([settled, timeout]);   // 两边都不抛 → 无 unhandledRejection
```

- 定时器在 `finally` 里清理；`Math.max(0, ms)` 防负数。
- 迟到的 resolve/reject 被 `settled` 吸收，既不会继续发请求，也不会变成未处理拒绝。

### 测试（7 条）

| 用例 | 判据 |
|---|---|
| DNS 在预算内完成 | 继续抓取，`request` 调用一次 |
| DNS 永不返回 | 40ms 预算内返回 `transient/timeout`，`request` 未调用 |
| 超时后迟到 resolve | 再等 30ms，`request` 仍未调用 |
| 超时后迟到 reject | `process.on("unhandledRejection")` 未收到任何东西 |
| 扣除 DNS 后的剩余时间 | `clock=[0,1200]` → `totalTimeoutMs=3800`、`connectTimeoutMs=3000` |
| 剩余时间小于连接超时 | `clock=[0,4600]` → 两者都是 400 |
| 恰好用满预算 | `clock=[0,5000]` → timeout 且不发请求 |

---

## 5. R1-3：IPv6 全球单播白名单

### 根因

只靠 RFC 6890 黑名单。`4000::1`、`c000::1` 这类**整段都没分配**的地址不在黑名单里，
于是被判为「可访问」。

### 修复

```ts
const GLOBAL_UNICAST_V6 = new net.BlockList();
GLOBAL_UNICAST_V6.addSubnet("2000::", 3, "ipv6");   // IANA IPv6 Address Space Registry

if (IPV4_MAPPED.check(bare, "ipv6")) return false;         // 映射地址一律拒绝
if (!GLOBAL_UNICAST_V6.check(bare, "ipv6")) return false;  // 白名单
return !BLOCKED.check(bare, "ipv6");                        // 再排特殊用途
```

- IPv4 主 BlockList 未动；`::ffff:0:0/96` 仍在**独立**表里（放进同一张表会把
  `8.8.8.8` 也判成私有——BlockList 内部以映射形式存 v4）。
- 分类失败（`net.isIP` 返回 0）仍然返回 `false`，不默认放行。
- DNS 结果全量校验、IP 字面量走同一套逻辑，两者都未变。

### 测试

`4000::1` / `6000::1` / `8000::1` / `a000::1` / `c000::1` / `e000::1` / `f000::1`
各两条（直接分类 + 解析后拒绝整个目标），加正向 `2000::1` / `2001:4860:4860::8888` /
`3fff:ffff::1`（避开 `3fff::/20` 文档段）。

---

## 6. R1-4：HTTP 状态分类

### 根因

`status !== 200 → terminal`。503 / 429 / 408 是**临时**故障，被记成「客户端元数据
失效」，等于允许调用方因为一次限流就作废缓存与 refresh token。

### 修复

| 类 | 状态码 |
|---|---|
| `transient` | 408、425、429、所有 5xx |
| `terminal` | 3xx（不跟随）、其它 4xx、2xx 中除 200（201/204 不是 CIMD 文档） |
| `ok` | 仅 200 |

只有 `ok` 会进入 Content-Type 检查与 JSON 解析。错误响应依旧不产生 `cacheExpiresAt`。

### 测试

`classifyHttpStatus` 表驱动（9 个 transient / 14 个 terminal），加上 503 走完整抓取
得到 `transient/http_status`、`{503,429,408}` 无缓存结果、3xx 只调用一次 transport
且不使用 `Location`。

---

## 7. R1-5：5 KiB 流式读取的可证明性

### 根因

C3c-2 的 `BodySizeLimiter` 单测只证明「计数器正确」，没有证明**真实读取路径**会在
超限时停手。

### 修复

把响应处理整体抽成可注入形状：

```
requestPinnedHttps().onResponse
  └ readPinnedResponse(response, max)
       ├ Content-Length 预检超限 → destroy() + bodyTooLarge（不挂 data 监听）
       └ readResponseBody(stream, max)
            ├ 每块 push → 超限立即 stream.destroy()，返回空 body + bodyTooLarge
            └ 正常结束 → 拼接 buffer
```

`readResponseBody` 超限时返回**空 body**，上层不可能拿半截 JSON 去解析。

### 测试（11 条）

| 用例 | 判据 |
|---|---|
| 恰好 5120 | 通过，`bytesRead === 5120` |
| 5121（单块） | 失败 + `destroyedEarly` + `body.byteLength === 0` |
| 分块 3×3000 | `bytesRead === 6000`（第三块没被读） |
| 无 Content-Length | 4K+4K 仍被拒绝 |
| byteLength 而非 length | 2048 个三字节字符 → `bytesRead === 6144` |
| **超限停止消费** | 按需生产的源在超限后 `_read` 不再被调用（`produced` 冻结且 < 50） |
| 流错误 | 向上抛，不算「读完」 |
| CL 预检 | `dataListeners === 0`（没开始读） |
| CL 低报 | 声明 10 字节、实际 6000 → 仍拒绝 |
| 无 CL 走累计 | 2048 字节正常返回 |
| 合法响应 | status / headers / body 原样带出 |

> 该用例是本轮唯一「第一版没抓住」的判据：最初只断言 `stream.destroyed === true`，
> 而 `Readable.from` 在读完时会**自动** destroy，`destroyed` 分不出「我们主动销毁」
> 和「它自己读完了」。改成按需生产的源 + 计数上界之后，变异才被抓到（见 §8 M5）。

---

## 8. 变异测试（5/5 被抓）

| 变异 | 命中用例 |
|---|---|
| **M1** 删除 DNS 截止时间（改回 `await settled`） | `DNS 永不返回 → 必须在预算内返回 transient timeout`、`DNS 超时后迟到 resolve`、`DNS 超时后迟到 reject`（三条超时） |
| **M2** HTTPS 代理改用明文连接（`const secure = false`） | `先与代理完成 TLS 握手，再发 CONNECT`、`自签名证书默认被拒绝，且不会退回直连` |
| **M3** 删除 IPv6 全球单播限制 | `4000::1 … f000::1` 七条分类 + 七条「解析后拒绝整个目标」（14 红） |
| **M4** 把 5xx 判成 terminal | `500/501/502/503/504/599 是 transient` + `503 不再被当成「客户端元数据失效」`（7 红） |
| **M5** 删除超限后的即时 `destroy()` | `超限后立即停止消费：不再向数据源请求更多字节` |

变异脚本用完即还原生产代码（脚本 `finally` 回写原文），未留在仓库里。

---

## 9. 门禁（实际执行）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过（0 error / 0 warning） |
| `pnpm build` | 通过 |
| `pnpm test` | **1333 passed / 65 files**（基线 1264，+69） |

Desktop（未改其代码，按要求回归）：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `test` / `build` / `mcp:build` | 通过；**1265 passed / 89 files**；`stdio.mjs` 911.67 kB 不变 |

**一次偶发**：首轮全量 `authorize-route.test.ts > 合法请求：302 到登录页` 报
`expected 600001 to be less than or equal to 600000`——`mcp_auth_requests` 的 TTL 断言
在并发负载下差了 1ms。该文件与本次改动无交集，单跑通过，重跑全量通过。**未修改该断言**
（不改预期值掩盖问题），只在此记录。

---

## 10. 未完成 / 仍然存在的风险

1. **真实目标 TLS 路径没有端到端测试**。R1-5 覆盖的是响应读取；`requestPinnedHttps`
   的目标侧握手仍只有代码审查。要端到端验证需要一个受信任的测试证书与 443 端口，
   本轮没有为此放宽端口限制。
2. **`openTunnel` 的 `ca` 参数是测试接缝**，语义上等价于「私有 CA」能力。生产调用方
   不传；没有任何关闭校验的入口。若复审认为不应存在这个参数，可改为仅测试可见的注入
   方式（代价是 HTTPS 代理成功路径失去自动化覆盖）。
3. **`createProxyFetch` 的明文分支**只加了「https 代理 + http 目标 → 抛错」守卫；
   该组合在 Provider 通道不可达（Provider 全是 https），因此没有做完整实现。
4. **DNS 超时使用的是 `setTimeout`**：进程被长时间阻塞（同步长任务）时定时器会推迟，
   预算可能被拉长。这是 Node 定时器的固有特性，不引入 worker 无法根治。
5. **CIMD 仍未接入 authorize**：`client_id_metadata_document_supported` 依然不声明，
   DCR 仍关闭，本次没有新增任何对外能力。

---

## 11. 是否建议进入下一阶段

建议进入 **C3c-2-R2 复审**（而不是直接接入授权）。理由是：本轮的
SSRF / Pinning / 超时 / 状态分类已具备可执行判据，但「接入 authorize」还会引入
缓存写入、失败处置（是否作废 refresh token）与并发抓取，属于新的攻击面，应单独一轮。
