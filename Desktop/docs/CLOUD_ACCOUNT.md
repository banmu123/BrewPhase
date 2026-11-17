# Cloud Account（Desktop Phase 1.2）

Electron 桌面端的 Cloud Account 最小登录闭环：**登录 → 恢复 → 退出**。

服务端一行没改：Desktop 直接消费 `cloud/` 现有的 `/oauth/*` 与 `/auth/*` 契约
（Phase 1.1 / 1.1.2 的实现即本阶段唯一认证依据）。

---

## 1. 范围

做：

- 系统浏览器授权（Google / GitHub）、本机回环回调、一次性授权码兑换；
- Refresh Token 用 safeStorage 加密落盘，重启恢复会话；
- 退出登录：撤销服务端 token family + 删除本机凭据；
- 设置页「云账户」分区（未登录 / 登录中 / 已登录 / 失败 / 退出）。

不做（本阶段边界，见任务书 §6）：iOS 登录、云端数据同步、账户注销、身份解绑、
多设备管理 UI、复杂账户中心、云端数据迁移、自动上传本地数据。

---

## 2. 架构

```
┌────────────────────────── Renderer（React）──────────────────────────┐
│ SettingsPage / AccountSection                                        │
│   api.account.status / login(provider) / cancelLogin / signOut       │
│   api.account.onChanged(snapshot)   ← 只有安全 DTO，没有 Token        │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ preload（逐条列出的桥，不透传 ipcRenderer）
┌───────────────────────────────▼──────────────────────────────────────┐
│ ipc/register.ts   account:status / login / cancel-login / sign-out    │
│   入参 zod 校验；login 只接受 provider 名字                           │
└───────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────▼──────────────────────────────────────┐
│ main/account/account-service.ts   ← 唯一状态机（signed-out/pending/…）│
│   ├── credentials.ts              safeStorage 密文（0600）            │
│   ├── oauth-callback-server.ts    127.0.0.1:<random>/callback 一次性  │
│   └── cloud-client.ts             注入式 FetchLike + 超时 + 错误归一  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ https（远程）/ http（仅回环 dev）
┌───────────────────────────────▼──────────────────────────────────────┐
│ BrewPhase Cloud（cloud/，未修改）                                     │
│   /oauth/authorize → Provider → /oauth/callback/:provider → /oauth/token
│   /auth/refresh · /auth/logout · /auth/me                             │
└──────────────────────────────────────────────────────────────────────┘
```

服务端**只**接受 `http://127.0.0.1:<port>/callback` 这一种 redirect_uri
（`cloud/src/security/crypto.ts` 的 `isValidLocalCallbackUri`），因此 Desktop 没有
深链实现，也不碰现有 `brewphase://pair` 局域网配对二维码。

---

## 3. OAuth 完整流程

```
Desktop                     系统浏览器                 Cloud                 Google/GitHub
   │  ①起回调(127.0.0.1:0)      │                        │                       │
   │  ②生成 state / verifier    │                        │                       │
   │    challenge=S256(v)       │                        │                       │
   │  ③openExternal(authorize) ─▶│  GET /oauth/authorize ▶│                       │
   │                            │                        │ ④落库 transaction      │
   │                            │                        │   (双 state 哈希 + PKCE)│
   │                            │◀──── 302 Provider ─────│                       │
   │                            │───────────────────────────────────────────────▶│
   │                            │◀────────────── 授权码 + state ─────────────────│
   │                            │ GET /oauth/callback/:p ▶│                      │
   │                            │                        │ ⑤校验/消费 transaction │
   │                            │                        │ ⑥换 Provider 身份      │
   │                            │                        │ ⑦建用户 + 一次性授权码  │
   │◀── 302 http://127.0.0.1:p/callback?code&state ──────│                       │
   │  ⑧校验 Host / 路径 / state（常量时间）              │                       │
   │  ⑨POST /oauth/token {code, verifier, redirect_uri} ▶│                       │
   │                            │                        │ ⑩原子消费码 + PKCE 校验 │
   │◀──── {access_token, expires_in, refresh_token} ─────│                       │
   │  ⑪GET /auth/me（Bearer）──▶│                        │                       │
   │  ⑫safeStorage 加密落盘 → 广播 account:changed        │                       │
```

关键点：

| 项 | 归属 | 说明 |
| --- | --- | --- |
| `state`（client state） | Desktop 生成、Desktop 校验 | 43 字符 base64url（服务端要求 32–128）；服务端只存哈希，最后原样回传 |
| Provider state | Cloud 生成、Cloud 校验 | Desktop 完全不接触 |
| PKCE verifier | Desktop 生成，只在内存 | 43 字符 base64url；**不落盘、不出进程**，兑换后随栈帧销毁 |
| PKCE challenge | 传给 Cloud | `base64url(SHA256(verifier))`，服务端只接受 S256 |
| 授权码 | Cloud 签发 | 一次性；服务端 `SELECT … FOR UPDATE` + 条件 UPDATE 原子消费 |
| Provider Token | 只在 Cloud 栈帧里 | 不落库、不回传、不打日志（服务端实现） |

回调服务器边界（`oauth-callback-server.ts`）：

- 只 `listen(127.0.0.1, port: 0)`，端口写进 redirect_uri；
- 只接受 `GET /callback`：其它方法 405、其它路径 404，且**都不改变流程状态**；
- `Host` 必须是 `127.0.0.1:<port>`（防 DNS rebinding）；
- `state` 不匹配 → 400 且继续等待（伪造请求不能把这次登录打死）；
- 成功/失败/超时/取消后立即关端口，重复请求最多拿到 409；
- 超时 5 分钟（= 服务端 transaction TTL 300s）；
- 响应页是**静态 HTML**，不回显任何查询参数（授权码不会被反射进页面）。

---

## 4. Token 存储与安全边界

| 数据 | 位置 | 生命周期 | 谁能读 |
| --- | --- | --- | --- |
| Refresh Token | `<userData>/account/credentials.json` 的 safeStorage 密文 | 服务端 30 天，每次刷新轮换 | 主进程 |
| Access Token | 主进程内存 | 600–900s（服务端钳制） | 主进程 |
| PKCE verifier / state | 主进程内存（函数栈） | 单次登录 | 主进程 |
| 账户资料（id / 名称 / 头像 URL / created_at） | 同一份密文里 | 随会话 | 主进程 → Renderer 只拿 DTO |
| 局域网同步 token | 原有 `sync` 表 | 不变 | 未改动 |

- 外层文件只有 `{ version, alg: "safeStorage-v1", payload }`：**连 userId 都不在明文里**；
- 目录 0700、文件 0600，先写 `.tmp` 再 rename（中途崩溃不会留下半截 JSON）；
- `safeStorage.isEncryptionAvailable()` 为假（典型是 Linux 没有 keyring）时：
  **拒绝落盘**，本次登录只存在于内存，快照里 `storage: "unavailable"`，界面如实提示；
  **不存在明文降级路径**；
- 解密失败（密钥变了 / 密文被改）→ 按未登录处理并保留原文件，下次登录成功覆盖；
- 日志只说「失败原因 / HTTP 状态 / 服务端错误码」，不带请求体、响应体或 Authorization。

---

## 5. IPC 清单

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `account:status` | 无 | `AccountSnapshot` |
| `account:login` | `{ provider: "google" \| "github" }` | 完成后的 `AccountSnapshot`（最长等 5 分钟） |
| `account:cancel-login` | 无 | `AccountSnapshot` |
| `account:refresh` | 无 | `AccountSnapshot`（手动重新确认会话；离线保持登录） |
| `account:sign-out` | 无 | `AccountSnapshot` |
| `account:changed`（主进程 → 全部窗口） | — | `AccountSnapshot` |

`AccountSnapshot` 字段：`state` / `provider` / `user` / `storage` / `cloudBaseUrl` /
`pending` / `notice` / `checking` / `verifiedAt`。**没有任何 token 字段**，也没有
「提交 code / state / token 完成登录」的通道。

---

## 6. Local-first 红线对照

| 红线 | 落点 |
| --- | --- |
| 不登录仍可完整使用本地功能 | 账户层只被 `SettingsPage` 引用；IPC 注册表里其它通道零改动 |
| Cloud 不可用不影响启动 | `restore()` 只读本地密文；网络校验 `void verify()` 后台跑，异常全部落成 notice |
| Token 过期不影响读本地记录 | 账户层与 `brewphase.db` 无任何关联；数据读取路径不经过 `account-service` |
| 退出登录不删本地数据 | `signOut()` 只 `store.clear()`（一个凭据文件） |
| 不自动上传本地记录 | 除 `/auth/*` 与 `/oauth/*` 外没有任何出站请求 |
| 不把本地数据与 userId 绑定 | 没有新增表、没有新增列、没有迁移 |
| 不修改局域网同步认证 | `sync-service` / `pairing-service` / `sync/auth.ts` 一行未动 |

---

## 7. 失败与降级

| 场景 | 快照状态 | notice | 凭据 |
| --- | --- | --- | --- |
| 用户取消 / 超时 | signed-out | `cancelled` / `timeout` | 无 |
| 授权页拒绝 | signed-out | `provider-denied` | 无 |
| state 不匹配 | 流程继续；只有超时才结束 | — | 无 |
| 兑换 400/401 | signed-out | `exchange-failed`（detail=服务端码） | 无 |
| 兑换网络失败 / 超时 | signed-out | `cloud-unreachable` / `cloud-timeout` | 无 |
| 恢复时 refresh 401 | signed-out | `session-expired` | 已清除 |
| 恢复时网络失败 | **signed-in** | `cloud-unreachable` | 保留 |
| 解密失败 | signed-out | `storage-failed`（detail=decrypt-failed） | 文件保留 |
| 安全存储不可用 | signed-out（登录后 signed-in 但仅内存） | `storage-unavailable` | 不落盘 |
| 退出时服务端不可达 | signed-out | 无（仅日志） | 已清除 |

---

## 8. 已知限制

1. **没有已部署的 Cloud**：默认基地址是 `http://127.0.0.1:3000`（`cloud/.env.example`
   的默认端口），真实联调必须设 `BREWPHASE_CLOUD_BASE_URL`。设置页会显示实际地址。
   远程 http 会被拒绝（只允许回环），避免授权码与 Token 明文过网。
2. **兑换成功后 `/auth/me` 失败即视为登录失败**：授权码已消费，用户需要重新授权。
   没有保存「有 refresh token 但没资料」的半套会话。
3. 登录期间没有任何进度轮询；状态只靠 `account:changed` 广播。若 Renderer 崩溃重载，
   主进程仍持有 pending 状态，重载后 `status()` 能拿到（pending 浏览器流程不受影响）。
4. 没有后台定时刷新：只在启动恢复、用户点「刷新状态」与（未来）调用云 API 时刷新。
5. Linux 无 keyring 时登录状态不持久（设计如此，不写明文）。

---

## 9. 真实联调人工配置清单

Cloud（`cloud/.env`）：

```
NODE_ENV=development
BASE_URL=http://127.0.0.1:3000        # 生产必须 https
DATABASE_URL=postgres://…              # 需要可用的 Postgres
GOOGLE_CLIENT_ID=…                     # Web application 类型
GOOGLE_CLIENT_SECRET=…
GITHUB_CLIENT_ID=…                     # OAuth App
GITHUB_CLIENT_SECRET=…
JWT_SIGNING_KEY=…                      # ≥32 字符（openssl rand -base64 48）
SESSION_TOKEN_PEPPER=…                 # ≥16 字符
```

Provider 控制台：

- Google：Authorized redirect URI = `{BASE_URL}/oauth/callback/google`；
- GitHub：Authorization callback URL = `{BASE_URL}/oauth/callback/github`。

Desktop：

- `BREWPHASE_CLOUD_BASE_URL` 指向同一个 `{BASE_URL}`（不设则默认本地 3000）；
- 系统浏览器能打开 `https://accounts.google.com` / `https://github.com`；
- macOS 需要 Keychain 可用（safeStorage）；Linux 需要 keyring（否则只能内存态登录）。

联调步骤：设置 → 云账户 → 使用 Google/GitHub 登录 → 浏览器授权 → 回到应用看「已登录」；
退出应用重开确认仍为已登录；点「退出登录」后重启确认已是未登录。


---

## 10. 本阶段实测结果（2026-11-17，macOS / feature/auth-electron）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | 通过（node + web 两个 project） |
| 单测 | `pnpm test` | 72 文件 **949 条通过**（新增 62 条：credentials 12 / callback 10 / cloud-client 16 / service 24） |
| build | `pnpm build` | 通过（main / preload / renderer） |
| e2e | `pnpm e2e` | **79 passed / 14 skipped / 1 failed** |

唯一失败：`card-workspace.e2e.spec.ts:170`「view bounds 跟随」。
**在未包含本阶段改动的 HEAD 基线（fb2c291）上以完全相同的方式失败**
（`Expected <= 3, Received 304`），属无 GPU 环境的既有问题，与本阶段无关。

新增 e2e（`tests/e2e/account.e2e.spec.ts`，3 条全绿）：

1. 未登录启动 → 云账户分区、两个登录入口、本地优先说明；回 Studio 首页正常；
2. 预置「合法信封 + 坏密文」→ 启动不崩、按未登录处理、给出诚实提示、登录入口仍在；
3. 用真实 safeStorage 现生成密文 → 重启后**已登录**；服务地址指向不可达回环端口时
   仍保持登录（只提示「无法连接云服务」）→ 二次确认退出 → 凭据文件删除、`brewphase.db`
   仍在 → 再重启确认未登录。

Desktop 没有 lint 脚本与 ESLint 配置（`package.json` 无 `lint`，仓库无 eslint 配置文件），
因此「lint」一项在本阶段无法执行；`cloud/` 侧未改动，其 ESLint 不适用。
