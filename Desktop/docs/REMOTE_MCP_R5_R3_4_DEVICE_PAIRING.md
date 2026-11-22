# R5-R3.4 · 真实设备首次配对闭环

基线：`5ca325c6c8a8c7788b3515ccf55c58b9fd01b6bd`（`feature/remote-mcp`）
阶段：只做设备首次配对的注册 → 确认 → 领取 → 连线闭环，不重做 MCP OAuth / 工具层。

## 一、结论

| 项目 | 结果 |
|---|---|
| 确认能力（`DeviceRegistrar.confirm`） | 已接入 `POST /mcp-devices/:id/confirm` |
| 撤销能力（`DeviceRegistrar.revoke`） | 已接入 `DELETE /mcp-devices/:id` |
| Desktop 状态机 | 注册后停在 pending，**不再自动确认**；确认成功才领凭据 |
| Renderer | 真实配对面板（设备、平台、账号、确认码、有效期、两个动作） |
| Mock 文案 | 已删除（zh-CN / en-US 同步） |
| Desktop 门禁 | typecheck ✓ / 1306 测试 ✓ / build ✓ |
| Cloud 门禁 | typecheck ✓ / lint ✓ / 1703 测试 ✓ / build ✓ |
| 现有设备与 Grant | 未改动（`77f9f052` 全程在线，回归后仍 `online`） |

## 二、改动文件

**主进程**

| 文件 | 改动 |
|---|---|
| `src/main/remote/registration.ts` | 新增 `confirm()` / `revoke()`；`callWithBearer` 支持 `DELETE`；错误按状态码归一，错误对象不含确认码或响应体 |
| `src/main/remote/remote-service.ts` | `pendingRegistration` 增加展示字段；新增 `confirmRegistration()` / `cancelRegistrationNow()`；`publish()` 返回快照 |
| `src/main/remote/link-state.ts` | `buildStatus` 接受并可输出 `pendingRegistration` |
| `src/main/index.ts` | 注入 `currentUserLabel`（仅用于显示，不参与身份判定） |
| `src/main/ipc/register.ts` | 注册两条新通道 |

**契约与 IPC**

| 文件 | 改动 |
|---|---|
| `src/shared/contracts/remote.ts` | `remotePendingRegistrationSchema`、`REMOTE_CONFIRM_FAILURES`、confirm 请求/响应 schema、`RemoteConfirmResult` / `RemoteCancelResult`；`RemoteStatus.pendingRegistration`；`REMOTE_CHANNELS` 两条新键 |
| `src/shared/contracts/index.ts` | `RendererApi.remote.confirmRegistration / cancelRegistration`；`register` 返回完整 ticket |
| `src/shared/contracts/validation/ipc.ts` | 两条通道常量 + `z.void()` 入参（Renderer 不能传码或 deviceId） |
| `src/preload/index.ts` | 暴露两个方法 |

**Renderer**

| 文件 | 改动 |
|---|---|
| `features/settings/RemoteAccessPanel.tsx` | 真实待确认卡片 + 确认/取消动作 + 失败分类提示；删除本地 `pendingDevice` 状态 |
| `i18n/messages/{zh-CN,en-US}/settings.ts` | 新增配对文案 17 项；删除 `pendingMockNote` |

**测试**

| 文件 | 改动 |
|---|---|
| `tests/integration/remote-confirm.test.ts`（新） | 10 条：pending 不落盘、确认后领取落盘、只领一次、开关关闭不建连、配对后 WSS 握手、错码保留现场、账户切换不落盘、过期、取消撤销、云端不可达 |
| `tests/unit/remote-confirm-registration.test.ts`（新） | 18 条：confirm 的 200/400/401/403/404/409/410/429/非 JSON/网络、revoke 的 200/404/401/500/网络、请求形态与不泄漏 |
| `tests/helpers/mock-gateway.ts` | 支持 `DELETE /mcp-devices/:id` |
| `remote-registration` / `remote-user-gate` / `remote-rotation` | 更新白名单断言与 registrar 桩 |

**仓库卫生**

- `.gitignore` 增加 `/.workbuddy/memory/`；
- `git rm -r --cached .workbuddy/memory`（31 个文件取消跟踪，**本地文件全部保留**，未重写历史）。

## 三、API / IPC 变化

| 名称 | 方向 | 说明 |
|---|---|---|
| `POST /mcp-devices/:id/confirm` | Desktop → Cloud | 已有端点，本次接入。Body `{confirm_code}`，200 幂等，400/404/409/410/429 分别映射 |
| `DELETE /mcp-devices/:id` | Desktop → Cloud | 已有端点，本次用于「取消配对」；404 视为成功 |
| `remote:confirm-registration` | Renderer → Main | 无入参；返回 `{ok, reason, status}` |
| `remote:cancel-registration` | Renderer → Main | 无入参；返回 `{revoked, status}` |
| `remote:register` | Renderer → Main | 返回值扩展为 `{deviceId, deviceName, platform, confirmCode, expiresAt, accountLabel}` |
| `RemoteStatus.pendingRegistration` | Main → Renderer | `null` 或待确认展示信息（**不含** claim_secret / 私钥 / device_token） |

## 四、状态流转

```
配对新设备
  └─ POST /mcp-devices/register
       → status = pending, confirm_code 落库（hash）
       → 主进程内存持 claim_secret + 新私钥
       → Renderer 看到 pendingRegistration（码 / 设备 / 平台 / 账号 / 有效期）
       → 轮询 /credentials 拿 202（保持 pending，不落盘）

用户点「确认信任这台设备」
  └─ POST /mcp-devices/:id/confirm {confirm_code}
       ├─ 200 → 立刻 POST /credentials → device_token
       │        → safeStorage 加密落盘（device.json）
       │        → pendingRegistration = null，deviceId/boundUserId 就绪
       └─ 400/410/404/409 → 分类提示；除终态外保留现场可重试

用户点「取消本次配对」
  └─ 本地清理（停轮询、抹 claim_secret、清 pending）
       └─ DELETE /mcp-devices/:id
            ├─ 200/404 → revoked=true
            └─ 其它 → revoked=false（设备会自然过期，界面如实说明）

用户打开「允许远程访问」（与配对是两个独立动作）
  └─ identityGate: deviceId + deviceToken + privateKey + boundUserId + origin 全部匹配
       → WSS hello → hello_ok → online
```

## 五、测试结果

| 套件 | 结果 |
|---|---|
| Desktop 全量 | **92 文件 / 1306 条通过**（新增 28 条） |
| Cloud 全量 | **82 文件 / 1703 条通过** |
| Desktop `typecheck` | 通过（`tsconfig.node.json` + `tsconfig.web.json`） |
| Desktop `build` | 通过 |
| Cloud `typecheck` / `lint` / `build` | 通过 |

说明：Desktop 仓库**没有 ESLint 配置**（无 `eslint.config.*`、无 `lint` script），任务书中的 lint 一项以 typecheck 覆盖；Cloud 的 `pnpm lint` 正常运行。

## 六、独立设备验收

**测试层（已完成，无 SQL 介入）**

`tests/integration/remote-confirm.test.ts` 用真实 HTTP 客户端 + 真实 `DeviceStore`（临时目录）+ 真实状态机跑完整闭环，其中：

- `注册后是 pending`：确认码可见、`device.json` 不存在、云端设备仍 `pending`；
- `确认成功后立刻领取并落盘`：`device.json` 出现，`pendingRegistration` 清空；
- `配对完成后用户打开开关 → 用刚拿到的凭据完成 WSS 握手`：`gateway.connections === 1` 且 `helloVerified === true`（用的是注册时那对密钥）。

**真实 GUI（未执行，原因）**

桌面端只有一份 `device.json`，在真实界面上再走一次「配对新设备」会覆盖现有在线设备 `77f9f052` 的凭据，等于删除/暂停一台正在服务的设备——与任务书 §8 的硬约束冲突。因此本阶段选择不在真实 GUI 上重复配对，改为上面那组等价集成测试。若需要真机验证，建议单独提供第二份 `userData` 目录后另开一次验收。

**现有能力未受影响**

重启桌面端加载新代码后实测：

| 调用 | 结果 |
|---|---|
| `tools/list` | 8 个工具 |
| `tools/call search_records` | `isError: false`，返回 1 条 |
| `tools/call list_canvases` | `isError: false`，返回 2 个画布 |
| 设备 `77f9f052` | `last_seen_at` 持续刷新，状态 `active` |

## 七、遗留问题

1. **确认码的消费入口只有 Desktop 一处**。Cloud 端 `POST /mcp-devices/:id/confirm` 仍然没有网页/移动端界面；本次把 Desktop 做成入口，闭环成立，但「在手机上确认桌面设备」这种形态还没有。
2. **pending 过期不会主动推状态**。到点后要么用户点一次确认（得到 `expired`），要么等下一次广播；没有定时器在过期瞬间刷新界面。
3. **`confirm_attempts` 触顶后云端直接置 `revoked`**，Desktop 仍显示 pending 直到再次确认（届时返回 `device_state`）。这是可接受的，但提示语偏向「已被撤销」而不是「码错了太多次」。
4. **真实 GUI 二次配对未验收**（见第六节原因）。
5. **生产环境未部署**（任务书 §11 明确禁止）。
6. GitHub OAuth client secret 曾在对话中明文出现，轮换作为独立运维事项，不在本次代码改动范围内。
