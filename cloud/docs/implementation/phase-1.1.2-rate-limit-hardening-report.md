# BrewPhase Phase 1.1.2 — Rate Limit Hardening 实施报告

> 日期：2026-11-17 · 分支：`feature/cloud-account-phase-1.1`
> 输入：`docs/reviews/phase-1.1.1-final-review.md`（第二轮独立审查，PASS WITH CONDITIONS）
> 范围纪律：只处理 **N-1 / N-2**，顺手修正 **N-3** 文档；不扩大功能，不碰 N-4 ~ N-8。
> 结果总览：**N-1 / N-2 / N-3 全部完成；测试 91 → 113（新增 22 条，全部通过）；四项工程门禁全绿；无迁移。**
> Git 纪律：**未 commit、未 push、未 merge**，全部改动留在工作区等待人工审查。

---

## 1. 实际基线

| 项 | 任务书预期 | 实际 | 说明 |
|---|---|---|---|
| 分支 | `feature/cloud-account-phase-1.1` | `feature/cloud-account-phase-1.1` | ✅ 一致 |
| HEAD | `238fc96` | **`32ceb58`** | ⚠️ 偏差，见下 |
| 工作区 | 干净 | 干净 | ✅ |

**HEAD 偏差说明**：`32ceb58`（`docs(review): Phase 1.1.1 第二轮独立审查报告`）是上一轮审查结束后按人工指令提交并推送的成果，只含两份文档：

```
 .workbuddy/memory/2026-11-17.md          |  35 ++++
 docs/reviews/phase-1.1.1-final-review.md | 324 +++++++++++++++++++++
```

`git diff --name-only 238fc96..32ceb58 -- cloud/` **为空**，即代码基线与任务书声明的 `238fc96` 完全一致。因此本阶段以 `32ceb58` 为实际起点，`cloud/` 部分等价于 `238fc96`。未切换分支、未清理任何文件。

---

## 2. 修改文件清单

### 源码（4 个）

| 文件 | 问题 | 变更 |
|---|---|---|
| `cloud/src/security/rate-limit.ts` | N-1 + N-2 | ① `IP_ENTRY_PATTERN` 正则 → `node:net` 的 `isIP()`；② 新增 `maxBuckets` 选项（默认 `DEFAULT_MAX_BUCKETS = 10_000`）与按端点共享的 overflow 桶；③ 新增只读统计 `rateLimitStats()`（仅计数，不含桶键）；④ 导出 `DEFAULT_MAX_BUCKETS` 作为单一事实源 |
| `cloud/src/env.ts` | N-2 | `rateLimit` 配置增加 `maxBuckets`，取值 `DEFAULT_MAX_BUCKETS`——**刻意不读环境变量** |
| `cloud/src/routes/auth.ts` | N-2 | `authLimiter` 透传 `maxBuckets` |
| `cloud/src/routes/oauth.ts` | N-2 | `authorizeLimiter` / `tokenLimiter` 透传 `maxBuckets` |

### 测试（4 个）

| 文件 | 变更 |
|---|---|
| `cloud/tests/security/rate-limit-buckets.test.ts` | **新增**：N-2 的 5 个用例（上限边界、按端点 overflow、增长封顶、并发、默认常量） |
| `cloud/tests/security/trusted-proxy.test.ts` | **移除**名不副实的 `bucket cap` 用例；新增 N-1 严格 IP 校验 18 条（合法 5 + 同值 1 + 非法 10 + 空头 1 + 超长 1） |
| `cloud/tests/helpers/env.ts` | `makeTestEnv` 接受 `TestEnvOverrides`（允许 `rateLimit` 部分覆盖）；默认 `maxBuckets: DEFAULT_MAX_BUCKETS` |
| `cloud/tests/helpers/harness.ts` | `createHarness` 同步改用 `TestEnvOverrides` |

### 配置与文档（2 个）

| 文件 | 变更 |
|---|---|
| `cloud/README.md` | N-3：明确区分追加式 / 覆盖式代理的 HOPS 语义；新增两层追加式示例；写清「多层覆盖式不能设 `HOPS≥2`」；安全边界段补桶上限说明 |
| `cloud/.env.example` | N-3：`TRUST_PROXY_HOPS` 注释补追加式 / 覆盖式差异 |

### 报告（1 个，本文件）

`cloud/docs/implementation/phase-1.1.2-rate-limit-hardening-report.md`（目录为本次新建）

---

## 3. N-1：严格 IP 地址校验

### 修复前

```ts
/** X-Forwarded-For 单条目的宽松 IP 形态校验（IPv4 / IPv6 字符集）。 */
const IP_ENTRY_PATTERN = /^[0-9a-fA-F.:]{1,45}$/;
...
if (candidate && IP_ENTRY_PATTERN.test(candidate)) return candidate;
```

这是**字符集检查**，不是 IP 解析。实测接受 `203.0.113.10:44321`、`deadbeef`、`...`、`:`、`1.2.3.4.5`。

反代若写成 `proxy_set_header X-Forwarded-For $remote_addr:$remote_port`（带端口，非标准但确实存在），每个连接端口不同 → **每连接一个新限流桶** → 限流静默失效。这是整份实现里唯一「失效方向是放开」的路径。

### 修复后

```ts
import { isIP } from "node:net";
...
// 只接受纯 IP 字面量：isIP 返回 4 / 6，非法或带端口一律返回 0。
if (candidate && isIP(candidate) !== 0) {
  return candidate;
}
```

### 行为对照（实测 `node:net` 的 `isIP()`）

| 输入 | 修复前 | 修复后 | 说明 |
|---|---|---|---|
| `203.0.113.10` | 接受 | 接受（4） | 正常 IPv4 |
| `127.0.0.1` | 接受 | 接受（4） | 回环 |
| `2001:db8::1` | 接受 | 接受（6） | 正常 IPv6 |
| `::1` | 接受 | 接受（6） | 回环 IPv6 |
| `::ffff:203.0.113.10` | 接受 | 接受（6） | IPv4-mapped，代理常见 |
| `203.0.113.10:44321` | **接受（漏洞）** | 拒绝 → 回退 socket | 带端口 |
| `deadbeef` | **接受（漏洞）** | 拒绝 | 纯 hex 词 |
| `...` / `....` | **接受（漏洞）** | 拒绝 | 只有点 |
| `:` / `:::` | **接受（漏洞）** | 拒绝 | 只有冒号 |
| `1.2.3.4.5` | **接受（漏洞）** | 拒绝 | 五段点分 |
| `[::1]` | 拒绝 | 拒绝 | 带方括号 |
| `example.com` | 拒绝 | 拒绝 | 主机名 |
| `010.1.1.1` | 接受（漏洞） | 拒绝 | 前导零（`isIP` 严格） |
| `203.0.113.0/24` | 拒绝 | 拒绝 | CIDR |
| `""` | 回退 socket | 回退 socket | 空头 |
| 超长（>2048） | 回退 socket | 回退 socket | 长度上限未变 |

**关键约束遵守情况**：

- 非法值**回退 socket 地址**，绝不把未校验字符串当键（`clientKey` 只在回退后取 `getConnInfo`）。
- `TRUST_PROXY=false` 行为完全未变（`if (trustProxy)` 门控未动）。
- 追加式 HOPS 解析逻辑未动（`index = entries.length - Math.max(1, trustedHops)` 原样保留）。
- 未引入新依赖（`node:net` 是内置模块）。

### 测试如何证明「不是只测正则」

用 `maxAuth=1` 的限流器，对**两个不同取值**各发一次请求：

- 两者都被接受 → 各自独立桶 → 第二次 **401**；
- 两者都被拒绝 → 一起回退到 socket（`app.request` 下为 `"unknown"`）→ 第二次必然 **429**。

「接受」与「回退」在观测上完全不重叠，因此断言的是**最终限流身份**。

**变异验证**：把 `isIP(candidate) !== 0` 改回旧正则后，6 条非法值用例全部失败（`expected [401,401] to deeply equal [401,429]`），合法值用例仍通过——说明这 6 条正是抓住回归的那几条。恢复源码后全绿。

---

## 4. N-2：MAX_BUCKETS 的真实边界测试

### 注入机制（不改变生产行为）

| 设计点 | 做法 |
|---|---|
| 生产默认 | `DEFAULT_MAX_BUCKETS = 10_000`，从 `rate-limit.ts` 导出，`env.ts` 引用为**单一事实源** |
| 是否环境变量 | **否**。`env.ts` 里写死 `maxBuckets: DEFAULT_MAX_BUCKETS` 并注释「刻意不从环境变量读：桶上限是防御性常量，不该被部署配置放大」 |
| 测试注入 | `RateLimitOptions.maxBuckets?: number`；测试通过 `createHarness({ rateLimit: { maxBuckets: 3 } })` 注入小值 |
| 调用接口 | `rateLimit(options)` 的签名与返回类型未变，三个调用点只多传一个字段 |
| 全局污染 | 未引入全局可变常量；仍然是原有的模块级 `Map` + `resetRateLimiter()`（既有测试已依赖此机制） |
| 可观测性 | 新增 `rateLimitStats(): { total, overflow }`——**只返回计数，不返回任何桶键**（桶键含客户端 IP，不对外暴露） |

### 真实 overflow 分支验证（`maxBuckets=3`, `max=5`）

| 步骤 | 请求 | 结果 | 桶统计 |
|---|---|---|---|
| 1 | IP1 / IP2 / IP3 各 1 次 | 200 ×3 | `{total:3, overflow:0}` |
| 2 | IP4（第 4 个未知来源） | 200 | `{total:4, overflow:1}` ← **进入 overflow 分支** |
| 3 | IP5 | 200 | `{total:4, overflow:1}` ← 与 IP4 同桶，不再建桶 |
| 4 | IP6/IP7/IP8 各 1 次 | 200 ×3 | overflow 计数到 5 |
| 5 | IP9 | **429** | overflow 与正常桶共用同一 `max` |
| 6 | IP1 第 2、3 次 | 200 ×2 | 已存在的正常桶**未被挤入** overflow（否则会是 429） |
| 7 | IP10~IP13 | — | `{total:4, overflow:1}` 保持不变 |

对应任务书 9 条要求：1–3 由步骤 1；4–5 由步骤 2–3；6 由「按端点 overflow」用例；7 由步骤 6；8–9 由步骤 7 与「60 个不同来源」用例（`{total:6, overflow:1}`）。

### 按端点各自的 overflow

`maxBuckets=1, max=1`，两个端点：

| 请求 | 结果 | 统计 |
|---|---|---|
| `/alpha` IP1 | 200 | `{total:1, overflow:0}` |
| `/alpha` IP2 | 200 | `{total:2, overflow:1}` |
| `/beta` IP3 | **200** | `{total:3, overflow:2}` — 若两端点共用一个 overflow，这里会因 `2 > max(1)` 返回 429 |
| `/beta` IP4 | 429 | beta 自己的 overflow 到 2 |
| `/alpha` IP5 | 429 | alpha 的 overflow 同样到 2 |

### 桶数量的实际上界（O-1 修正）

**Map 实际桶数量上界 = `maxBuckets` + 实际创建的端点 overflow 桶数量**，不是严格的 `maxBuckets`：
overflow 桶自身也占一个 Map 条目，创建它时 `buckets.size` 会超过 `cap`。

- 生产默认 `maxBuckets = 10000`；当前三个限流端点（`auth` / `authorize` / `token`）都触发
  overflow 时，实际条目数理论上界为 **10003**。
- 测试侧同样体现：`maxBuckets=3`、单端点上界为 `3 + 1 = 4`；按端点隔离用例（`maxBuckets=2`、
  3 个端点）为 `2 + 3 = 5`，与实测 `{total:5, overflow:3}` 一致。
- 影响：多出与端点数同阶的少量条目，**无安全影响**；`maxBuckets` 仍是建桶增长的有效封顶。

### 并发场景

30 个互不相同的来源 `Promise.all` 同时首次请求（`max=1000` 避免计数干扰）：

- 全部 200（上限只影响建几个桶，不改变限流语义）；
- 真实状态断言 `{total:4, overflow:1}`（3 正常 + 1 overflow），**没有重复 overflow 桶**；
- 再来 20 个并发，统计保持不变；无未处理异常。

### 变异验证（证明测试不是摆设）

把 `const cap = options.maxBuckets ?? DEFAULT_MAX_BUCKETS` 改成恒定 `DEFAULT_MAX_BUCKETS`（即「忽略注入、上限失效」）：

```
× caps bucket creation and funnels unknown sources into one shared overflow bucket
  expected { total: 4, overflow: +0 } to deeply equal { total: 4, overflow: 1 }
× bucket count stays bounded no matter how many distinct sources arrive
  expected { total: 60, overflow: +0 } to deeply equal { total: 6, overflow: 1 }
× concurrent first requests from distinct sources never exceed the cap
  expected { total: 30, overflow: +0 } to deeply equal { total: 4, overflow: 1 }
```

`total: 60` / `total: 30` 直接暴露「无上限增长」。5 条里 4 条被打红（第 5 条只断言常量值 10000，不涉及上限逻辑）。恢复源码后全绿。

---

## 5. N-3：文档变化

`cloud/README.md` 的 TRUST_PROXY 段重写为结构化对照：

1. **追加式（append）**：每层代理把来源 IP 追加到右侧，`TRUST_PROXY_HOPS` **应等于真实代理层数**（单层 1、两层 2）；客户端伪造条目只会被推到更左侧。
2. **覆盖式（overwrite）**：代理覆盖整个 XFF 只留单条，`HOPS=1` 仅适用于能保证该条目就是原始客户端 IP 的**单层**场景；
   **明确写出「多层覆盖式不能设成 HOPS≥2」及其后果**——XFF 恒为单条，`HOPS≥2` 会因条目数不足回退 socket，而 socket 对端是同一个上游代理，结果是**所有用户共享同一限流桶**，正常用户互相拖累触发 429。
3. **推荐做法**：生产用明确配置的追加式链，且应用端口不能被绕过可信代理直连。
4. 新增「两层追加式」的 Nginx 示例（`HOPS=2`），保留原有单层覆盖式与单层追加式示例。
5. 保留并强化**部署红线**（端口不可直连）。
6. 「安全边界」段补一句桶上限：`maxBuckets` 生产固定 10000、不读环境变量，Map 实际条目上界为
   `maxBuckets` + 端点 overflow 桶数（当前三端点即 10003），超限后进按端点共享的 overflow，
   劣化方向是「全体限速」而非内存耗尽。

`.env.example` 的 `TRUST_PROXY_HOPS` 注释同步补一句：追加式=真实层数、覆盖式只能为 1、多层覆盖式请改用追加式。

---

## 6. 新增测试数量

| 文件 | 修复前 | 修复后 | 变化 |
|---|---|---|---|
| `tests/security/trusted-proxy.test.ts` | 6 | 23 | **+17**（移除 1 条名不副实的 `bucket cap`，新增 18 条 N-1 用例） |
| `tests/security/rate-limit-buckets.test.ts` | — | 5 | **+5**（新建文件，N-2） |
| 其余 7 个文件 | 85 | 85 | 未改 |
| **合计** | **91** | **113** | **+22** |

新增用例清单：

- N-1（18）：合法值 5 条（IPv4 / loopback / IPv6 / loopback IPv6 / IPv4-mapped）× 各自独立桶；同值两次同桶 1 条；非法值 10 条（带端口、裸 hex、纯点、纯冒号、五段点分、方括号 IPv6、主机名、前导零、CIDR、冒号带空格）；空头 1 条；超长头 1 条。
- N-2（5）：默认常量、上限 + 共享 overflow 完整链路、按端点独立 overflow、大量来源增长封顶、并发首次请求。

**原有 91 条全部继续通过**，无断言放松：113 = 91 − 1（被替换的假用例）+ 18 + 5。

---

## 7. 工程门禁结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | ✅ **PASS**（exit 0） | 首轮曾报 4 处 `maxBuckets` 缺失（`Env` 部分覆盖的类型限制），改用 `TestEnvOverrides` 后通过 |
| `pnpm lint` | ✅ **PASS**（exit 0，0 错误） | |
| `pnpm test` | ✅ **PASS** — **9 文件 / 113 测试全绿**（30.2s） | 真实 PostgreSQL 16 |
| `pnpm build` | ✅ **PASS**（exit 0） | `dist/` + migrations 复制就绪 |
| `git diff --check` | ✅ **PASS**（exit 0） | 全仓 |

**测试数据库**：复用既有容器 `brewphase-cloud-test-pg`（`postgres:16-alpine`，`127.0.0.1:54329`），未新建容器。`tests/global-setup.ts` 在数据库不可达时直接 throw，不存在 mock 冒充。

```
 Test Files  9 passed (9)
      Tests  113 passed (113)
   Duration  30.20s
```

### 工作区

```
 M cloud/.env.example
 M cloud/README.md
 M cloud/src/env.ts
 M cloud/src/routes/auth.ts
 M cloud/src/routes/oauth.ts
 M cloud/src/security/rate-limit.ts
 M cloud/tests/helpers/env.ts
 M cloud/tests/helpers/harness.ts
 M cloud/tests/security/trusted-proxy.test.ts
?? cloud/tests/security/rate-limit-buckets.test.ts
?? cloud/docs/implementation/phase-1.1.2-rate-limit-hardening-report.md
```

---

## 8. 是否引入新风险

| 潜在风险 | 评估 | 结论 |
|---|---|---|
| `isIP` 比旧正则严格，可能拒绝「以前能过」的合法值 | 只拒绝**非法**字面量。IPv4-mapped IPv6（`::ffff:1.2.3.4`，部分代理会写）仍接受并有测试。唯一的语义变化是带端口/前导零地址从「被接受」变为「回退 socket」——方向是 **fail-closed**（更严），与修复目标一致 | 可接受，且已写入 README |
| 新增 `rateLimitStats()` 导出 | 只返回计数，不返回桶键，不含 IP；生产代码不调用它 | 无泄露 |
| `Env` 类型新增必填 `maxBuckets` | 生产由 `DEFAULT_MAX_BUCKETS` 填充；测试侧放宽为部分覆盖。未新增环境变量，部署行为不变 | 无风险 |
| 全局 `Map` 与既有 `resetRateLimiter()` 机制 | 未改动，仍为单实例内存实现；水平扩容需换共享存储（既有已知限制，非本次引入） | 无新增 |
| overflow 桶本身成为热点 | 桶满后未知来源共享一个桶，可能互相拖累 429——这是**刻意选择的劣化方向**（fail-closed），且只在约 10000 个活跃桶（上界 10003，见 §4 O-1）时才可能触达 | 已文档化 |
| 迁移 / 依赖 | 无 Schema 变更、无依赖变化（`node:net` 内置） | 无 |

**未发现新攻击面**：`isIP` 只做字符串判定，无正则回溯风险；选中的值仍只作为桶键与 `hashIp` 输入（不参与 SQL / 路径 / HTML）。

---

## 9. 剩余问题

本阶段**严格未处理**以下项（属任务书明令禁止范围），等级与建议时点维持第二轮审查报告：

| ID | 等级 | 内容 | 建议时点 |
|---|---|---|---|
| N-4 | Low | 5xx `AppError` 在日志中只有 `{code,status}`，四种 provider 故障在生产无法区分 | Phase 1.2 首迭代（1 行） |
| N-5 | Low | `purgeExpired` 每请求全表扫描 | Phase 1.2 首迭代 |
| N-6 | Informational | OAuth Transaction 过期判断在 Node 侧而非 SQL | 记录即可 |
| N-7 | Informational | catch 内审计写失败会掩盖原始错误 | 记录即可 |
| N-8 | Informational | 无 IPv6 归一化；`"unknown"` 回退共享桶 | 记录即可 |

补充一条**本次新识别**的残余项（Informational，不阻塞）：

- **N-9（Informational）**：覆盖式多层代理的配置错误现在有文档兜底，但运行期没有防护——`TRUST_PROXY=true` + `HOPS≥2` 时无法自动发现「所有请求的 socket 对端都是同一个地址」。可选改进：启动期或首个窗口内检测「socket 地址恒定而 XFF 条目数恒少于 HOPS」并打一条 warn。属可观测性改进，不在本阶段范围。

---

## 10. 是否建议合并

**建议合并。**

依据：

1. **验收目标达成**：N-1 让限流输入具备严格合法性校验（`isIP`，非法一律回退 socket），N-2 让 overflow 保护得到**真实执行**的测试证明（不是只测常量、不是只测正常路径）。
2. **两项修复都有变异验证**：故意破坏实现时，N-1 打红 6 条、N-2 打红 4 条，证明测试确实覆盖被修的逻辑，而不是恰好通过。
3. **无行为回归**：`TRUST_PROXY=false` 与追加式 HOPS 解析未动；原有 91 条测试全部继续通过；无迁移、无依赖变化。
4. **门禁全绿**：typecheck / lint / 113 项真实 PostgreSQL 测试 / build / `git diff --check`。
5. **改动面小且集中**：4 个源码文件、4 个测试文件、2 个文档，净增约 190 行（不含新增测试文件与报告）。

**合并前建议人工确认**：① README 中「多层覆盖式不能设 HOPS≥2」的表述是否符合你的实际部署形态；② 是否接受 `isIP` 对带端口地址的回退行为（fail-closed）。

---

## 11. Git 状态与输出摘要

```
$ git status --short
 M cloud/.env.example
 M cloud/README.md
 M cloud/src/env.ts
 M cloud/src/routes/auth.ts
 M cloud/src/routes/oauth.ts
 M cloud/src/security/rate-limit.ts
 M cloud/tests/helpers/env.ts
 M cloud/tests/helpers/harness.ts
 M cloud/tests/security/trusted-proxy.test.ts
?? cloud/tests/security/rate-limit-buckets.test.ts
?? cloud/docs/implementation/phase-1.1.2-rate-limit-hardening-report.md

$ git diff --stat
 cloud/.env.example                         |  2 +
 cloud/README.md                            | 39 ++++++++---
 cloud/src/env.ts                           |  5 ++
 cloud/src/routes/auth.ts                   |  1 +
 cloud/src/routes/oauth.ts                  |  2 +
 cloud/src/security/rate-limit.ts           | 62 ++++++++++++----
 cloud/tests/helpers/env.ts                 | 14 +++-
 cloud/tests/helpers/harness.ts             |  4 +-
 cloud/tests/security/trusted-proxy.test.ts | 90 +++++++++++++++++++---
 9 files changed, 190 insertions(+), 29 deletions(-)

$ git diff --check
（无输出，exit 0）

$ pnpm test
 Test Files  9 passed (9)
      Tests  113 passed (113)
   Duration  30.20s
```

**本阶段到此停止：未 commit、未 push、未 merge、未开始 Phase 1.2，等待人工审查。**
