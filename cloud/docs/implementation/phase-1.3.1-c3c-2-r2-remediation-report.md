# BrewPhase Phase 1.3.1-C3c-2-R2 — 复审缺陷修复报告

> 日期：2026-11-19 · 分支：`feature/remote-mcp` · 复审基线 `92148bf`
> 对应复审：`docs/reviews/phase-1.3.1-c3c-2-r2-security-review.md`
> 范围：只修复审确认的缺陷（F1–F7）与一个验证缺口（F8）；不接入 authorize、
> 不做 DCR、不加迁移与依赖、不改 Desktop 生产代码。

---

## 1. 修改文件清单

| 文件 | 变更 | 对应发现 |
|---|---|---|
| `cloud/src/net/proxy-fetch.ts` | +96/−14：`TunnelOptions.signal`、`openTunnel` 全窗口 abort、`connectToProxy` 单次 settle、`sendConnect` 专用 agent、`PinnedRequestOptions.ca`、代理跳 TLS 透传 `ca` | F1 / F5 / F8 |
| `cloud/src/mcp-oauth/cimd.ts` | +67/−6：`oth`、`MAX_URL_LENGTH` / `MAX_CLIENT_NAME_LENGTH`、`validateInformationalUri`、4 段地址、resolver 同步抛错兜底 | F2 / F3 / F4 / F6 / F7 |
| `cloud/tests/net/proxy-fetch.test.ts` | +280：端到端 TLS 5 条、阶段超时 3 条 | F1 / F8 / 回归 |
| `cloud/tests/mcp-oauth/cimd.test.ts` | +87：文档边界 6 条、地址段 4 条 | F2–F4 / F6 / F7 |
| `cloud/docs/reviews/…-r2-security-review.md` | 新增 | — |
| `cloud/docs/implementation/…-r1-cimd-hardening-report.md` | 修正过期基线表述（F11） | — |

---

## 2. 逐项修复

### F1 · 总超时后代理 socket 未清理（Medium）

**改法**

```
requestPinnedHttps
  └ totalTimer: controller.abort() → finish(timeout)
        ↓ signal 透传
openTunnel(proxy, target, timeoutMs, { ca, signal })
  ├ 连接阶段：connectToProxy 监听 abort → socket.destroy()
  └ CONNECT 阶段：openTunnel 自己监听 abort → socket.destroy()
       （socket 在 sendConnect 等待 200 时仍不属于任何 request）
```

- `connectToProxy` 与 `openTunnel` 都改成**单次 settle**：error / close / abort 竞争
  时只认第一个，避免重复 reject 与重复销毁。
- `finally` 里移除 abort 监听：隧道交出去之后由 request 负责。

**证据**

| 项 | 修复前 | 修复后 |
|---|---|---|
| `server.getConnections()`（超时后 500ms） | 1 | 0 |
| 服务端 socket `destroyed` | false | true |

测试：`总超时会销毁仍在建连的代理 socket（不会挂在后台）`。

---

### F2 · JWK `oth`（Medium）

```diff
-const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"] as const;
+const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;
```

测试：`每个 JWK 私钥成员都被拒绝（RFC 7518 §6.2.2 含 oth）`——8 个成员逐个覆盖，
另加一条「只有公钥字段的 jwks 允许」。

---

### F3 · `client_uri` / `logo_uri` 形态（Medium）

新增 `validateInformationalUri()`：绝对 URL、https、无 userinfo、≤2048 字节。
字段存在但非法 → **文档非法**（`terminal/document`），不静默丢弃。

测试（5 反例 + 1 正例）：

| 输入 | 结果 |
|---|---|
| `client_uri: "javascript:alert(1)"` | 拒绝（不是 https） |
| `client_uri: "http://…"` | 拒绝（不是 https） |
| `logo_uri: "https://user@cdn…"` | 拒绝（userinfo） |
| `logo_uri: "https://cdn…/<2100 字符>"` | 拒绝（超长） |
| `logo_uri: 42` | 拒绝（非字符串） |
| 两个字段都是合法 https | 保留在 metadata 里 |

---

### F4 · RFC 6890 补 4 段（Low）

```diff
+  ["192.31.196.0", 24],  // AS112-v4
+  ["192.52.193.0", 24],  // AMT
+  ["192.175.48.0", 24],  // AS112 direct delegation
...
+  ["2620:4f:8000::", 48], // AS112-v6
```

测试：阻塞表各加一条，并复用到「解析到该地址时拒绝整个目标」的 `it.each`。

---

### F5 · `sendConnect` 专用 agent（Low）

```diff
-const request = http.request({ method: "CONNECT", path, headers, createConnection: () => socket });
+const agent = new http.Agent({ keepAlive: false });
+(agent as …).createConnection = () => socket;
+const request = http.request({ method: "CONNECT", path, headers, agent });
```

理由：不指定 agent 会走 `http.globalAgent`，其池名来自 options 的 host/port
（默认 `localhost:80`）。池里若恰有同名空闲 keep-alive socket，请求会被复用到
那条无关连接上。专用 agent 把「用哪条 socket」变成确定事实。失败时 `agent.destroy()`。

回归：所有 CONNECT 用例（HTTP/HTTPS 代理、IPv6 authority、凭据隔离、端到端）保持通过。

---

### F6 · resolver 同步抛错（Low）

```diff
-const resolved = await withDeadline(deps.resolve(url.hostname), budget);
+let resolving: Promise<CimdAddress[]>;
+try { resolving = deps.resolve(url.hostname); }
+catch (error) { return transient("dns_failure", describe(error)); }
+const resolved = await withDeadline(resolving, budget);
```

测试：`resolver 同步抛错也不会让抓取器抛出`。

---

### F7 · 长度上限（Low，项目策略）

`client_id` ≤ 2048、`client_name` ≤ 256。测试：`client_name 与 client_id 有长度上限`。

---

### F8 · 目标侧 TLS 端到端证明（验证缺口）

`PinnedRequestOptions` 增加 `ca`（**只增信任锚**，没有 `rejectUnauthorized`）。
同时修了一个由此暴露的真实缺陷：代理模式下隧道之上的 `tls.connect` 原本**没有**
带上 `ca`，即目标信任锚在代理路径上被丢掉。

新增 5 条测试（详见复审报告 §3 R2-F8）。

---

### F11 · 文档过期表述

R1 报告第 1 节补「提交链路」表：C3c-2 起始基线 `139731f` / R1 代码 `cb2e68c` /
R1 文档 `92148bf` / R2 审查基线 `92148bf`。

---

## 3. 变异验证（12/12）

完整对照表见复审报告 §6。这里只记两条与本轮修复直接相关的：

| 变异 | 命中 |
|---|---|
| M12 总超时不清理在建连 socket | `总超时会销毁仍在建连的代理 socket` |
| M8 JWK 去掉 `oth` | `每个 JWK 私钥成员都被拒绝` |

---

## 4. 门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `lint` / `build` | 通过 |
| `pnpm test` | **1355 passed / 65 files**（基线 1333，+22） |

Desktop：`typecheck` / `test` / `build` / `mcp:build` 通过，1265 passed / 89 files，
`stdio.mjs` 911.67 kB 不变。

---

## 5. 未做的事

- 未接入 authorize / DCR，未声明 `client_id_metadata_document_supported`。
- 未新增数据库迁移与依赖。
- 未给代理 DNS 查询加注入点（见复审报告 §5）。
- 未给目标 TLS 握手加独立阶段定时器（总预算已覆盖）。
