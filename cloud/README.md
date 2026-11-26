# BrewPhase Cloud

BrewPhase 的独立云端账号服务。**只负责身份**：Google / GitHub OAuth 登录、统一的
BrewPhase 用户身份、会话签发与撤销。咖啡记录、Records、Canvas 等业务数据永远不进云端
（Local-first 产品原则）。

本服务是独立部署单元，不进入 Electron Desktop 打包依赖。

## 技术栈

| 项 | 选择 |
|---|---|
| 运行时 | Node.js ≥ 22, TypeScript 5.9 (NodeNext ESM) |
| HTTP 框架 | Hono + @hono/node-server |
| 数据库 | PostgreSQL + Drizzle ORM（迁移由 drizzle-kit 管理） |
| JWT / OIDC | jose（HS256 Access Token；Google ID Token 远程 JWKS 验签） |
| 校验 | zod |
| 测试 | Vitest + 真实 PostgreSQL（容器） |

## API

```text
GET  /health                    进程存活
GET  /ready                     数据库可用性（503 = 不可用）

GET  /oauth/authorize           授权入口（provider/state/code_challenge/redirect_uri）
GET  /oauth/callback/google     Google OIDC 回调（Desktop 登录）
GET  /oauth/callback/github     GitHub OAuth 回调（Desktop 登录）
POST /oauth/token               一次性授权码 + PKCE → access/refresh token

POST /auth/refresh              Refresh Token Rotation
POST /auth/logout               撤销整个 token family
GET  /auth/me                   当前用户资料（Bearer JWT）
GET  /auth/identities           当前用户的第三方身份列表（Bearer JWT）
```

### Remote MCP（需 `MCP_BROWSER_SESSION_KEY`，见「生产部署 → 构建与预检」）

下列路由与上面的 Desktop 登录**共用 Provider 适配器，但不共享事务表与浏览器状态**；
未配置 `MCP_BROWSER_SESSION_KEY` 时**整组不注册**（404，而 `/health` 仍 200）。

```text
GET  /.well-known/oauth-protected-resource        PRM（根形式）
GET  /.well-known/oauth-protected-resource/mcp    PRM（path-inserted 变体）
GET  /.well-known/oauth-authorization-server      AS Metadata

GET  /mcp/oauth/authorize     授权入口（含 resource / PKCE S256）
GET  /mcp/oauth/login         本次授权专属的登录选择页（非公开登录入口）
GET  /mcp/oauth/callback/google   Remote MCP 的 Google 回调
GET  /mcp/oauth/callback/github   Remote MCP 的 GitHub 回调
GET+POST /mcp/oauth/consent   同意页（逐项勾选 scope）
POST /mcp/oauth/token         授权码 + PKCE → MCP access token
POST /mcp/oauth/revoke        撤销（单位是**单个 Session**，不是整个 Grant）

POST /mcp                     Streamable HTTP MCP 数据端点（8 个只读工具）
OPTIONS /mcp                  预检（独立路由，不消耗 mcp-http 限流额度）

GET  /device-link             WSS 接入（与 HTTP 同端口，Upgrade 校验 Host/Origin/子协议）
POST /mcp-devices/register    设备注册
POST /mcp-devices/{id}/confirm     确认配对（pending → active）
POST /mcp-devices/{id}/credentials 领取 device_token（一次性）
```

## 本地开发

```bash
pnpm install

# 1. 启动 PostgreSQL（任选其一：本地实例或容器）
docker run -d --name brewphase-cloud-pg \
  -e POSTGRES_USER=brewphase -e POSTGRES_PASSWORD=brewphase \
  -e POSTGRES_DB=brewphase_cloud -p 5432:5432 postgres:16-alpine

# 2. 配置环境变量
cp .env.example .env   # 填入 DATABASE_URL 与 Provider 凭据
# Secret 生成：openssl rand -base64 48
# .env 由 `pnpm dev` / `pnpm db:migrate` 自动加载（仅非 production），
# 且不覆盖 shell / 容器已注入的同名变量；不需要再装 dotenv。

# 3. 应用数据库迁移（幂等，可重复执行；不会删库或重置数据）
pnpm db:migrate

# 4. 启动开发服务（tsx watch）
pnpm dev
```

启动后自检：

```bash
curl -s http://127.0.0.1:3000/health   # {"status":"ok",...}
curl -s http://127.0.0.1:3000/ready    # {"status":"ready"}；数据库不可用时 503
```

启动纪律：`DATABASE_URL` 缺失、格式非法、或数据库连不上时进程直接退出（exit 1），
日志里给出具体是哪一项——不会「假装启动成功」。

若本机直连 Google 受阻（授权页能打开，但回调后立刻失败，日志出现
`Google token endpoint is unreachable` 或回调耗时超过 10 秒超时），在 `.env` 里配
`HTTPS_PROXY` 让 Provider 出网走本机代理：

```dotenv
HTTPS_PROXY=http://127.0.0.1:7900   # 换成本机实际代理端口
NO_PROXY=localhost,127.0.0.1        # 可选
```

只支持 HTTP(S) 代理（不支持 SOCKS），隧道之上仍是正常的 TLS 校验（不会关闭证书验证）；
未配置时行为与之前完全一致。

Provider 凭据配置：

- **Google**：Google Cloud Console → OAuth Client（Web application）；
- **GitHub**：Settings → Developer settings → OAuth Apps，不申请任何 scope
  （只读公开资料，邮箱可空）。

### 必须登记四个回调地址（两套路由，容易漏）

Cloud 有**两套** Provider 回调路径，它们只共享 Provider 适配器，事务表、
浏览器状态、`redirect_uri` 校验全部独立：

| 用途 | 路径 |
|---|---|
| Desktop 登录 | `{BASE_URL}/oauth/callback/google`、`{BASE_URL}/oauth/callback/github` |
| **Remote MCP 授权** | `{BASE_URL}/mcp/oauth/callback/google`、`{BASE_URL}/mcp/oauth/callback/github` |

以 `BASE_URL=https://api.phase.commitbrew.com` 为例，Google 与 GitHub 的
控制台里各要填两条（共四条）：

```text
https://api.phase.commitbrew.com/oauth/callback/google
https://api.phase.commitbrew.com/oauth/callback/github
https://api.phase.commitbrew.com/mcp/oauth/callback/google
https://api.phase.commitbrew.com/mcp/oauth/callback/github
```

本地 `BASE_URL=http://127.0.0.1:3000` 时：

```text
http://127.0.0.1:3000/oauth/callback/google
http://127.0.0.1:3000/oauth/callback/github
http://127.0.0.1:3000/mcp/oauth/callback/google
http://127.0.0.1:3000/mcp/oauth/callback/github
```

**漏登记第二条的典型症状**：Desktop 登录一切正常，MCP 授权在 Provider 回调后
立刻 `redirect_uri_mismatch`——因为两套路由各自逐字符校验自己的 `redirect_uri`。

**Provider 侧登记的值必须与 `BASE_URL` 拼出来的字符串逐字符一致**：`localhost`
与 `127.0.0.1` 在 Provider 看来是两个不同的 redirect_uri，混用会直接
`redirect_uri_mismatch`。**不使用通配 redirect URI**，代码侧也是逐字符相等
校验（`mcp-oauth/authorize-flow.ts`、`oauth/authorization.ts`）。

> ChatGPT 自己的 OAuth callback（`https://chatgpt.com/connector/oauth/{callback_id}`）
> 属于 **MCP 客户端**的 `redirect_uri`，走 `mcp_oauth_clients` 注册数据，
> **不要**混进 Google/GitHub Provider 的配置里。

两个 Client Secret 只存在云端环境变量中；Desktop 端零密钥、零 Provider Token。

## 测试

集成测试需要真实 PostgreSQL（不允许用 Mock 代替数据库行为）：

```bash
docker run -d --name brewphase-cloud-test-pg \
  -e POSTGRES_USER=brewphase -e POSTGRES_PASSWORD=brewphase \
  -e POSTGRES_DB=brewphase_cloud_test -p 54329:5432 postgres:16-alpine

pnpm test          # Vitest 自动执行迁移并跑全部集成测试
```

Google/GitHub 由本地 mock provider 服务器替代（真实 HTTP + 真实 JWKS 验签路径，
仅替换身份签发），测试覆盖：身份映射、state/PKCE/授权码一次性、重放检测、
并发刷新、JWT 校验、限流、迁移幂等。

## 数据库迁移

```bash
pnpm db:generate          # 修改 src/db/schema.ts 后生成迁移 SQL
pnpm db:migrate           # 开发环境应用迁移
pnpm db:migrate:prod      # 生产（跑 dist 编译产物，迁移文件随构建复制）
```

迁移由 journal 保证幂等，可安全重复执行。

## 生产部署

### 完整部署手册

**可复现的生产部署流程见 [`deploy/README.md`](deploy/README.md)**：架构、DNS、
四条 Provider 回调、密钥生成、环境变量、**Remote MCP 专用预检**、Docker 构建、
数据库迁移、启动、HTTPS / Discovery / WSS 验收、日志脱敏、备份恢复、更新回滚。

配套文件：

```text
cloud/deploy/
  compose.yaml                 Caddy + Cloud + PostgreSQL 16（单副本、db 不对外）
  Caddyfile                    HTTPS 终结与反向代理（不开访问日志）
  .env.production.example      环境变量模板（只含变量名，无真实值）
  smoke-test.mjs               部署后冒烟测试（HTTP / Discovery / 未授权 MCP）
  README.md                    上述完整流程
```

### 构建与预检

```bash
pnpm build                      # tsc 编译 + 迁移文件复制到 dist/
pnpm preflight:remote-mcp       # 源码预检（读当前 Shell 环境，本地演练用）
```

**生产构建只走 Compose**（`compose.yaml` 固定了镜像名与 build 参数）：

```bash
cd deploy && docker compose --env-file .env.production build cloud
```

在 `cloud/` 下直接 `docker build -t brewphase-cloud .` 仅供**本地开发 / 诊断**，
不要用于生产：它绕过了 compose 的 `image:` 命名，后续 `up` 可能去拉远端镜像。

> `pnpm preflight:remote-mcp` 读的是**当前 Shell** 的变量，不是
> `.env.production`；生产权威预检见下方「镜像内等价预检」（`compose run`）。

多阶段 Dockerfile：全量依赖（编译用）→ TS 编译 → **仅生产依赖** → 运行镜像
（非 root、只带 `dist/` 与生产 `node_modules/`）。运行镜像内不含
typescript / eslint / vitest / drizzle-kit / tsx。

镜像内等价预检（容器里没有 `pnpm` 与源码）——**用 `compose run` 而不是
`docker run --env-file`**，这样拿到的是 Compose 最终注入容器的
`DATABASE_URL`（由 `POSTGRES_*` 拼成），与 `up` 用的是同一份配置：

```bash
cd deploy
docker compose --env-file .env.production run --rm --no-deps cloud \
  node dist/scripts/preflight-remote-mcp.js
```

### 环境变量

- 模板：[`deploy/.env.production.example`](deploy/.env.production.example)
  （只列变量名与生成方式，**无真实值**）；
- 本地开发：`.env.example` → `.env`。

生产环境强制要求（`loadEnv` / `enforceProductionSecrets`）：

- `JWT_SIGNING_KEY`（≥32 字符）、`SESSION_TOKEN_PEPPER`（≥16 字符）——
  缺失或弱密钥时服务拒绝启动；
- `BASE_URL` 必须是 https 纯 Origin、**默认 443 端口**（compose 只发布 80/443），
  且其 hostname 必须与 `BREWPHASE_DOMAIN`（Caddy 的站点名）**逐字一致**——
  两者不一致时 `/health` 与证书检查都能通过，只有 OAuth 回调会 404；
- Google / GitHub 两组凭据必须齐全；
- `GATEWAY_EXPECTED_REPLICAS=1`（>1 拒绝启动）；
- 数据库不可达时启动即失败（exit 1），不假装健康。

**Remote MCP 额外要求**（`loadEnv` 不强制，但预检强制）：

- `MCP_BROWSER_SESSION_KEY` ≥32 UTF-8 字节，且 **≠ `JWT_SIGNING_KEY`**；
- `DATABASE_URL` 必须**逐段**与 Compose 的拼接结果一致：`postgres://` 或
  `postgresql://`、非空用户名与密码、host=`db`、port=`5432`、库名=`POSTGRES_DB`、
  用户名=`POSTGRES_USER`，且不带 query / fragment。完整的失败码表见
  [`deploy/README.md`](deploy/README.md#6-remote-mcp-专用预检首次部署的第-步)。
  留空时服务照常启动、`/health` 照常 200，但 `/mcp`、`/.well-known/*`、
  `/mcp/oauth/*` **全部 404**（`app.ts` 打一条 `mcp_oauth_disabled` warn 就过去）。

生成 Secret：

```bash
openssl rand -base64 48   # JWT_SIGNING_KEY
openssl rand -base64 48   # MCP_BROWSER_SESSION_KEY（必须与上者不同）
openssl rand -base64 32   # SESSION_TOKEN_PEPPER
openssl rand -hex 32      # POSTGRES_PASSWORD（必须 URL 安全，见 deploy/README.md §4）
```

### 部署步骤（Compose：Caddy + Cloud + PostgreSQL 16）

> **所有 compose 命令都必须带 `--env-file .env.production`**——Compose 只自动
> 读项目目录里名为 `.env` 的文件。漏掉会因缺变量直接失败（刻意 fail-closed）。
> 完整运维命令见 [`deploy/README.md`](deploy/README.md)。

```bash
cd deploy
cp .env.production.example .env.production && chmod 600 .env.production
$EDITOR .env.production          # 填入四个回调、密钥、数据库口令（openssl rand -hex 32）

docker compose --env-file .env.production config --quiet   # ① 校验配置可解析
docker compose --env-file .env.production build cloud      # ② 构建
docker compose --env-file .env.production run --rm --no-deps cloud \
  node dist/scripts/preflight-remote-mcp.js                # ③ 预检（失败则到此为止）
docker compose --env-file .env.production run --rm cloud \
  node dist/scripts/migrate.js                             # ④ 迁移（只应用未执行的）
docker compose --env-file .env.production up -d            # ⑤ 启动（cloud 等 db healthy）
docker compose --env-file .env.production ps               # ⑥ 三个容器 healthy、cloud 只有 1 个

curl -fsS https://your-domain/health && curl -fsS https://your-domain/ready   # ⑦ 分别请求
node smoke-test.mjs https://your-domain   # ⑧ 冒烟：HTTP + Discovery + 未授权 MCP
# ⑨ WSS 真机验收见 deploy/README.md §12
```

> ③ 必须在 ④ 之前：预检没过就不要迁移、不要启动。
> ⑦ 的 `/health`（进程存活）与 `/ready`（数据库可用）**不能互相替代**——
> 容器 `healthy` 只代表 `/health` 200。

- 只有 Caddy 发布 80/443；Cloud 与 PostgreSQL **不发布端口**
  （PostgreSQL 在 `internal: true` 网络内，宿主与公网均不可达）。
- **迁移不随启动自动执行**：显式跑、失败即失败，不会出现
  「服务起来了但 schema 是旧的」。
- 反向代理（Nginx/Caddy）终结 TLS。**TRUST_PROXY 的信任边界**：
  - `TRUST_PROXY=false`（默认）：完全忽略 `X-Forwarded-For`，客户端伪造头不影响限流与审计 IP。
  - `TRUST_PROXY=true`：只信任**右端**（离服务最近）代理写入的条目，从 XFF 右端跳过
    `TRUST_PROXY_HOPS`（默认 1，可选 1–5）个可信代理条目后取客户端 IP。**在 `HOPS` 与真实
    链路匹配的前提下**，客户端伪造的左侧条目无法改变选中值，也无法借此创建新限流桶
    （桶总量另有硬上限）；`HOPS` 配错时两个方向都会出问题，见下。选中的条目必须是合法
    IPv4/IPv6 字面量，否则连同「头缺失 / 层数不足 / 头超长」一起回退 socket 地址——带上端口的
    地址、主机名、字符填充都不会被当成限流键。
  - **`TRUST_PROXY_HOPS` 的含义取决于代理是追加式还是覆盖式，两者不能混用同一套取值：**

    **追加式（append）** —— 每层可信代理把来源 IP **追加**到 XFF 右侧，链路逐跳保留。
    `TRUST_PROXY_HOPS` **必须准确匹配**真实追加链路上的可信代理层数：单层代理为 1，两层为 2。
    配错的方向是**双向的**，不能靠加大取值来提高安全性：

    - **过小**（小于真实层数）：选中位置**右**移，落到**上游代理的地址**上（该条目由最近一跳
      代理追加，记录的是它看到的对端）——取到的是代理 IP，不是客户端 IP（**不会回退 socket**）。
      该代理之后的所有用户共享同一个限流桶，正常用户互相拖累触发 429，属过度拦截而非绕过
      （fail-closed）。
    - **过大**（大于真实层数）：选中位置**越过**客户端条目进入更左侧，后果取决于客户端有没有
      自带 XFF 条目：
      - 没自带：条目数不足，回退 socket 地址（有代理时 socket 对端就是最近一跳代理）→
        所有用户共享一个桶（fail-closed）。
      - 自带了伪造条目：选中的正是**攻击者自己填的值** → 每个伪造值一个新桶，限流被完全绕过
        （**fail-open**）。

    两个方向的共同点是**都不会报错**，只会静默地把限流身份算错。因此部署时必须按真实链路
    核对一次实际到达应用的 XFF，数清右端由可信代理写入的条目数，并以该值配置 `HOPS`；
    不要凭猜测取值，更不要「多加几层更安全」。

    **覆盖式（overwrite）** —— 代理用客户端 IP **覆盖**整个 XFF，只保留单条。
    `HOPS=1` 仅适用于能保证该条目就是原始客户端 IP 的**单层**覆盖场景。
    **多层覆盖式代理不能设成 `HOPS=2` 或更大**：覆盖式下 XFF 恒为单条，`HOPS≥2` 会因
    「条目数不足」回退 socket 地址，而这些请求的 socket 对端是同一个上游代理，结果是
    **所有用户共享同一个限流桶**，正常用户会被互相拖累触发 429。
  - **推荐做法**：生产使用经过明确配置的**追加式**代理链，并保证应用端口不能被绕过可信代理
    直接访问；若只有单层代理，覆盖式也可以（最简单）。
  - **部署红线**：开启 TRUST_PROXY 的前提是服务端口不可被客户端绕过代理直接访问，
    否则直连请求自带的 XFF 头会占据右端位置。
  - Nginx 单层（推荐，覆盖式，最简单可靠）：

    ```nginx
    proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖式：客户端无法注入
    # 应用环境：TRUST_PROXY=true TRUST_PROXY_HOPS=1
    ```

  - Nginx 追加式（需要保留链路时）：应用取右端第 N 跳，`HOPS` 与真实层数匹配时伪造左侧条目无效：

    ```nginx
    # 单层代理
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 追加式
    # 应用环境：TRUST_PROXY=true TRUST_PROXY_HOPS=1（右端即真实客户端 IP）
    ```

    ```nginx
    # 两层追加式（例如 CDN + 本机 Nginx）：XFF = "客户端, CDN" → HOPS=2
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # 应用环境：TRUST_PROXY=true TRUST_PROXY_HOPS=2
    ```

  - Caddy：默认自动设置 `X-Forwarded-For`（追加式），按追加式配置，`HOPS` 取链路上的
    代理层数。
- 密钥轮换：设置新的 `JWT_SIGNING_KEY` 并把旧值放入 `JWT_SIGNING_KEY_PREVIOUS`，
  存量 Access Token 验证平滑过渡；Refresh Token 不受签名密钥影响。
- CORS 默认关闭；如需开放（例如未来 Web 客户端），显式设置 `CORS_ORIGINS`。

### 反向代理的访问日志必须关闭

**OAuth 回调是带凭据的 URL**：`/oauth/callback/<provider>?code=…&state=…`。一次性授权码与
state 都在这条查询串里，而反向代理的默认访问日志会**原样记录 URI**——等于把授权码写进磁盘，
日志一旦被读取（运维、备份、日志采集）就等同于凭据泄漏。

因此反代侧不要开启访问日志（Caddy 用全局 `log { output discard }`，Nginx 用 `access_log off;`），
需要排障时只保留错误日志。应用自身的请求日志只记方法/路径/状态/耗时，不记查询串，可以放心留。

### 目标主机 IPv6 不可达时，必须关掉 Node 的地址族自动选择

Node 20+ 默认启用 `autoSelectFamily`（Happy Eyeballs）：解析到多个地址时会并行尝试，
**约 250ms 后放弃并让整个请求失败**。如果目标域名同时有 AAAA 记录、而运行环境到该
IPv6 不可达，表现会是 Provider 请求以 `ETIMEDOUT` 快速失败——看起来像凭据或配置错误，
实际是连接策略问题。

典型症状：授权页能打开、回调立刻失败（几百毫秒级），而同一台机器用 `curl` 访问
同一个域名却成功（curl 会自己逐个地址重试）。Google 的 `oauth2.googleapis.com` /
`www.googleapis.com` 都有 AAAA 记录；GitHub 只有 A，所以「GitHub 能登、Google 不能」是
这个问题的强特征。

处理方式（容器里用环境变量即可，不需要改代码）：

```yaml
environment:
  NODE_OPTIONS: "--max-old-space-size=<MB> --no-network-family-autoselection"
```

这条只影响地址族选择策略，**不降低 TLS 校验**（证书链与主机名校验照常）。不要用
`--dns-result-order=ipv4first` 代替：它只调整解析结果顺序，仍会发起 IPv6 连接尝试，
问题依旧。

## 安全边界（实现纪律）

- refresh token / OAuth 授权码 / 双 State / nonce / IP：数据库只存
  SHA-256 哈希（带 pepper 域分隔），明文永不落库、不打日志。
- 身份锚点 = `(provider, provider_subject)`；相同邮箱绝不自动合并用户。
- Provider 授权码只能在 Cloud 侧使用；Google/GitHub Access Token 用完即弃，
  绝不返回 Desktop。
- Desktop 回调地址严格限定 `http://127.0.0.1:<port>/callback`；
  回调错误重定向只指向事务中存储的合法地址（无开放重定向）。
- Refresh Token Rotation + Token Family 重放检测（30 秒并发宽限窗口，
  窗口外重放撤销整族）。
- 限流（每 IP 固定窗口，进程内存实现；水平扩容时需换共享存储实现）。Map 实际桶数量上界为
  `maxBuckets` + 已创建 overflow 桶的端点数（overflow 桶自身也占一个 Map 条目）：生产固定
  `maxBuckets = 10000`、不读环境变量，当前三个端点因此理论上界 **10003**。超出后未知来源进入
  按端点共享的 overflow 桶——劣化方向是「全体限速」，不会因伪造来源无限建桶而耗尽内存。
