/**
 * Remote Link Protocol v1 的 Cloud 侧实现入口。
 *
 * 只从这里导出：`link-server.ts` 的具体装配、`handshake.ts` 的纯校验、
 * `connection-registry.ts` 的路由表、`nonce-store.ts` 的防重放、
 * `heartbeat.ts` 的节拍、`schemas.ts` 的线格式。
 *
 * **不导出**内部状态（`live` 表、`tokenBySocket`）：它们都是连接生命周期
 * 的私有细节，暴露出去只会诱使别处「顺手查一下 socket」。
 */

export {
  createLinkServer,
  type DisconnectReason,
  type LinkConnectionSnapshot,
  type LinkLifecycleHooks,
  type LinkServer,
  type LinkServerOptions,
} from "./link-server.js";
export { admitDevice, type AdmissionFailure, type AdmissionOutcome, type AdmittedDevice } from "./admission.js";
export {
  createMemoryConnectionRegistry,
  type BindResult,
  type ConnectionInfo,
  type ConnectionRegistry,
} from "./connection-registry.js";
export {
  ed25519PublicKeyFromRaw,
  loadGrantRows,
  makeConnectionId,
  makeGrantContext,
  makeInstanceId,
  parseHelloFrame,
  toGrantSnapshots,
  verifyHandshake,
  verifyHelloSignature,
  type GrantRow,
  type HandshakeFailure,
  type HandshakeResult,
  type NonceRecorder,
} from "./handshake.js";
export { NonceStore, type NonceRecordResult } from "./nonce-store.js";
export {
  computeRequestHash,
  canonicalJson,
} from "./request-hash.js";
export {
  createRequestRegistry,
  resultOf,
  type DispatchResult,
  type PendingRequest,
  type RegistryCounts,
  type RequestRegistry,
  type RequestState,
  type ReserveOutcome,
  type SweepOutcome,
} from "./request-registry.js";
export {
  admitDispatch,
  gatewayResource,
  type DispatchAdmission,
  type DispatchGuardInput,
  type DispatchRejection,
} from "./dispatch-guard.js";
export {
  computeDeadline,
  createForwarder,
  type DispatchToolCallInput,
  type Forwarder,
  type ForwarderDeps,
  type ForwarderInspect,
  type GrantSyncOutcome,
} from "./forwarder.js";
export { createHeartbeat, HEARTBEAT_MISS_LIMIT, type HeartbeatController } from "./heartbeat.js";
export {
  decodeBase64UrlStrict,
  filterScopes,
  helloSigningPayload,
  helloSchema,
  negotiateVersion,
  frameEnvelopeSchema,
  REMOTE_CLOSE,
  REMOTE_CLOSE_REASON,
  REMOTE_HEARTBEAT_MS,
  REMOTE_HELLO_TIMEOUT_MS,
  REMOTE_IDLE_TIMEOUT_MS,
  REMOTE_LINK_PATH,
  REMOTE_MAX_CLOCK_SKEW_MS,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_DEVICE_MAX_INFLIGHT,
  REMOTE_ERROR_CODES,
  REMOTE_GRANT_ACK_TIMEOUT_MS,
  REMOTE_HARD_DEADLINE_MS,
  REMOTE_MAX_INFLIGHT,
  REMOTE_MAX_VERSION,
  REMOTE_MIN_VERSION,
  REMOTE_NONCE_WINDOW_MS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_QUEUE_BUDGET_MS,
  REMOTE_QUEUE_MAX,
  REMOTE_SCOPES,
  REMOTE_TOOL_BUDGET_MS,
  REMOTE_TOOL_SCOPES,
  REMOTE_TOOLS,
  REMOTE_USER_MAX_INFLIGHT,
  isRemoteTool,
  isRetryableRemoteError,
  scopeForTool,
  type RemoteErrorCode,
  REMOTE_WS_SUBPROTOCOL,
  type GrantSnapshot,
  type Hello,
  type HelloOk,
  type HelloSigningInput,
} from "./schemas.js";
