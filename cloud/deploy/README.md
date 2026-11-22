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
openssl rand -base64 24   # POSTGRES_PASSWORD      （数据库口令）
```

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
$EDITOR .env.production      # 填入 §3、§4 的真实值
```

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
| Caddy | `ACME_EMAIL`、`BREWPHASE_DOMAIN` |

**代理信任边界**：`TRUST_PROXY=true` + `TRUST_PROXY_HOPS=1` 只在
「cloud:3000 未发布端口、无法绕过 Caddy 直连」的前提下安全——
`compose.yaml` 已保证这一点。**不要**为了修限流去加大 `HOPS`：
取值过大会让客户端伪造的 XFF 条目被选中（限流被绕过），过小则同代理后的
用户共享一个限流桶。追加式代理取真实层数，覆盖式只能是 1。

---

## 6. Remote MCP 专用预检（必须先跑）

```bash
# 构建前（源码）
cd cloud && pnpm preflight:remote-mcp

# 构建后（镜像内，与生产同环境）
docker run --rm --env-file deploy/.env.production brewphase-cloud \
  node dist/scripts/preflight-remote-mcp.js
```

预检项（任一失败即**非零退出**，部署不继续）：

| 检查 | 失败码 |
|---|---|
| `NODE_ENV=production` | `node_env_not_production` |
| `BASE_URL` 公网 HTTPS 纯 Origin（无 path/query/fragment、非回环） | `base_url_*` |
| `DATABASE_URL` 已配置 | `database_url_missing` |
| `JWT_SIGNING_KEY` ≥32 字符 | `jwt_key_missing` / `jwt_key_too_short` |
| `SESSION_TOKEN_PEPPER` ≥16 字符 | `pepper_missing` / `pepper_too_short` |
| Google / GitHub 四个变量成对齐全 | `google_*` / `github_*` |
| `MCP_BROWSER_SESSION_KEY` ≥32 UTF-8 字节 | `mcp_browser_session_key_missing` / `_too_short` |
| `MCP_BROWSER_SESSION_KEY` ≠ `JWT_SIGNING_KEY` | `mcp_browser_session_key_reused_from_jwt` |
| `GATEWAY_EXPECTED_REPLICAS=1` | `gateway_replicas_not_single` |
| `resolveMcpOAuthEnablement()` 通过 | `mcp_oauth_<reason>` |

**预检只输出变量名与判定，绝不打印任何 Secret 的值**（测试
`tests/scripts/preflight-remote-mcp.test.ts` 用哨兵值断言过）。

为什么要这一步：`MCP_BROWSER_SESSION_KEY` 缺失时服务**照常启动**、
`/health` 照常 200，只是 `/mcp`、`/.well-known/*`、`/mcp/oauth/*` 全部 404
（`src/app.ts:120-130` 打一条 warn 就过去了）。这是最难查的一类故障。

---

## 7. Docker 构建

```bash
cd cloud
docker build -t brewphase-cloud:latest .
```

多阶段：依赖安装 → TS 编译 → 运行镜像（**非 root**、只带生产依赖与 `dist/`）。
构建产物包含 `dist/db/migrations/`（由 `scripts/copy-assets.mjs` 复制）。

---

## 8. 数据库迁移

迁移由 **Drizzle journal** 驱动（`src/db/migrations/meta/_journal.json`），
**脚本里不写死版本号**；当前有 `0000`–`0005`，以后新增迁移无需改脚本。

```bash
# 先于服务启动执行（compose 里 cloud 依赖 db 健康，但迁移要显式跑）
docker compose run --rm cloud node dist/scripts/migrate.js
```

保证：

- **只应用尚未执行的迁移**（journal 比对，已应用的跳过）；
- **重复执行安全**（幂等）；
- **不清空数据库、不重置用户、不改已应用的迁移文件**；
- **迁移失败 → 非零退出**，此时不要把服务标记为部署成功。

> 迁移只需要 `DATABASE_URL`，刻意不走完整 env 校验
> （`src/scripts/migrate.ts`），因此可以在服务凭据尚未注入的 Job 里先行执行。

---

## 9. 服务启动

```bash
cd cloud/deploy
docker compose up -d
docker compose ps          # 三个容器都要 healthy
```

`cloud` 依赖 `db` 的 `service_healthy`，数据库没起来不会启动。

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
> 部署后额外确认一次 `docker compose ps` 里 `cloud` 只有 1 个容器。

---

## 12. WSS 真机验收（必须人工执行）

脚本无法伪造真实 Desktop，以下必须用 **真实 BrewPhase Desktop** 逐步确认：

```bash
# 1) DNS 与证书
dig +short A api.phase.commitbrew.com
echo | openssl s_client -connect api.phase.commitbrew.com:443 \
  -servername api.phase.commitbrew.com 2>/dev/null | openssl x509 -noout -subject -dates

# 2) 服务端日志：观察 Upgrade 与握手
docker compose logs -f cloud | grep -E 'link_upgrade_accepted|link_upgrade_rejected|link_established|link_hello_timeout|link_handshake_rejected'
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
| 8 | 重启后重连 | `docker compose restart cloud` → Desktop 按退避重连 → 再次 `link_established` |
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
docker compose logs -f --tail=200 cloud
docker compose logs cloud 2>&1 | grep -E 'link_|http_request|mcp_' | tail -50
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

```bash
# ── 备份（升级前必做）────────────────────────────────────────────────────
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --no-owner --clean --if-exists | gzip > "backup-$(date +%Y%m%d-%H%M%S).sql.gz"

# 只备份 schema+数据的自定义格式（可选择性恢复）
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -f /tmp/dump.dump && docker compose cp db:/tmp/dump.dump ./dump.dump

# ── 恢复 ────────────────────────────────────────────────────────────────
gunzip -c backup-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# 自定义格式
docker compose cp ./dump.dump db:/tmp/dump.dump
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists /tmp/dump.dump

# ── 卷级快照（整机迁移 / 灾难恢复）──────────────────────────────────────
docker compose stop db
docker run --rm -v brewphase_pgdata:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/pgdata-$(date +%Y%m%d).tar.gz -C /data .
docker compose start db
```

- **备份文件视为敏感数据**：含用户账号、设备、授权记录。放服务器本地或
  加密后异地，**不进 Git**、不进 issue 附件。
- **升级前必须先备份**（§15）。
- 卷说明：`pgdata` 是命名卷，`docker compose down` **不会**删它；
  `docker compose down -v` **会删**——除非你明确要销毁数据，否则不要带 `-v`。

---

## 15. 更新与回滚

```bash
# ── 升级 ────────────────────────────────────────────────────────────────
cd cloud && git fetch && git checkout <new-sha> && cd deploy

pnpm --dir .. preflight:remote-mcp            # 新版本可能引入新的必填项
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  | gzip > "pre-upgrade-$(date +%Y%m%d-%H%M%S).sql.gz"   # ① 先备份

docker compose build cloud                    # ② 构建新镜像
docker compose run --rm cloud node dist/scripts/migrate.js   # ③ 迁移（只加不减）
docker compose up -d cloud                    # ④ 滚一个容器（单副本 = 短暂中断）
docker compose ps                             # ⑤ 确认 healthy、只有一个 cloud
BASE_URL=… node ../smoke-test.mjs             # ⑥ 冒烟

# ── 回滚（代码）─────────────────────────────────────────────────────────
cd .. && git checkout <previous-sha> && cd deploy
docker compose build cloud && docker compose up -d cloud
# 迁移是**只增不减**的：回滚代码通常不需要回滚 schema。
# 若新迁移破坏了旧代码，才用 pre-upgrade 备份恢复——那是最后手段，
# 会丢掉升级后写入的数据，执行前必须再确认一次备份可用。

# ── 回滚（数据）─────────────────────────────────────────────────────────
docker compose stop cloud
gunzip -c pre-upgrade-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker compose up -d cloud
```

**顺序纪律**：备份 → 构建 → 迁移 → 启动 → 冒烟。任何一步失败就停在那一步，
不要「先起服务再看」——迁移失败时服务可能起得来但行为是错的。

---

## 16. 上线前自查清单

- [ ] `pnpm preflight:remote-mcp` 通过（源码与镜像内各跑一次）
- [ ] 四个 Provider 回调地址全部登记且逐字符一致
- [ ] `.env.production` 存在、`chmod 600`、**未进 Git**
- [ ] `docker compose config` 校验通过（`compose.yaml` 语法合法）
- [ ] 只有 Caddy 发布 80/443；`docker compose ps` 中 cloud/db 无宿主端口
- [ ] `GATEWAY_EXPECTED_REPLICAS=1`，`cloud` 容器数 = 1
- [ ] `TRUST_PROXY`/`TRUST_PROXY_HOPS` 与真实单层链路一致
- [ ] Caddyfile 通过 `caddy validate`
- [ ] HTTPS 证书有效、HTTP 跳转 HTTPS
- [ ] `smoke-test.mjs` 全部 PASS
- [ ] WSS 真机验收 9 项完成，且 Host/Origin 负例仍 403
- [ ] 升级前备份已生成并验证可读
- [ ] 日志抽查无 query、无 Authorization、无工具正文
