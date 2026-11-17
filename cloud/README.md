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
GET  /oauth/callback/google     Google OIDC 回调
GET  /oauth/callback/github     GitHub OAuth 回调
POST /oauth/token               一次性授权码 + PKCE → access/refresh token

POST /auth/refresh              Refresh Token Rotation
POST /auth/logout               撤销整个 token family
GET  /auth/me                   当前用户资料（Bearer JWT）
GET  /auth/identities           当前用户的第三方身份列表（Bearer JWT）
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

# 3. 应用数据库迁移
pnpm db:migrate

# 4. 启动开发服务（tsx watch）
pnpm dev
```

Provider 凭据配置：

- **Google**：Google Cloud Console → OAuth Client（Web application），
  Authorized redirect URI 填 `{BASE_URL}/oauth/callback/google`，
  scope 只需 `openid email profile`。
- **GitHub**：Settings → Developer settings → OAuth Apps，
  Authorization callback URL 填 `{BASE_URL}/oauth/callback/github`，
  不申请任何 scope（只读公开资料，邮箱可空）。

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

### 构建

```bash
pnpm build        # tsc 编译 + 迁移文件复制到 dist/
docker build -t brewphase-cloud .
```

### 环境变量

见 `.env.example`。生产环境强制要求：

- `JWT_SIGNING_KEY`（≥32 字符）、`SESSION_TOKEN_PEPPER`（≥16 字符）——
  缺失或弱密钥时服务拒绝启动；
- `BASE_URL` 必须是 https（JWT iss 同时来自它）；
- Google / GitHub 两组凭据必须齐全；
- 数据库不可达时启动即失败（exit 1），不假装健康。

生成 Secret：

```bash
openssl rand -base64 48   # JWT_SIGNING_KEY
openssl rand -base64 32   # SESSION_TOKEN_PEPPER
```

### 部署步骤（单容器 + 托管 Postgres）

```bash
# 1. 应用迁移（先于服务启动）
docker run --rm --env-file .env brewphase-cloud node dist/scripts/migrate.js

# 2. 启动服务
docker run -d --name brewphase-cloud --env-file .env -p 3000:3000 brewphase-cloud

# 3. 健康检查
curl https://your-domain/health   # {"status":"ok",...}
curl https://your-domain/ready    # {"status":"ready"}
```

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
