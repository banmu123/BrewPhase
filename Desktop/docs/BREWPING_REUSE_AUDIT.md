# BrewPing 复用审计

> 结论先行：BrewPing 的**连接、发现、配对、鉴权**四块经验直接沿用；
> 它的 Agent 业务协议、中继与 TLS 规划不搬。BrewPhase 的差异在数据面，
> 不在安全面。

依据：本机源码 `/Users/banmu/BrewPing`（`Sources/App/*` 与 `ios/BrewPing/*`）。
以下区分「已实现（有代码为证）」与「仅规划（文档里说了、代码里没有）」。

## 1. 直接沿用的设计（已验证）

### 1.1 配对码与限速（`Sources/App/PairingStore.swift`，360 行，全量可沿用）

| BrewPing 实现 | BrewPhase 采纳 |
|---|---|
| 一次性配对码 + 有效期，兑换后立即作废 | 沿用；有效期按 Phase 2 任务书改为 **2 分钟**（BrewPing 是 10 分钟） |
| 恒定时间比较（逐字节 XOR 累积），避免前缀泄露 | 原样移植（Node 用 `crypto.timingSafeEqual`） |
| 双维限速：单来源 5 次/5 分钟 + 全局 30 次/5 分钟，冷却 60s，来源有界（256，LRU） | 原样移植；「码错不计数」的细节（无码可兑时不推进计数）也保留 |
| nonce 记忆有界（2048，过期清理 + 淘汰最旧一半） | 原样移植 |
| 只读 GET 不校验 nonce（重放无害） | 沿用，但**快照/媒体上传全是写操作**，全部要求 timestamp+nonce |

BrewPhase 差异点：**每台设备独立 Token**（BrewPing 是单 Token 全局共用）。
服务端存 `sha256(token)`，撤销 = 删除该设备行；配对成功即发新 token。

### 1.2 服务生命周期与端口（`HTTPServer.swift`）

- 首选端口被占 → 顺延重试（BrewPing 依次尝试首选端口与临时端口）；
  BrewPhase 首选 **47821**，占用则交给 OS 分配，并把**实际端口**回填到二维码。
- 绑定真实 LAN 接口而不是 0.0.0.0 裸奔（BrewPing 用 NWInterface 过滤；
  Node 侧用 `os.networkInterfaces()` 取 IPv4 非 internal 地址逐一 `server.listen(port, addr)`）。
- 明确的 start/stop 状态机 + 错误回调；服务只在用户启用同步时启动。
- **请求体大小限制**（BrewPing 有上限；BrewPhase 快照按批限 4MB、媒体块 256KB）。

### 1.3 Bonjour（`BonjourAdvertiser.swift`）

- BrewPing 用 `NetService` 发布 `_brewping._tcp`，TXT 带 deviceId/port；
  iOS 用 `NWBrowser` 发现（它注释里明确记录了「NetService.resolve 已废弃」的坑）。
- BrewPhase：服务类型 `_brewphase._tcp`，TXT 带 `deviceId/deviceName/protocolVersion/port`。
- **第一版实现取舍**：二维码本身携带 `host:port` 直连信息（BrewPing 的码也带），
  Bonjour 作为增强项后置——iOS 端先不引入 NWBrowser，避免发现失败阻塞主链路。
  协议头与 TXT 字段现在就定义好，后续补发布端与发现端不破坏协议。

### 1.4 QR 深链与扫码分层（iOS 侧，`PairingURLHandler.swift` 等）

BrewPing 最重要的教训写在注释里：**扫码与外链两处各写一份解析 → 读的字段不一致**
（Windows 码被存成 Mac）。BrewPhase 从第一天起：

- 扫码组件（AVFoundation）**只返回字符串**；
- `brewphase://pair?...` 的解析只有 `SyncPairingLink.parse` 一处；
- 真正的网络配对只有 `SyncPairingManager` 一处。
- 深链字段：`host/port/deviceId/deviceName/pairingCode/protocolVersion/expiresAt`
  （不复用 `brewping://`，不带 osType——桌面端只有 Electron 一种）。

### 1.5 Keychain（`KeychainStore.swift`）

- 通用密码项 + service 隔离 + `kSecAttrAccount`；BrewPhase 沿用同一结构，
  service 用 `com.brewphase.ios.sync`；Token 与受信设备 ID 只进 Keychain，
  UserDefaults 只放非敏感的基线指纹与设备名。

## 2. 已规划但**未实现**、暂不依赖的部分

| BrewPing 文档项 | 现状 | BrewPhase 处理 |
|---|---|---|
| TLS 传输加密（`docs/design/BrewPing-安全传输方案.md`） | **未落地**，现行是明文 HTTP + Bearer/时间戳/nonce | 第一版同为 HTTP（局域网 + 一次性码 + 独立 token + 重放防护）；协议里保留 `serverCertificateFingerprint` 字段，TLS 落地后两端同时升级 |
| Ed25519 身份公钥 | 结构存在，**没有真实校验逻辑** | 本版不携带公钥字段（任务书要求：不能只有数据没有作用）；身份=配对码换来的 token |
| Windows 端 | BrewPing 已支持 | BrewPhase 桌面端当前 Electron 即可跨平台，无需分叉 |

## 3. 明确不搬的部分

- `/api/message`、Agent 命令、Approval、RelayBridge、云端中继——业务完全不同，
  且「同步接口能执行命令」是反模式。BrewPhase 接口面只有：
  Pair / Status / Sync Manifest / Sync Snapshot / Media / Devices。
- `NetService`/`NWListener` 的 Swift 实现——Electron 用 Node `http` 模块重写，
  只移植生命周期与端口策略。
- 单 Token 全局模型——升级为每设备独立 Token。

## 4. BrewPhase 新增的安全面（相对 BrewPing 的增强）

1. **每设备独立 Token + 服务端只存哈希**（可撤销、不可逆）。
2. 配对码从「数字码」升级为 **URL 内 128-bit 高熵凭据**（码不落库明文，存 SHA-256）。
3. 写操作 HMAC-SHA256 签名（`token + timestamp + nonce + bodyHash`），
   防「同网段只读嗅探后重放写请求」；GET 仍只需 Bearer。
4. 数据库持久化的设备表与撤销位（BrewPing 的 token 在文件里，撤销=换文件）。

## 5. BrewPhase 同步协议（新，不复用 BrewPing 业务协议）

```
POST /api/pair                      { pairingCode, deviceName }        → { token, deviceId, protocolVersion }
GET  /api/status                    （无鉴权健康检查）                  → { service, protocolVersion }
GET  /api/sync/manifest             （Bearer）                         → 各实体计数 + 现有媒体清单摘要
POST /api/sync/apply                （Bearer+TS+Nonce+HMAC）           → upsert/delete 批量合并结果
POST /api/sync/media/manifest       （Bearer+TS+Nonce）                → 目标端缺失媒体清单
PUT  /api/sync/media/chunk          （Bearer+TS+Nonce）                → 分块追加（256KB，块序号+偏移）
POST /api/sync/media/finalize       （Bearer+TS+Nonce）                → 整文件 SHA-256 校验 + 原子落位
GET  /api/devices（本地 IPC 专用，不走网络）
```

详细字段见 `Desktop/docs/SYNC_PROTOCOL.md`（本版同步更新至 v2）。
