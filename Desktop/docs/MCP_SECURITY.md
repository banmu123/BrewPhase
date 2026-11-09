# BrewPhase MCP V1 — 安全模型

> 与 `SECURITY_MODEL.md`（Electron 渲染层边界）互补。这份文档只覆盖 MCP
> 接入链路：token、scope、socket、审计、限幅与错误边界。

## 1. 信任边界

```
不可信：AI 客户端与 MCP 进程
  ├─ 可伪造/重放任意请求 → Main 每请求查库验 token + scope
  ├─ 可发超大/畸形请求   → 1MB 单行上限 + Zod 校验 + 统一错误
  └─ 可持有旧 token      → 撤销后下一次请求即拒绝（无内存缓存）

可信：Electron Main（唯一数据库所有者）
  └─ Zod（工具参数）→ Application Service → Repository（事务/change_log/外键）
```

MCP 进程**不信任 CLI 传入的任何身份信息**：`name` 只是显示信息，权限完全由
Main 根据 token 哈希对应的 `mcp_clients` 行决定。MCP Server 侧不做权限判断
（即使做了，也只是 UX 过滤，不是安全边界）。

## 2. Token 生命周期

| 阶段 | 规则 |
|---|---|
| 生成 | `bp_mcp_` + `randomBytes(32).toString('base64url')`（48 字符） |
| 存储 | 仅 `sha256(token)` hex；表中无明文、无前缀索引 |
| 展示 | 创建响应返回一次；UI 只在创建弹层展示，关闭即不可再取 |
| 校验 | 每请求 `sha256` 查 `mcp_clients`；`revoked_at IS NOT NULL` → `UNAUTHORIZED` |
| 撤销 | 置 `revoked_at`；已有 socket 连接不断开，但下一次请求即被拒 |
| 传递 | 只走 MCP 进程环境变量 `BREWPHASE_MCP_TOKEN`；**禁止命令行参数**（进程列表可见） |

## 3. Scope

八种 scope，见 `MCP_TOOLS.md` 映射表。Main 端检查顺序固定：

```
请求 → token 有效？→ revoked？→ tool 已注册？→ scope 覆盖该 tool？→ Zod 参数 → Service
```

任何一步失败立即返回，不进入业务层；失败也写审计（写工具）。

Key 的存储形态：`scopes` 列是 JSON 数组字符串，创建/撤销时用同一份枚举校验，
未知 scope 直接 400（不静默忽略）。

## 4. Socket 与文件权限

| 资源 | 权限 | 说明 |
|---|---|---|
| `<userData>/mcp/` | `0700` | 仅当前用户可进入 |
| `bridge.sock` | `0600` | 仅当前用户可连接 |
| `bridge-info.json` | 默认（原子写） | **不含 token**，只含 socket 路径 / 协议版本 / pid |

- 目录在创建时 `chmod 0700`（已存在也强制校正）。
- 启动时先 connect 探测：能连说明有活服务（单实例锁下不应发生），连不上才需要
  清理旧 socket——**绝不 delete 一个可能仍在服务的 socket**。
- 退出与崩溃：正常退出删除 socket + info；崩溃残留由下次启动的探测清理。

## 5. 错误码

| Code | 含义 |
|---|---|
| `APP_NOT_RUNNING` | Bridge 未运行（Electron 未启动 / 已退出） |
| `UNAUTHORIZED` | token 缺失、未知或客户端已撤销 |
| `PERMISSION_DENIED` | scope 不覆盖该工具 |
| `VALIDATION_ERROR` | 参数 Zod 校验失败（含越界分页） |
| `NOT_FOUND` | 记录/画布/节点/标签不存在 |
| `STALE_RECORD` | 乐观并发失败，需重新读取 |
| `IDEMPOTENCY_KEY_REUSE` | 同幂等键用于不同请求 |
| `BRIDGE_UNAVAILABLE` | socket 连接失败（与 APP_NOT_RUNNING 同场景，客户端侧区分） |
| `BRIDGE_PROTOCOL_MISMATCH` | `bridge-info.json` 协议版本 ≠ 客户端 |
| `REQUEST_TOO_LARGE` | 单行请求超过 1MB |
| `REQUEST_TIMEOUT` | 客户端等待响应超时 |
| `INTERNAL_ERROR` | 未归类的服务异常（**不带堆栈**） |

约束：SQLite 异常一律落成 `INTERNAL_ERROR` 并只带可读 message；不向 AI 返回
堆栈、SQL、文件路径、token 或媒体文件名。

## 6. 限幅

- 单行请求 ≤ 1 MB（server 侧 enforce，超限直接 `REQUEST_TOO_LARGE` 并断开）。
- 响应体在 Service 层裁剪：`search_records` 列表的 note/summary 截断到 400 字符，
  `get_record` 截断到 4000 字符；不返回笔迹点集、不返回媒体文件名。
- 分页上限：records 50、coffee 100。
- MCP Server 构造时设 `maxToolInputElements: 5000`（SDK 层，防超大数组）。
- 客户端等待超时 30s（WorkBuddy `timeout: 30000`）。

## 7. 审计

`mcp_operation_log` 每次写调用一条（成功与失败都记）：

- 记：client_id、tool、entity_type、entity_id、success、error_code、
  idempotency_key、created_at。
- 不记：请求参数原文、记录正文、token、路径、IP（本地 socket 无意义）。
- 撤销客户端**不删除**历史审计（`client_id` 只是文本引用，不做外键级联）。

## 8. 明确不提供的能力（攻击面收敛）

`execute_sql`、`run_command`、`read_file`、`write_file`、任意路径导入、
删除记录/画布/节点/便签、媒体上传、网络代理、修改豆子与冲煮库存。
AI 不能指定 `media_path` / `preview_path` / carrier 变更 / 同步协议字段。

## 9. 已知未验证项（V1）

- **Windows**：Named Pipe ACL 未验证 → 声明不支持，不用 TCP 退化。
- **WorkBuddy 云端执行环境**：若没有本地进程访问能力，则无法连接本地 socket；
  本仓库不为此暴露公网 Bridge。
- MCP 客户端之间的相互隔离依赖 token 与 scope；同一用户给两个客户端相同
  scope 时它们能力相同（这是授权语义，不是漏洞）。
