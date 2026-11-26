# BrewPhase Remote MCP — 单 VPS 部署手册

> Phase 1.3.3-A-R5 · 分支 `feature/remote-mcp` · 基线 `4445d15`
>
> **本手册描述可复现的部署流程，不代表已经执行过生产部署。**
> 未经确认不会 SSH 到生产服务器，也不会执行不可逆操作。

---

## 0. 架构

```
Internet ──80/443──▶ Caddy (TLS 终结) ──cloud:3000──▶ Cloud ──db:5432──▶ PostgreSQL 16
                                    │                    │
                                    │                    └──出站 HTTPS──▶ Google / GitHub
                                    └── HTTP 与 WSS 共用同一个端口 3000
```

- **只有 Caddy 发布端口**（80/443）。`cloud` 与 `db` 都不写 `ports:`。
- **单副本**：WSS 路由表在进程内存里，`GATEWAY_EXPECTED_REPLICAS=1`。
- **无 Redis**：共享路由表属 Phase 1.4，本轮不引入。

网络分两条（见 `compose.yaml` 文件头注释）：

| 网络 | 类型 | 成员 | 目的 |
|---|---|---|---|
| `edge` | 普通 | caddy + cloud | cloud 需**出站**调 Google/GitHub |
| `data` | `internal: true` | cloud + db | db 只对 cloud 可达，宿主与公网均不可达 |

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 服务器 | 单台 VPS，公网 IP，Linux x86_64/arm64 |
| Docker | ≥ 24（含 `docker compose` v2） |
| DNS | 一个 A/AAAA 记录指向该服务器（见 §2） |
| Google OAuth Client | Web application 类型，**四条回调中的两条**已登记 |
| GitHub OAuth App | **四条回调中的两条**已登记 |
| 仓库访问 | 能 `git clone` / `docker build` |

不需要：Kubernetes、Redis、对象存储、多台机器。

---

## 2. DNS 检查

```bash
# 解析到本机公网 IP
dig +short A api.phase.commitbrew.com
dig +short AAAA api.phase.commitbrew.com

# 反查一致（证书 DNS-01 / 邮件发送会用到）
dig +short -x <你的公网 IP>
```

检查项：

- [ ] A/AAAA 记录指向**本机**公网 IP；
- [ ] 没有遗留的 CDN/代理记录（除非你确实要让 CDN 终结 TLS——那样必须
      确认它透传 `Host`、`Upgrade`、`Sec-WebSocket-Protocol`）；
- [ ] 域名尚未被其它服务占用 80/443。

---

## 3. OAuth Provider 配置（四条回调，最容易漏）

Cloud 有**两套** Provider 回调路径，只共享适配器，事务表与 `redirect_uri`
校验完全独立：

| 用途 | 路径 |
|---|---|
| Desktop 登录 | `{BASE_URL}/oauth/callback/{google\|github}` |
| **Remote MCP 授权** | `{BASE_URL}/mcp/oauth/callback/{google\|github}` |

以 `BASE_URL=https://api.phase.commitbrew.com` 为例，**Google 与 GitHub 的
控制台里各填两条**：

```text
https://api.phase.commitbrew.com/oauth/callback/google
https://api.phase.commitbrew.com/oauth/callback/github
https://api.phase.commitbrew.com/mcp/oauth/callback/google
https://api.phase.commitbrew.com/mcp/oauth/callback/github
```

- **漏第二条的症状**：Desktop 登录正常，MCP 授权在 Provider 回调后立刻
  `redirect_uri_mismatch`。
- 登记值必须与 `BASE_URL` 拼出的字符串**逐字符一致**（代码侧就是逐字符比较）。
- **不使用通配 redirect URI**，代码也不接受。
- Google 侧 scope 只需 `openid email profile`；GitHub 不申请 scope。
- ChatGPT 自己的 callback 属于 **MCP 客户端**的 `redirect_uri`
  （走 `mcp_oauth_clients` 注册数据），**不要**混进这里的 Provider 配置。

---

## 4. 生产密钥生成

```bash
openssl rand -base64 48   # JWT_SIGNING_KEY        （≥32 字符）
openssl rand -base64 48   # MCP_BROWSER_SESSION_KEY（≥32 UTF-8 字节，必须与上者不同）
openssl rand -base64 32   # SESSION_TOKEN_PEPPER   （≥16 字符）
openssl rand -hex 32      # POSTGRES_PASSWORD      （**必须 URL 安全**，见下）
```

> **数据库口令为什么用 `-hex` 而不是 `-base64`**：`compose.yaml` 用字符串拼接
> 生成 `DATABASE_URL`，没有 URL 编码。`openssl rand -base64 24` 会产出 `/`，
> 拼出来的 URL 连 `new URL()` 都解析不了；含 `@` 时更隐蔽——解析器会把口令
> 改写成 `%40`，看起来能连、拿到的口令却不是配置里那个。
> 允许字符：`A-Za-z0-9._~-`，其余（`/ @ : # % 空格` 等）预检一律拒绝。
> 上面三个 base64 密钥不进 URL，所以仍然用 base64（熵更高）。

纪律：

- 生成后只写进部署机上的 `.env.production`（`chmod 600`），**不进 Git**；
- **不要**用固定默认密钥「先跑起来再说」——预检会拒绝；
- `MCP_BROWSER_SESSION_KEY` 与 `JWT_SIGNING_KEY` 相同会被拒绝
  （Cookie 签名与 token 签名共用一把密钥 = 互相伪造面）。

---

## 5. 生产环境变量

```bash
cd cloud/deploy
cp .env.production.example .env.production
chmod 600 .env.production
$EDITOR .env.production      # 填入 §3、§4 的真实值（口令用 openssl rand -hex 32）
```

### ⚠️ 所有 compose 命令都必须带 `--env-file .env.production`

Compose **只自动读项目目录里名为 `.env` 的文件**，不会读 `.env.production`。
漏掉 `--env-file` 时 `${…}` 插值找不到变量，命令直接失败：

```
error while interpolating services.cloud.environment.DATABASE_URL:
required variable POSTGRES_PASSWORD is missing a value: …
```

这是刻意的 fail-closed——**不会**退回到默认口令，也**不会**静默用示例配置。
但如果你把文件改名为 `.env`，就不再需要这个 flag；两条路都可以，
只是本手册统一用 `--env-file`，避免「有的命令带、有的不带」。

本手册后续**每一条** compose 命令都带该 flag（§13 的 `logs`、§14 的
备份恢复、§15 的升级回滚都在内）。

变量清单（**只列名字**，含义与默认值见 `.env.production.example`）：

| 分类 | 变量 |
|---|---|
| 基础 | `NODE_ENV`、`BASE_URL`、`PORT` |
| 数据库 | `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` |
| 密钥 | `JWT_SIGNING_KEY`、`JWT_SIGNING_KEY_PREVIOUS`、`SESSION_TOKEN_PEPPER` |
| Provider | `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` |
| Remote MCP | `MCP_BROWSER_SESSION_KEY` |
| 单副本 | `GATEWAY_EXPECTED_REPLICAS` |
| 代理信任 | `TRUST_PROXY`、`TRUST_PROXY_HOPS` |
| WSS 白名单 | `GATEWAY_ALLOWED_HOSTS`（留空 = 从 `BASE_URL` 推导） |
| HTTP CORS | `CORS_ORIGINS`（**不是** WSS 白名单，留空即关闭） |
| 可选 | `LOG_LEVEL`、`RATE_LIMIT_*`、`HTTPS_PROXY`、`NO_PROXY` |
| Caddy | `ACME_EMAIL`、`BREWPHASE_DOMAIN`（**必填，留空则 compose 启动即失败**） |

**`BASE_URL` 与 `BREWPHASE_DOMAIN` 必须指向同一个名字**——这是本手册最容易配错、
也最难在部署后发现问题的一条：

| 变量 | 谁在用 | 用错的表现 |
|---|---|---|
| `BASE_URL` | JWT `iss`、Provider 回调前缀、Discovery `issuer`、WSS Host 白名单 | 回调 404、令牌 `iss` 与客户端记录不一致 |
| `BREWPHASE_DOMAIN` | Caddy 申请证书、决定接受哪个 Host | 证书签给了另一个名字，或站点块根本不匹配 |

两者不一致时 `/health` 与 HTTPS 检查**都能通过**，故障只在用户授权时出现。
所以预检把「两者一致」做成硬判据（`brewphase_domain_mismatch`），并且：

- `BASE_URL` **只能用默认 HTTPS 端口**（`compose.yaml` 只发布 80/443，
  写 `:8443` 等于声明了一个没人监听的地址 → `base_url_port_unsupported`）；
- `BREWPHASE_DOMAIN` 必须是**裸主机名**：不带 scheme / 路径 / query / fragment /
  userinfo / 端口（→ `brewphase_domain_invalid`），且至少有两级标签
  （单标签拿不到 ACME 证书）。

### 首次部署的完整顺序（7 步，按序执行）

```bash
cd cloud/deploy

# ① 创建配置
cp .env.production.example .env.production
chmod 600 .env.production
$EDITOR .env.production

# ② 检查配置与 Compose 解析（不启容器，只验证插值与结构）
docker compose --env-file .env.production config --quiet

# ③ 构建 Cloud 镜像
docker compose --env-file .env.production build cloud

# ④ 用**最终注入容器的配置**跑预检（DATABASE_URL 由 Compose 拼好，无需手工 export）
docker compose --env-file .env.production run --rm --no-deps cloud \
  node dist/scripts/preflight-remote-mcp.js

# ⑤ 迁移（预检通过之前不允许执行）
docker compose --env-file .env.production run --rm cloud \
  node dist/scripts/migrate.js

# ⑥ 启动
docker compose --env-file .env.production up -d

# ⑦ 状态 + 独立健康检查
docker compose --env-file .env.production ps
curl -fsS https://<你的域名>/health      # 进程存活
curl -fsS https://<你的域名>/ready       # 数据库可用
```

**为什么预检必须放在 build 之后、用 `compose run`**：预检要读的是
**Compose 最终注入容器的** `DATABASE_URL`（由 `POSTGRES_*` 拼成），
而不是宿主 Shell 里的变量。用 `docker run --env-file …` 或手工
`export DATABASE_URL=…` 都只是「另一套配置」，通过了也不能证明部署配置正确。
`compose run` 走的是与 `up` 完全相同的 `environment` + `env_file` 合并结果。

**⑦ 不能把容器 `healthy` 当成数据库就绪**：cloud 的 HEALTHCHECK 打的是
`/health`，它**只代表进程存活**（`src/index.ts` 在 DB 不可达时会直接退出，
但运行中 DB 掉线不会让 `/health` 变红）。数据库可用性看 `/ready`——
它返回 503 表示 DB 不可用。两者必须分别请求。

**代理信任边界**：`TRUST_PROXY=true` + `TRUST_PROXY_HOPS=1` 只在
「cloud:3000 未发布端口、无法绕过 Caddy 直连」的前提下安全——
`compose.yaml` 已保证这一点。**不要**为了修限流去加大 `HOPS`：
取值过大会让客户端伪造的 XFF 条目被选中（限流被绕过），过小则同代理后的
用户共享一个限流桶。追加式代理取真实层数，覆盖式只能是 1。

---

## 6. Remote MCP 专用预检（首次部署的第 ④ 步）

**必须在 build 之后、用 `compose run` 执行**——理由见 §5「首次部署顺序」：
预检要验证的是 Compose 最终注入容器的那份配置。

```bash
cd cloud/deploy

# 源码预检（本地演练；读的是当前 Shell 的环境，与生产配置不是同一份）
cd .. && pnpm preflight:remote-mcp && cd deploy

# 生产预检（**权威**：与 up 用的是同一套 environment + env_file 合并结果）
docker compose --env-file .env.production run --rm --no-deps cloud \
  node dist/scripts/preflight-remote-mcp.js
```

> `--no-deps` 让预检不必等 PostgreSQL 起来：预检只读配置、不连库。
> 迁移（第 ⑤ 步）才需要 `db` 就绪，那时不加 `--no-deps`。

预检项（任一失败即**非零退出**，部署不继续）：

| 检查 | 失败码 |
|---|---|
| `NODE_ENV=production` | `node_env_not_production` |
| `BASE_URL` 为**公网 https 纯 Origin**（无 path/query/fragment、**默认 443 端口**；拒绝 IP 字面量、回环、`.local`/`.internal`/`.test` 等非公网后缀） | `base_url_missing` / `_invalid` / `_not_https` / `_not_origin` / `_userinfo` / `_ip_literal` / `_not_public` / `base_url_port_unsupported` |
| `BREWPHASE_DOMAIN` 是裸主机名 | `brewphase_domain_missing` / `brewphase_domain_invalid` |
| `BREWPHASE_DOMAIN` 与 `BASE_URL` 的 hostname 逐字一致（大小写不敏感，不做后缀匹配） | `brewphase_domain_mismatch` |
| `DATABASE_URL` 已配置且可解析 | `database_url_missing` / `database_url_invalid` |
| `DATABASE_URL` 必须含非空用户名 / 密码 | `database_url_user_missing` / `database_url_password_missing` |
| `DATABASE_URL` 的 host 必须是 compose 服务名 `db` | `database_url_host_mismatch` |
| `DATABASE_URL` 的端口必须是 5432（不写端口按默认 5432 处理） | `database_url_port_unsupported` |
| `DATABASE_URL` 的库名 / 用户名分别与 `POSTGRES_DB` / `POSTGRES_USER` 一致 | `database_url_name_mismatch` / `database_url_user_mismatch` |
| `DATABASE_URL` 的口令与 `POSTGRES_PASSWORD` 一致（**不会因为解析不出密码就跳过**） | `database_url_password_mismatch` |
| `DATABASE_URL` 不带 query / fragment（`#` 会被 URL 解析器静默丢弃） | `database_url_query_unexpected` / `database_url_hash_unexpected` |
| `POSTGRES_USER` / `POSTGRES_DB` 只含 URL 安全字符 | `postgres_user_unsafe_chars` / `postgres_db_unsafe_chars` |
| `POSTGRES_PASSWORD` ≥16 字符 | `postgres_password_missing` / `_too_short` |
| `POSTGRES_PASSWORD` 只含 URL 安全字符（`A-Za-z0-9._~-`） | `postgres_password_unsafe_chars` |
| `POSTGRES_PASSWORD` 不是示例占位值 | `postgres_password_placeholder` |
| `JWT_SIGNING_KEY` ≥32 字符 | `jwt_key_missing` / `jwt_key_too_short` |
| `SESSION_TOKEN_PEPPER` ≥16 字符 | `pepper_missing` / `pepper_too_short` |
| Google / GitHub 四个变量成对齐全 | `google_*` / `github_*` |
| `MCP_BROWSER_SESSION_KEY` ≥32 UTF-8 字节 | `mcp_browser_session_key_missing` / `_too_short` |
| `MCP_BROWSER_SESSION_KEY` ≠ `JWT_SIGNING_KEY` | `mcp_browser_session_key_reused_from_jwt` |
| `GATEWAY_EXPECTED_REPLICAS=1` | `gateway_replicas_not_single` |
| `resolveMcpOAuthEnablement()` 通过 | `mcp_oauth_<reason>` |

**预检只输出变量名与判定，绝不打印任何 Secret 的值**（测试
`tests/scripts/preflight-remote-mcp.test.ts` 用哨兵值断言过）。

`POSTGRES_USER` / `POSTGRES_DB` 未设置或为空时，预检按 `compose.yaml` 的
`${VAR:-default}` 取默认值（`brewphase` / `brewphase_cloud`）后再比对——
预检的判定与 Compose 的实际行为必须逐字一致，否则「预检通过但连错库」。

**口令为什么按「URL 安全字符」卡**：`compose.yaml` 用字符串拼接生成
`DATABASE_URL`，没有 URL 编码。`openssl rand -base64 24` 会产出 `/`，
拼出来的 URL 连 `new URL()` 都解析不了；含 `@` 时更隐蔽——解析器会把口令
改写成 `%40`，看起来能连、拿到的口令却不是配置里那个。用
`openssl rand -hex 32` 生成即可。

为什么要这一步：`MCP_BROWSER_SESSION_KEY` 缺失时服务**照常启动**、
`/health` 照常 200，只是 `/mcp`、`/.well-known/*`、`/mcp/oauth/*` 全部 404
（`src/app.ts:120-130` 打一条 warn 就过去了）。这是最难查的一类故障。

---

## 7. Docker 构建（首次部署的第 ③ 步）

```bash
cd cloud/deploy
docker compose --env-file .env.production build cloud
```

多阶段：依赖安装 → TS 编译 → **仅生产依赖** → 运行镜像（**非 root**、只带
`dist/`）。构建产物包含 `dist/db/migrations/`（由 `scripts/copy-assets.mjs` 复制）。

> **生产部署只推荐上面这条 compose 命令。** 在 `cloud/` 下直接
> `docker build -t brewphase-cloud .` 只用于**本地开发 / 诊断**（例如想单独
> 检查镜像层），它绕过了 compose 的 `image:` 命名与 build 参数，后续
> `docker compose up` 可能去拉一个并不存在的远端镜像。

---

## 8. 数据库迁移（首次部署的第 ⑤ 步，预检通过之后）

迁移由 **Drizzle journal** 驱动（`src/db/migrations/meta/_journal.json`），
**脚本里不写死版本号**；当前有 `0000`–`0005`，以后新增迁移无需改脚本。

```bash
docker compose --env-file .env.production run --rm cloud \
  node dist/scripts/migrate.js
```

> 这里**不加** `--no-deps`：迁移要连库，compose 会先确保 `db` 健康。
> `DATABASE_URL` 同样由 compose 注入，不需要手工 export。

保证：

- **只应用尚未执行的迁移**（journal 比对，已应用的跳过）；
- **重复执行安全**（幂等）；
- **不清空数据库、不重置用户、不改已应用的迁移文件**；
- **迁移失败 → 非零退出**，此时不要把服务标记为部署成功。

> 迁移只需要 `DATABASE_URL`，刻意不走完整 env 校验
> （`src/scripts/migrate.ts`），因此可以在服务凭据尚未注入的 Job 里先行执行。

---

## 9. 服务启动（首次部署的第 ⑥⑦ 步）

```bash
cd cloud/deploy
docker compose --env-file .env.production up -d
docker compose --env-file .env.production ps   # 三个容器都要 healthy
```

然后**独立**请求两个端点——不能把容器 `healthy` 当成数据库就绪：

```bash
curl -fsS https://<你的域名>/health    # 进程存活 → 200 {"status":"ok",…}
curl -fsS https://<你的域名>/ready     # 数据库可用 → 200 {"status":"ready",…}
                                       #              503 = DB 不可用
```

- `cloud` 的 HEALTHCHECK 打的是 `/health`，**只代表进程存活**：运行中 DB
  掉线不会让容器变红，只有 `/ready` 会变 503。
- `/ready` 还返回 `instance_id` 与 `connection_count`——单副本验收看这里。
- `cloud` 依赖 `db` 的 `service_healthy`，数据库没起来不会启动。

---

## 10. HTTPS 检查

```bash
curl -sI https://api.phase.commitbrew.com/health | head -3     # 200 + 无跳转
curl -sI http://api.phase.commitbrew.com/health  | head -3     # 30x → https
echo | openssl s_client -connect api.phase.commitbrew.com:443 -servername api.phase.commitbrew.com 2>/dev/null | openssl x509 -noout -subject -dates
```

- [ ] HTTP 自动跳转 HTTPS；
- [ ] 证书由 Caddy 自动申请且未过期；
- [ ] 证书主机名与 `BASE_URL` 一致。

---

## 11. Discovery 检查（冒烟脚本）

```bash
BASE_URL=https://api.phase.commitbrew.com node deploy/smoke-test.mjs
```

覆盖：`/health`、`/ready`（含 `instance_id` / `connection_count`）、
PRM 两式、AS Metadata（issuer/authorize/token/revoke 指向公网域名、
PKCE 仅 S256、`token_endpoint_auth_methods=["none"]`、未声明
`registration_endpoint`）、未授权 `POST /mcp`（必须 401 而非 404、
带 `WWW-Authenticate` 且不含 `scope`、响应体不泄露内部实现）、
`/mcp/oauth/login` 无 rid 时不得 200（登录入口纪律）。

**任何一项失败 → 非零退出。**

> 单副本确认：`/ready` 返回的 `instance_id` 必须只有一个后端。
> 部署后额外确认一次 `docker compose --env-file .env.production ps` 里 `cloud` 只有 1 个容器。

---

## 12. WSS 真机验收（必须人工执行）

脚本无法伪造真实 Desktop，以下必须用 **真实 BrewPhase Desktop** 逐步确认：

```bash
# 1) DNS 与证书
dig +short A api.phase.commitbrew.com
echo | openssl s_client -connect api.phase.commitbrew.com:443 \
  -servername api.phase.commitbrew.com 2>/dev/null | openssl x509 -noout -subject -dates

# 2) 服务端日志：观察 Upgrade 与握手
docker compose --env-file .env.production logs -f cloud \
  | grep -E 'link_upgrade_accepted|link_upgrade_rejected|link_established|link_hello_timeout|link_handshake_rejected'
```

然后在 Desktop 上：设置 → 远程访问 → 打开开关 → 配对新设备 → 输入确认码。

| # | 检查 | 期望 |
|---|---|---|
| 1 | DNS 解析 | 指向本机公网 IP |
| 2 | HTTPS 证书 | 有效、主机名匹配 |
| 3 | WebSocket Upgrade | `link_upgrade_accepted`（不是 `link_upgrade_rejected`） |
| 4 | `Sec-WebSocket-Protocol` | 协商出 `brewphase.remote.v1`；否则 `400 subprotocol_required` |
| 5 | 握手 | `link_established`（含 `device=…`、`grants=…`） |
| 6 | 心跳 | 持续 20s 一拍，**无** `link_heartbeat_timeout` |
| 7 | `/ready` | `connection_count` 从 0 变 1 |
| 8 | 重启后重连 | `docker compose --env-file .env.production restart cloud` → Desktop 按退避重连 → 再次 `link_established` |
| 9 | 重启后路由表 | 重启瞬间 `connection_count=0`，重连后回 1；**无残留旧 connectionId** |

**Host 与 Origin 校验必须仍然生效**——不允许为了让连接成功而放宽白名单：

```bash
# Host 不在白名单 → 必须 403 host_not_allowed
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Host: evil.example.com' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: brewphase.remote.v1' \
  -H 'Authorization: Bearer bp_dev_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  https://api.phase.commitbrew.com/device-link
# 期望 403

# Origin 不在白名单 → 必须 403 origin_not_allowed
# （WSS 白名单 = BASE_URL Origin ∪ CORS_ORIGINS，见 R2）
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Origin: https://evil.example.com' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: brewphase.remote.v1' \
  -H 'Authorization: Bearer bp_dev_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  https://api.phase.commitbrew.com/device-link
# 期望 403
```

若日志中**完全没有** Upgrade 事件而 Desktop 显示在重连，优先查 DNS、
TLS、`Host` 透传与反代路径——**不要**先怀疑 device_token。

---

## 13. 日志查看与脱敏

```bash
docker compose --env-file .env.production logs -f --tail=200 cloud
docker compose --env-file .env.production logs cloud 2>&1 \
  | grep -E 'link_|http_request|mcp_' | tail -50
```

**应用层日志已脱敏**（这是默认审计面）：

- `http_request` 只记 `method` / `pathname` / `status` / `durationMs`
  —— `pathname` 取自 `new URL(c.req.url).pathname`，**不含 query**，
  所以 OAuth 回调的 `code` / `state` 不会进日志；
- 不记任何请求头（`Authorization`、Cookie、`Sec-WebSocket-*` 全不在）；
- 不记请求体、不记工具 arguments 与结果正文；
- WSS 拒绝日志只记布尔与枚举（`stage` / `status` / `hostAllowed` /
  `originAllowed` …），**不记 Host、Origin、token 原文**；
- 错误对象只记 `error` 消息，不记堆栈进结构化字段。

**Caddy 不开 access log**（见 `deploy/Caddyfile` 文件头）：它的默认
`request.uri` **含 query**，会把一次性 `code`/`state` 写进磁盘。
需要代理侧日志时，必须先证明不会记录 query。

**不要**把 `docker compose logs` 的输出原样贴进 issue——即使已脱敏，
也先自查一遍有没有你自己的 IP、域名、设备名。

---

## 14. 数据库备份与恢复

数据在命名卷 `pgdata`（`/var/lib/postgresql/data`）。

**口令与库名一律从容器内读**，不要在宿主 Shell 里写 `$POSTGRES_USER`：
那些变量只存在于 `.env.production`，宿主上并没有 export。直接用会得到
`pg_dump: error: too many command-line arguments` 之类的怪错误，或者更糟——
空库名连到别的库上。`exec` 进容器后 compose 注入的 `POSTGRES_*` 就在环境里，
`sh -c` 里的 `$POSTGRES_USER` 会正确展开，且**不会打印口令**
（`pg_dump` / `psql` 不回显 `-U` 的值）。

```bash
cd cloud/deploy
DFLAGS=(--env-file .env.production)

# ── SQL 压缩备份（升级前必做）────────────────────────────────────────────
docker compose "${DFLAGS[@]}" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' \
  | gzip > "backup-$(date +%Y%m%d-%H%M%S).sql.gz"

# ── 自定义格式备份（可选择性恢复，体积更小）──────────────────────────────
docker compose "${DFLAGS[@]}" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner -Fc -f /tmp/dump.dump'
docker compose "${DFLAGS[@]}" cp db:/tmp/dump.dump "./dump-$(date +%Y%m%d-%H%M%S).dump"

# ── 恢复前先确认目标库 ──────────────────────────────────────────────────
#    恢复会覆盖同名对象，指错库不可逆——这一步不能省。
docker compose "${DFLAGS[@]}" exec -T db \
  sh -c 'echo "target db = $POSTGRES_DB (user=$POSTGRES_USER, host=${POSTGRES_HOST:-db})"'

# ── SQL 恢复 ────────────────────────────────────────────────────────────
#    先停 cloud，避免恢复期间仍有写入。-v ON_ERROR_STOP=1：出错即停，不半途而废。
docker compose "${DFLAGS[@]}" stop cloud
gunzip -c backup-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose "${DFLAGS[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
docker compose "${DFLAGS[@]}" up -d cloud

# ── 自定义格式恢复 ──────────────────────────────────────────────────────
docker compose "${DFLAGS[@]}" stop cloud
docker compose "${DFLAGS[@]}" cp "./dump-YYYYMMDD-HHMMSS.dump" db:/tmp/restore.dump
docker compose "${DFLAGS[@]}" exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists /tmp/restore.dump'
docker compose "${DFLAGS[@]}" up -d cloud

# ── 卷级快照（整机迁移 / 灾难恢复）──────────────────────────────────────
docker compose "${DFLAGS[@]}" stop db
docker run --rm -v brewphase_pgdata:/data -v "$(pwd)":/backup alpine \
  tar czf "/backup/pgdata-$(date +%Y%m%d).tar.gz" -C /data .
docker compose "${DFLAGS[@]}" start db
```

- **恢复命令里的 `psql` / `pg_restore` 也走 `sh -c`**：让 `-U "$POSTGRES_USER"`
  在容器内展开，宿主 Shell 不需要知道任何数据库变量，也不会把口令写进
  命令行（口令由容器的本地认证提供，不经过 `-U`/`-P` 参数）。
- **备份文件视为敏感数据**：含用户账号、设备、授权记录。放服务器本地或
  加密后异地，**不进 Git**、不进 issue 附件。
- **升级前必须先备份**（§15）。
- 卷说明：`pgdata` 是命名卷，`docker compose down` **不会**删它；
  `docker compose down -v` **会删**——除非你明确要销毁数据，否则不要带 `-v`。

---

## 15. 更新与回滚

```bash
cd cloud/deploy
DFLAGS=(--env-file .env.production)

# ── 升级 ────────────────────────────────────────────────────────────────
cd .. && git fetch && git checkout <new-sha> && cd deploy

docker compose "${DFLAGS[@]}" config --quiet        # ① 新版本可能引入新的必填变量
pnpm --dir .. preflight:remote-mcp 2>/dev/null || true   # （可选）源码侧快速检查

# ② 备份（口令/库名从容器内读，见 §14）
docker compose "${DFLAGS[@]}" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' \
  | gzip > "pre-upgrade-$(date +%Y%m%d-%H%M%S).sql.gz"

# ③ 构建新镜像
docker compose "${DFLAGS[@]}" build cloud

# ④ 用**新镜像**跑预检（新版本可能加了必填项）
docker compose "${DFLAGS[@]}" run --rm --no-deps cloud \
  node dist/scripts/preflight-remote-mcp.js

# ⑤ 迁移（只加不减）
docker compose "${DFLAGS[@]}" run --rm cloud node dist/scripts/migrate.js

# ⑥ 滚一个容器（单副本 = 短暂中断）
docker compose "${DFLAGS[@]}" up -d cloud
docker compose "${DFLAGS[@]}" ps                    # ⑦ 确认 healthy、只有一个 cloud

# ⑧ 独立健康检查（容器 healthy ≠ 数据库就绪）
curl -fsS https://<你的域名>/health
curl -fsS https://<你的域名>/ready
node smoke-test.mjs https://<你的域名>              # ⑨ 冒烟

# ── 回滚（代码）─────────────────────────────────────────────────────────
cd .. && git checkout <previous-sha> && cd deploy
docker compose "${DFLAGS[@]}" build cloud
docker compose "${DFLAGS[@]}" up -d cloud
# 迁移是**只增不减**的：回滚代码通常不需要回滚 schema。
# 若新迁移破坏了旧代码，才用 pre-upgrade 备份恢复——那是最后手段，
# 会丢掉升级后写入的数据，执行前必须再确认一次备份可用。

# ── 回滚（数据）─────────────────────────────────────────────────────────
docker compose "${DFLAGS[@]}" stop cloud
gunzip -c pre-upgrade-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose "${DFLAGS[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
docker compose "${DFLAGS[@]}" up -d cloud
```

**顺序纪律**：备份 → 构建 → **新镜像预检** → 迁移 → 启动 → 健康检查 → 冒烟。
任何一步失败就停在那一步，不要「先起服务再看」——迁移失败时服务可能起得来
但行为是错的；预检失败时同理（新版本可能要求新的必填变量）。

---

## 16. 上线前自查清单

- [ ] `.env.production` 存在、`chmod 600`、**未进 Git**；`ACME_EMAIL` /
      `BREWPHASE_DOMAIN` 已填真实值（留空则 compose 直接失败）
- [ ] **每条 compose 命令都带 `--env-file .env.production`**
- [ ] `docker compose --env-file .env.production config --quiet` 通过
- [ ] 四个 Provider 回调地址全部登记且逐字符一致
- [ ] `POSTGRES_PASSWORD` 用 `openssl rand -hex 32` 生成、非占位值、
      不含 URL 保留字符（预检会卡）
- [ ] **第 ④ 步预检通过**（`compose run --no-deps cloud …preflight…`）——
      在它通过之前不执行迁移、不启动
- [ ] 第 ⑤ 步迁移成功；第 ⑦ 步 `ps` 中三个容器 healthy、`cloud` 只有 1 个
- [ ] **`/health` 与 `/ready` 分别请求过**（容器 healthy ≠ 数据库就绪）
- [ ] 只有 Caddy 发布 80/443；`docker compose --env-file .env.production ps` 中 cloud/db 无宿主端口
- [ ] `GATEWAY_EXPECTED_REPLICAS=1`，`cloud` 容器数 = 1
- [ ] `TRUST_PROXY`/`TRUST_PROXY_HOPS` 与真实单层链路一致
- [ ] Caddyfile 通过 `caddy validate`（**有变量**与**无变量**两种都验过）
- [ ] HTTPS 证书有效、HTTP 跳转 HTTPS
- [ ] `smoke-test.mjs` 全部 PASS
- [ ] WSS 真机验收 9 项完成，且 Host/Origin 负例仍 403
- [ ] 升级前备份已生成并验证可读（备份命令走容器内 `$POSTGRES_USER`）
- [ ] 日志抽查无 query、无 Authorization、无工具正文
