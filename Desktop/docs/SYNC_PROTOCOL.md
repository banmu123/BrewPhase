# BrewPhase 同步协议 v2（iOS → Desktop，局域网，已实现）

> v1 只有结构没有实现；**v2 起为已落地的传输协议**。安全模型沿用
> BrewPing 已验证的设计（见 `BREWPING_REUSE_AUDIT.md`），数据语义见
> `FEATURE_PARITY_AUDIT.md`。

## 0. 总则

- 方向：第一版 **iOS → Desktop** 单向；协议字段为未来双向预留
  （`originDeviceId` / `revision` / tombstone）。
- 传输：局域网 HTTP（端口首选 **47821**，被占自动回落并把实际端口写进二维码）。
  **TLS 是下一跳**：协议字段 `certificateFingerprint` 已预留，落地后两端同时升级。
  当前防护 = 一次性高熵配对码 + 每设备独立 Token（服务端只存 SHA-256）+
  时间戳/nonce/HMAC 防重放；威胁模型与 BrewPing 现行版本一致。
- 发现：二维码直连（`host`/`hosts` 候选）。Bonjour（`_brewphase._tcp`）作为
  增强项后置，TXT 约定：`deviceId/deviceName/protocolVersion/port`。

## 1. 配对

1. 桌面端「连接新手机」→ 生成 12 位高熵码（仅存 SHA-256），**2 分钟有效、一次性**；
   二维码 = `brewphase://pair?host=&hosts=&port=&deviceId=&deviceName=&pairingCode=&protocolVersion=1&expiresAt=`。
2. iOS 扫码（AVFoundation；解析只有 `SyncPairingLink.parse` 一处）→
   `POST /api/pair {pairingCode, deviceName}`。
3. 校验（恒定时间比较 + 双维限速：单源 5 次/5 分钟、全局 30 次/5 分钟、冷却 60s、
   「无码可兑不计数」）→ 签发 32 字节 Token：桌面端存哈希进 `devices` 表，
   iOS 存 Keychain；**码立即作废**。
4. 响应：`{token, deviceId, desktopDeviceId, desktopDeviceName, protocolVersion}`。

## 2. 请求鉴权

| 项 | 规则 |
|---|---|
| 身份 | `Authorization: Bearer <token>`（服务端 `sha256(token)` 查 `devices`，`revoked_at` 非空拒绝） |
| 读（GET） | 仅 Bearer（重放无害，同 BrewPing） |
| 写（POST） | 额外 `x-bp-timestamp`（ms，窗口 ±120s）+ `x-bp-nonce`（有界去重 2048）+ `x-bp-signature = HMAC-SHA256(token, timestamp \n nonce \n sha256(body))` |

## 3. 接口

| 路由 | 说明 |
|---|---|
| `GET /api/status` | 无鉴权健康检查 `{service, protocolVersion}` |
| `GET /api/sync/manifest` | 各实体计数（导入前预检查） |
| `POST /api/sync/apply` | 批量合并（见 §4），返回 `{appliedCount, skippedCount, conflictCount, failedItems[]}` |
| `POST /api/sync/media/manifest` | 清单比对 → `{missing[], have[], rejected[]}` |
| `POST /api/sync/media/chunk?name=&offset=` | 256KB 分块追加；offset 必须等于已收字节数（断点续传查询 `GET /api/sync/media/offset`） |
| `POST /api/sync/media/finalize` | 整文件 SHA-256 校验 → 原子落位；失败清理临时文件 |

## 4. 合并语义（非破坏性）

对每条 upsert（id + fingerprint + payload）：

| 桌面端状态 | 动作 |
|---|---|
| 行不存在 | 插入（`created_at/updated_at` 缺省补 now），记基线指纹 |
| 本地指纹 == 来端指纹 | 跳过（幂等：重复同步不重复插入、不重复扣库存） |
| 基线存在且基线 == 本地指纹 | 桌面端没改过 → 接受 iOS 覆盖 |
| 基线存在且基线 == 来端指纹 | iOS 没改、桌面端改了 → **冲突**，保留本地 |
| 其余（两端都改 / 无基线） | **冲突**，保留本地 |

- 冲突落 `sync_conflicts`（双方指纹 + 远端 payload），设置页可裁决
  「保留电脑版本 / 接受手机版本」；未裁决不影响其他数据。
- 删除（tombstone）：行存在 → 删除 + 清基线（外键级联随之）；不存在 → skipped。
- 引用缺失（如 brew 指向不存在的 bean）→ `failedItems` 带原因，**不静默丢弃**，
  也不让单条失败拖垮整批。
- **PhaseRule 特例**：按 `roastLevel` 匹配既有规则原位更新（两端默认规则 UUID
  各自生成），同一烘焙度只保留一份有效规则。
- 整批一个事务；事务失败整批回滚并报告。

## 5. 指纹（两端同规则）

`SHA-256(规范串)`；规范串 = 固定字段序 + `\u{1F}` 分隔；字符串原样、`nil` → `~`、
布尔 → `true/false`、数字 → 最多 6 位小数去尾零（跨语言 `1` ≡ `1.0`）。
**不含时间戳**（防 iOS 触碰 updatedAt 造成假变更）。字段序见
`snapshot-importer.ts localFingerprint` 与 `SyncSnapshotBuilder.swift`，两处互为镜像，
改一处必须改另一处并同步测试。

## 6. 媒体

- 清单项：`{name, sha256, byteSize, mediaType, mimeType}`；mimeType 按扩展名 +
  iOS 侧真实字节判定；视频（mov/mp4/m4v）由 **MediaStore 单独枚举**，
  不依赖 iOS 备份的 JPG 附件清单。
- 名字沿用 iOS 存储名，桌面端 `isSafeMediaName` + 扩展名白名单双重校验。
- 分块 256KB；块级追加校验偏移、整文件校验 SHA-256；临时区 `.incoming` →
  校验通过原子 rename 进媒体目录；失败清临时文件。
- 桌面端第一版**完整保存视频文件**（不丢弃），界面先展示封面与信息。

## 7. 游标语义（区分）

- `change_log.seq`：桌面端全局变更流水（未来双向拉取的游标）。
- `sync_baseline`（entity_type, entity_id → fingerprint）：**本方向**的去重基线。
- 两者不可混用；本版 iOS 端基线存 UserDefaults（非敏感），桌面端基线入库。

## 8. 时间

全部 **epoch 毫秒**。iOS `Date` 转换带防御：秒值（< 1e11）自动 ×1000。
业务 UUID 原样保留，禁止重新生成。
