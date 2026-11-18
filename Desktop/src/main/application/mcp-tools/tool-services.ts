import type { CanvasService } from '../canvas/canvas-service'
import type { CoffeeService } from '../coffee/coffee-service'
import type { PersonalDirectionService } from '../personal-direction/personal-direction-service'
import type { RecordService } from '../records/record-service'
import type { WorkContextService } from '../work-context/work-context-service'

/**
 * 工具执行所需的最小服务依赖。
 *
 * 这份类型是「共享执行层」与「调用方」之间的全部耦合面，因此**刻意不含**：
 *
 * - `db`：工具 Handler 从不直接碰 SQLite。27 个 Handler 逐条核对过，
 *   全部只调下面五个 Service 的 `*ForMcp`/领域方法（见 §迁移清单）；
 *   唯一的直接 SQL 在幂等重放（`recordRouter.replayIdempotent`），
 *   那属于 Local 的幂等机制，不随 Handler 搬进共享层。
 * - `clients`（`McpClientService`）：认证与 scope 计算是调用方的事。
 *   Local 用 MCP Client Token，Remote 将来自 grant——两者凭据域不同。
 * - `BridgeRequest` / `BridgeResponse`：线协议属于 `mcp-bridge/`，
 *   共享层不认识 NDJSON 与 socket。
 *
 * 少一个字段，就少一条「执行层偷偷绕过授权」的路径。
 */
export type ToolServices = {
  readonly records: RecordService
  readonly coffee: CoffeeService
  readonly canvas: CanvasService
  readonly workContexts: WorkContextService
  readonly personalDirection: PersonalDirectionService
}
