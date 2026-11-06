# 局域网同步协议 v1（草案，仅结构）

> 本阶段只定义协议与类型（`src/shared/contracts/sync`），**没有实现服务端**。
> 不要把它当成「已经能同步」——界面与文档都必须保持这个口径。

## 1. 拓扑

Desktop 是 **Host**，iOS 是配对客户端。不依赖云、不需要账号、不上传第三方。

## 2. 配对流程

1. Desktop 启动本地 HTTP 服务（默认端口 47821），用 Bonjour `_brewphase._tcp` 广播。
2. 用户点「配对」→ 生成一次性配对码（6 位，2 分钟有效，服务端只存哈希）。
3. 二维码内容 = `PairingPayload`：`{v, host, port, deviceId, deviceName, pairingCode, expiresAt}`。
4. iOS 扫码（mDNS 失败时手输 IP:端口）→ `POST /v1/pair`，带 `PairRequest`
   （配对码 + 客户端 deviceId + 名称 + Ed25519 公钥）。
5. 服务端校验码未过期、未使用 → 生成 `accessToken`（随机 32 字节，只存哈希），
   返回 `PairResponse`；客户端存钥匙串。配对码立即作废。

## 3. 每个请求的认证

```
Authorization: Bearer <token>
X-Device-Id: <clientDeviceId>
X-Timestamp: <unix ms>
X-Nonce: <16+ 字节随机>
X-Signature: HMAC-SHA256(token, method + path + timestamp + nonce + bodySha256)
```

- 时间窗 ±5 分钟；`(deviceId, nonce)` 在窗口内去重（防重放）。
- token 可撤销：`devices.revoked_at` 非空即拒绝。

## 4. 数据交换

| 接口 | 作用 |
| --- | --- |
| `GET /v1/snapshot?since=<revision>` | 增量快照：`SnapshotFrame`（实体 JSON + 媒体清单） |
| `GET /v1/media/<sha256>?offset=&length=` | 媒体按块下载（256KB/块），逐块 SHA-256 |
| `POST /v1/changes` | 客户端上报本地 change log 批次 |

- 实体以 `EntityType` + `entityId` 标识；每条的 `revision` 单调递增。
- 删除用 **tombstone**（`deletedAt`），不是「查不到」。
- 媒体以文件名的 SHA-256 为内容地址；重复文件只传一次。

## 5. 冲突处理

同一实体两端都改过（两边 revision 都 > 上次同步点）时**不静默覆盖**：

1. 服务端返回 `Conflict`（两端 revision 与 modifiedAt）；
2. 客户端可选择 `keepLocal / keepRemote / mergeLater`；
3. `mergeLater` 保留两份草稿，等用户在界面上决定。

Phase 2 只做前两步；「字段级自动合并」不在计划内——那需要每个字段的语义，
不是通用算法能解决的。

## 6. 明确不做

- 不做云中转，不做跨网段穿透；
- 不传整个 SQLite 文件（会把两端的 schema 绑死）；
- 不把 iOS 的系统通知 identifier 传过来（各端自己重建本地通知）；
- 不同步 `EmbeddingRecord` 等派生索引。
