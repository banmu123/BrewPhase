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

1. 桌面端「连接新手机」→ 生成 **128-bit 高熵码**（`randomBytes(16)`，base64url
   22 字符；仅存 SHA-256，服务端不留明文），**2 分钟有效、一次性**；
   二维码 = `brewphase://pair?host=&hosts=&port=&deviceId=&deviceName=&pairingCode=&protocolVersion=1&expiresAt=`。
   `hosts` 携带全部实际可达的局域网地址（多网卡；物理网卡 en* 优先，
   VPN/容器虚拟网卡降权）。明文只在生成时返回一次、由设置页界面状态持有；
   重新生成 = 旧码立即作废，`PairingService` 不为「返回同一个码」缓存明文。
2. iOS 扫码（AVFoundation；解析只有 `SyncPairingLink.parse` 一处）→
   **先逐一探测候选地址的 `GET /api/status`**（验证 service + protocolVersion，
   每候选 2s 超时），对**验证可达的第一个地址**发一次
   `POST /api/pair {pairingCode, deviceName}`——配对码一次性，绝不向多地址
   并发兑换；响应丢失时由用户重新生成二维码。
3. 校验（恒定时间比较 + 双维限速：单源 5 次/5 分钟、全局 30 次/5 分钟、冷却 60s、
   「无码可兑不计数」）→ 签发 32 字节 Token：桌面端存哈希进 `devices` 表，
   iOS 存 Keychain；**码立即作废**。
4. 响应：`{token, deviceId, desktopDeviceId, desktopDeviceName, protocolVersion}`。
5. 端口策略：所有发布地址共用**同一个端口**（首选 47821，被占则统一探测一个
   空闲端口再绑全部地址；任一地址失败整体回滚重试）。没有可用局域网 IPv4
   时**不出二维码**，设置页提示检查网络——绝不给手机展示连不上的
   `127.0.0.1`。

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
| `POST /api/sync/apply` | 批量合并（见 §4），返回 `{appliedCount, skippedCount, conflictCount, failedItems[], results[]}`（逐条 `{entityType,id,status,reason?}`） |
| `POST /api/sync/media/manifest` | 清单比对 → `{missing[], have[], rejected[]}` |
| `POST /api/sync/media/chunk?name=&offset=` | 256KB 分块追加；offset 必须等于已收字节数（断点续传查询 `GET /api/sync/media/offset`）；同名分块互斥 |
| `POST /api/sync/media/finalize` | 整文件大小 + SHA-256（流式）校验 → 原子落位；失败清理临时文件 |

## 4. 合并语义（非破坏性）

对每条 upsert（id + fingerprint + payload）：

| 桌面端状态 | 动作 |
|---|---|
| 行不存在 | 插入（`created_at/updated_at` 缺省补 now；iOS payload 带了原始 `createdAt` 则保留），记基线指纹 |
| 本地指纹 == 来端指纹 | 跳过（幂等：重复同步不重复插入、不重复扣库存） |
| 基线存在且基线 == 本地指纹 | 桌面端没改过 → 接受 iOS 覆盖 |
| 基线存在且基线 == 来端指纹 | iOS 没改、桌面端改了 → **冲突**，保留本地 |
| 其余（两端都改 / 无基线） | **冲突**，保留本地 |

- 冲突落 `sync_conflicts`（双方指纹 + 远端 payload + `remote_operation`），
  设置页可裁决「保留电脑版本 / 接受手机版本」；未裁决不影响其他数据。
  **去重**：同一实体 + 相同远端指纹 + 相同操作的未裁决冲突只保留一条，
  反复同步不膨胀；远端内容再变（指纹不同）才新增。
- **「保留电脑版本」裁决持久化**（`sync_rejected` 表，2026-11-07）：裁决时
  记录被拒的远端指纹、**不改写基线**——相同远端内容再推直接 skipped
  （iOS 端基线随之收敛，不重复冲突）；远端真实变化（新指纹）重新进入合并
  （可能产生新冲突），绝不静默覆盖。裁决「接受手机版本」会清除该实体的
  拒绝记录。
- **删除必须带 `expectedFingerprint`**（iOS 上次成功同步的基线指纹）：

  | 桌面端状态 | 动作 |
  |---|---|
  | 行不存在 | 幂等跳过（同时清基线） |
  | 本地指纹 == expectedFingerprint | 桌面端没改过 → 允许删除 + 清基线 |
  | 指纹不一致 / 未提供基线 | **删除冲突**（`remote_operation='delete'`），桌面数据原样保留；裁决「接受删除」才真正删除并清基线 |

- 引用缺失（如 brew 指向不存在的 bean）→ `failedItems` 带原因，**不静默丢弃**，
  也不让单条失败拖垮整批。
- **PhaseRule 特例**：`roastLevel` 是自然标识（两端默认规则 UUID 各自生成），
  同一烘焙度只保留一份有效规则。命中既有规则后**仍走同一套四态检测**：
  字段一致 → skipped；桌面端无基线 → 冲突（不覆盖桌面数据）；基线 == 本地
  → 原位更新。基线记在**桌面行 id** 上，不悬空。
- **recordTagLink 关系实体**：Record ↔ Tag 多对多，确定性 id = `recordId:tagId`
  （复合主键表，专用读写删路径）；依赖 record 与 tag 已存在，缺失进
  `failedItems` 等下轮重试；删除关系按解析出的复合键删。
- **逐条结果**：`apply` 返回 `results[]`
  （`{entityType, id, status: applied|skipped|conflict|failed, reason?}`），
  iOS 按条提交基线——applied/skipped 推进，conflict/failed 保留原基线，
  绝不「整批 200 就全部提交」。
- 整批一个事务；事务失败整批回滚并报告。

## 5. 指纹（两端同规则）

`SHA-256(规范串)`；规范串 = 固定字段序 + `\u{1F}` 分隔；字符串原样、`nil` → `~`、
布尔 → `true/false`、数字 → 最多 6 位小数去尾零（跨语言 `1` ≡ `1.0`）。
**不含时间戳**（防 iOS 触碰 updatedAt 造成假变更）；Record 的
`mediaPath/previewPath`（稳定文件名，两端同名）**参与指纹**。字段序见
`snapshot-importer.ts localFingerprint` 与 `SyncSnapshotBuilder.swift`，两处互为镜像，
改一处必须改另一处并同步测试。

## 6. 媒体

- 清单项：`{name, sha256, byteSize, mediaType, mimeType}`；mimeType 按扩展名 +
  iOS 侧真实字节判定；视频（mov/mp4/m4v）由 **MediaStore 单独枚举**，
  不依赖 iOS 备份的 JPG 附件清单。
- **本地引用读取失败显式报告**（进同步结果的 failed 计数），不静默跳过。
- 名字沿用 iOS 存储名，桌面端 `isSafeMediaName` + 扩展名白名单双重校验；
  `offset` 查询同样过白名单（防路径穿越）。
- **流式传输**（两端）：iOS `FileHandle` 分块读 + 增量 SHA-256（断点续传时
  前缀只喂哈希不上传，整文件哈希仍完整）；桌面端 `createReadStream` 流式
  校验，全程内存占用 ≤ 一块。分块 256KB；块级追加校验偏移；同名分块写入
  进程内互斥。临时区 `.incoming` → 校验通过原子 rename 进媒体目录；失败清
  临时文件。**独立 chunk 哈希未实现**——请求体完整性由 HMAC（覆盖 body）
  保证，与「每块单独哈希」是两回事。
- 桌面端第一版**完整保存视频文件**（不丢弃），界面先展示封面与信息。

## 7. 游标语义（区分）

- `change_log.seq`：桌面端全局变更流水（未来双向拉取的游标）。
- `sync_baseline`（entity_type, entity_id → fingerprint）：**本方向**的去重基线。
- 两者不可混用；本版 iOS 端基线存 UserDefaults（非敏感），桌面端基线入库。

## 8. 时间

全部 **epoch 毫秒**。iOS `Date` 转换带防御：秒值（< 1e11）自动 ×1000。
业务 UUID 原样保留，禁止重新生成。
