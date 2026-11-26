# BrewPhase Phase 1.3.1-C3c-2-R2v — 复核缺陷修复报告

> 日期：2026-11-19 · 分支：`feature/remote-mcp` · 审查基线 `502cbe7`
> 对应复审：`docs/reviews/phase-1.3.1-c3c-2-r2v-security-verification.md`（§3 F9/F10/F11）
> 范围：只修复核确认的缺陷与覆盖缺口；不接入 authorize、不做 DCR、不加迁移与依赖、
> 不改 Desktop 生产代码。

---

## 1. 修改文件清单

| 文件 | 变更 | 对应发现 |
|---|---|---|
| `cloud/src/net/proxy-fetch.ts` | +18/−2：TLS 握手窗口的 abort 覆盖（onAbort/settle/handshaking 单次回调） | F9 |
| `cloud/tests/net/proxy-fetch.test.ts` | +2 条用例（F9 泄漏清理、F11 altname 分离）；3 条直连用例补 `env: {}`（F10） | F9 / F10 / F11 |
| `cloud/docs/reviews/…-r2v-security-verification.md` | 新增 | — |
| 本文件 | 新增 | — |

---

## 2. 逐项修复

### F9 · 总超时后「TLS 握手窗口」的代理 socket 无人清理（Medium）

**改法**（`requestPinnedHttps` 代理分支的 `createConnection`）：

```
openTunnel resolve → tls.connect({ socket, servername, ca })   ← 此前无 abort 覆盖
  onAbort: secure.destroy() + socket.destroy() + settle(abort)
  settle:  移除监听 → handshaking=false → callback 一次
  controller.signal.aborted 预检兜底
```

- `handshaking` 标志统一 error / secureConnect / abort 三个事件的 settle 竞态；
- abort 时主动回调（错误），保证 agent 的 `createConnection` 契约（callback 必达）；
- 隧道 socket 与 TLSSocket 都销毁（幂等）。

**证据**

| 项 | 修复前（探针） | 修复后（测试断言） |
|---|---|---|
| 黑洞 TLS 目标侧 `getConnections()`（超时后 500ms） | 1 | 0 |
| 客户端/服务端 socket 状态 | ALIVE | 全部 `destroyed` |

测试：`总超时会销毁仍在 TLS 握手中的代理隧道（目标侧吞掉 ClientHello 也不泄漏）`；
变异 M13（移除该 abort）被该用例捕获。

### F10 · 直连测试未隔离代理环境变量（Medium，测试缺陷）

**改法**：3 条直连用例（SNI/Host、目标证书拒绝、慢速响应体）显式 `env: {}`，
并在首条加注释说明「env 缺省是 process.env，配了 HTTPS_PROXY 的机器会把直连
测试偷换成经系统代理」。

**证据**：第一轮变异 M4a/M5a 逃逸（GREEN）→ 修复后重放均 RED；
`tls.connect` 实参探针（修复前）显示 `{ socket, servername }` 隧道形态，证明
「直连」用例实际走了系统代理。

### F11 · 代理路径目标 TLS 校验无覆盖（Low，覆盖缺口）

**改法**：新增用例，利用测试证书 SAN（`DNS:localhost` + `IP:127.0.0.1`）构造
「代理跳按 IP SAN 成功、目标跳按 `other.example.com` 域名校验必须失败」的分离
场景，并断言 CONNECT 已发出、目标响应从未被接收。

**证据**：变异 M4b（隧道内 `tls.connect` 加 `rejectUnauthorized: false`）被
捕获（RED）；HEAD 源码下该用例为绿（生产行为正确，此前只是没测）。

---

## 3. 变异验证

两轮共 15 条（任务书 12 条按直连/代理拆分）：第一轮 13/15（M4a/M5a 逃逸 →
根因即 F10）；修复后第二轮 **15/15**。逐条对照表见复审报告 §4。

---

## 4. 门禁

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `lint` / `build` | 通过 |
| `pnpm test` | **1357 passed / 65 files**（基线 1355，+2） |

Desktop：`typecheck` / `test` / `build` / `mcp:build` 通过，`stdio.mjs`
911.67 kB 不变（未改 Desktop 代码）。

---

## 5. 未做的事

- 未接入 authorize / DCR，未声明 `client_id_metadata_document_supported`。
- 未新增迁移与依赖；未给代理 DNS 加注入点；未给目标 TLS 握手加独立阶段定时器
  （总预算 + F9 abort 已覆盖清理语义）。
- 未动 `createProxyFetch`（Provider 通道）的 abort 语义——那是 C3c-2 范围之外
  的旧通道，行为由其自身测试约束。
