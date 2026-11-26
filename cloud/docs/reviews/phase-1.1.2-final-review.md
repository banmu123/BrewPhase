# BrewPhase Phase 1.1.2 — 第三轮独立安全审查报告

> 日期：2026-11-17 · 审查对象：Phase 1.1.2 限流加固
> 分支：`feature/cloud-account-phase-1.1` · 审查范围：`32ceb58..48cf9ea`
> 性质：**独立审查。未修改任何业务源码、未 commit、未 push、未 merge、未切换分支。**
> 结论先行：**PASS WITH CONDITIONS** —— N-1 / N-2 均达成验收目标且有真实边界证明，无回归、无新攻击面。唯一条件是 N-3 文档中一句**绝对化表述不成立**（`HOPS` 超配时该表述相反），需补一句警示（1 句，Low）。

---

## 1. 实际基线与审查范围

### 1.1 基线偏差（先记录，不擅自处理）

任务书声明「本阶段预期基线 `32ceb58`」。实测：**HEAD = `48cf9ea`**。

原因是上一轮审查报告经人工指令提交并推送（`48cf9ea fix(cloud): Phase 1.1.2 限流加固…`）。因此**阶段改动已不再是「未提交的工作区改动」，而是一个独立提交**。工作区干净、无未跟踪文件。

| 检查项 | 任务书预期 | 实测 | 判定 |
|---|---|---|---|
| 分支 | `feature/cloud-account-phase-1.1` | `feature/cloud-account-phase-1.1` | ✅ |
| HEAD | `32ceb58` | `48cf9ea` | ⚠️ 偏差（改动已提交） |
| `git status --short` | 有未提交改动 | 空 | ⚠️ 同因 |
| `git diff --stat` | 非空 | 空 | ⚠️ 同因 |
| 未跟踪文件 | 含新增测试与报告 | 无 | ⚠️ 同因 |
| `git diff --check` | — | exit 0 | ✅ |

**处理方式**：未切换分支、未清理、未回退。审查基线等价替换为提交区间 `32ceb58..48cf9ea`（单提交，边界清晰，比工作区 diff 更可靠）。

### 1.2 审查范围与范围纪律

```
48cf9ea  fix(cloud): Phase 1.1.2 限流加固（N-1 严格 IP 校验 + N-2 桶上限测试 + N-3 文档）
32ceb58  docs(review): Phase 1.1.1 第二轮独立审查报告   ← 本阶段基线
```

**改动严格局限于 `cloud/`，且严格对应 N-1 / N-2 / N-3**：

| 检查 | 结果 |
|---|---|
| 是否触碰 `cloud/` 之外的代码 | ❌ 无（11 个文件全在 `cloud/`） |
| 是否触碰数据库迁移 / `schema.ts` | ❌ 无 |
| 是否触碰 `package.json` / `pnpm-lock.yaml` | ❌ 无（零新增依赖） |
| 是否触碰 Desktop / iOS / ChromeExtension / Android | ❌ 无 |
| 是否越界处理 N-4 ~ N-8 | ❌ 无（`google.ts` / `github.ts` / `app.ts` / `session-service.ts` 均未改） |

---

## 2. 文件级 Diff 审查

| 文件 | 增/删 | 审查结论 |
|---|---|---|
| `cloud/src/security/rate-limit.ts` | +50/−12 | 核心改动。`isIP()` 替换正则；`DEFAULT_MAX_BUCKETS` 导出；`maxBuckets` 选项；`overflowKey()` 提取；`rateLimitStats()` 新增。**逐行核对无误** |
| `cloud/src/env.ts` | +5/−0 | 从 `rate-limit.js` 导入常量（单一事实源）；`Env.rateLimit.maxBuckets` 必填；**写死不读环境变量** |
| `cloud/src/routes/auth.ts` | +1/−0 | `authLimiter` 透传 `maxBuckets` |
| `cloud/src/routes/oauth.ts` | +2/−0 | `authorizeLimiter` / `tokenLimiter` 各透传一次 |
| `cloud/tests/security/rate-limit-buckets.test.ts` | +185（新增） | N-2 的 5 个用例，真实执行 overflow |
| `cloud/tests/security/trusted-proxy.test.ts` | +83/−7 | 删除 1 条名不副实用例，新增 18 条 N-1 用例 |
| `cloud/tests/helpers/env.ts` | +13/−1 | 新增 `TestEnvOverrides`（允许 `rateLimit` 部分覆盖） |
| `cloud/tests/helpers/harness.ts` | +2/−2 | 同步改用 `TestEnvOverrides` |
| `cloud/README.md` | +32/−7 | N-3 主体：追加式/覆盖式分开写 + 两层示例 |
| `cloud/.env.example` | +2/−0 | `TRUST_PROXY_HOPS` 注释补两种模式差异 |
| `cloud/docs/implementation/phase-1.1.2-rate-limit-hardening-report.md` | +350（新增） | 实施报告 |

### 2.1 是否削弱既有断言

逐行扫描 diff 中被删除的断言：

```
-    expect(statuses).toEqual([401, 401, 401]);
```

**仅此一条**，且它属于被移除的那条名不副实的 `bucket cap` 用例（标题声称测桶上限，实际只发 3 个请求、断言 `[401,401,401]`）。

- 未新增 `.skip` / `.todo` / `.only` / `xit`（grep 为空）。
- 其余 7 个测试文件零改动。
- 测试总数 `91 → 113 = 91 − 1 + 18 + 5`，与报告声明一致。

---

## 3. N-1 严格 IP 校验

### 3.1 结论：**PASS**（一项非阻塞观察）

```ts
import { isIP } from "node:net";
...
if (candidate && isIP(candidate) !== 0) {
  return candidate;
}
// 否则回退 socket 地址
```

| 审查点 | 结论 | 证据 |
|---|---|---|
| 是否真正用 `node:net` 的 `isIP()` | ✅ | 源码第 2 行 import、第 85 行调用；内置模块，无新依赖 |
| IPv4 正确处理 | ✅ | 实测 `isIP("203.0.113.10") = 4`，返回原值作限流键 |
| IPv6 正确处理 | ✅ | `2001:db8::1` → 6；`::1` → 6；`2001:0db8:0000:…:0001` → 6 |
| IPv4-mapped IPv6 | ✅ 接受 | `::ffff:203.0.113.10` → 6；大写 `::FFFF:…` 同样接受 |
| 带端口拒绝 | ✅ | `203.0.113.10:44321` → 0 → 回退；`203.0.113.10 : 443` → 0 |
| CIDR 拒绝 | ✅ | `203.0.113.0/24` → 0 |
| 主机名拒绝 | ✅ | `example.com` → 0 |
| 非法字符/填充拒绝 | ✅ | `deadbeef`、`...`、`....`、`:`、`:::`、`1.2.3.4.5`、`010.1.1.1`、`[::1]` 全部 → 0 |
| 非法 XFF 可靠回退 socket | ✅ **运行时验证**：8 种非法值经真实编译产物 `clientIp()` 全部返回 `""`（即 socket 回退） |
| `TRUST_PROXY=false` 完全不受影响 | ✅ **运行时验证**：合法值 `203.0.113.10`、`::ffff:…`、非法值 `deadbeef` 在 `trustProxy=false` 下**全部返回 `""`**（XFF 被完全忽略） |
| 追加式 HOPS 算法保持正确 | ✅ **运行时验证**：XFF `6.6.6.6, 7.7.7.7, 8.8.8.8, 203.0.113.10` → HOPS=1 取 `203.0.113.10`、HOPS=2 取 `8.8.8.8`、HOPS=3 取 `7.7.7.7`（逐层向左，与「跳过 N 个可信代理」一致） |
| 客户端能否构造 XFF 绕过限流 | ✅ **不能**（正确配置下）。追加式下客户端条目只能落在选中位置左侧；覆盖式下 XFF 被完全覆写 |
| 空格 / 逗号 / 大小写 / IPv6 特殊格式 | ✅ 逗号按 `split(",")` 切分、每条 `trim()`；大小写十六进制 `isIP` 均可解析；`getConnInfo` 抛错被 catch |
| 层数不足 | ✅ **运行时验证**：单条目 + HOPS=2 → 返回 `""`（回退） |
| 超长头 | ✅ **运行时验证**：3000 字符头 → 返回 `""`（`MAX_XFF_LENGTH=2048` 生效） |

### 3.2 特别检查：`203.0.113.10` 与 `::ffff:203.0.113.10` 是否形成不同限流身份

**是，二者形成不同桶**（实测：`clientIp` 原样返回，不做归一化；`203.0.113.10` 与 `::ffff:203.0.113.10` 是不同字符串 → 不同 Map 键）。

**是否构成真实安全风险：否。判定为非风险，理由基于代理行为而非理论推演：**

1. **限流键不由客户端产生。** 追加式下选中项是最右侧条目，由最近的可信代理由 `$remote_addr`（socket 对端）写入；覆盖式下整个 XFF 被代写。客户端无法在两种书写形式之间选择。
2. **同一客户端的表示形式在同一代理下是稳定的。** Nginx 的 `$remote_addr` 对给定连接族固定：IPv4 监听 → `203.0.113.10`；双栈监听（`ipv6only=off`）→ 所有 IPv4 客户端**一致地**表示为 `::ffff:203.0.113.10`。不会同一地址时而是 A、时而是 B。
3. **双栈客户端本来就是两个地址。** 若客户端同时有 IPv4 与 IPv6 出口，`203.0.113.10` 与 `2001:db8::a` 是**两个真实不同的地址**，各自成桶符合「每 IP 限流」的定义，不是绕过。
4. **唯一可被利用的前提是部署红线已被违反**（应用端口可被直连）。此时攻击者完全控制 XFF，本可直接使用任意 10000 个不同 IP 造桶，归一化毫无帮助。
5. **即便触发，影响是「新增一个桶」而非「无限新增」**——`maxBuckets` 硬上限仍封顶。

结论：**理论可能性存在，当前代理配置下不构成真实风险**，无需在本阶段处理。若未来引入 IPv4/IPv6 混合入口且要求「同一主机跨族共享配额」，再考虑归一化（`isIP` + 手工映射为 `::ffff:a.b.c.d`）。

### 3.3 观察（Informational，非缺陷）

**`isIP()` 并非旧正则的严格子集。** 实测 `isIP("fe80::1%en0") = 6`（带 zone id 的 scoped IPv6），而旧正则 `^[0-9a-fA-F.:]{1,45}$` 因含 `%` 会拒绝。即本阶段**新增了一类可被接受的取值**。

- zone id 字符集：实测字母数字可过，`%../x`、`%a b`、`%;DROP TABLE`、`%\0` 均被拒 → 无法注入路径/命令/SQL 语义；该值只作 Map 键与 `hashIp` 输入，不入 SQL、不入 HTML、不入路径。
- 长度：zone 本身不受 45 字符限制，但整头受 `MAX_XFF_LENGTH=2048` 约束，单键长度有界。
- 可利用性：与 3.2 同理——需控制选中条目。**非风险**。

---

## 4. N-2 桶上限与 overflow

### 4.1 结论：**PASS**（两项精确性观察）

```ts
const cap = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
if (!existing && buckets.size >= cap) {
  return overflowKey(options.name);   // 按端点隔离
}
```

| 审查点 | 结论 | 证据 |
|---|---|---|
| `maxBuckets` 真正控制正常桶数量 | ✅ | 运行时：`cap=3`，3 个来源后 `{total:3,overflow:0}`；第 4 个后 `{total:4,overflow:1}` 且不再增长 |
| overflow 按端点隔离 | ✅ | 运行时：`cap=2`、3 个端点各 4 个来源 → `{total:5, overflow:3}`，三个端点各一个 overflow 桶；测试亦断言 `/beta` 的未知来源计入 beta 自己的计数（若共用则会被 alpha 的计数打成 429） |
| overflow 是否可能重复创建 | ✅ 不会 | overflow 键由 `overflowKey(name)` 确定性构造；首次 `set` 后再请求命中 `existing` → 复用。并发用例（30 并发 + 20 并发）断言 `overflow:1` 不变 |
| 已有正常桶是否被挤入 overflow | ✅ 不会 | `if (existing && fresh) return base` 在 cap 判断**之前**；运行时：正常桶再次访问后 `{total:3,overflow:1}` 不变 |
| 大量不同 IP 造成 Map 无界增长 | ✅ 不能 | 运行时：`cap=5`、60 个不同来源 → `{total:6}`（5 正常 + 1 overflow）。**变更前**该路径无上限（第二轮审查已指出） |
| 并发首次请求突破上限 | ✅ 不能 | 测试：30 个不同来源 `Promise.all` → `{total:4}`（cap=3）；再来 20 个并发仍 `{total:4}`。JS 单线程事件循环内 `bucketKey` + `set` 之间无 `await`，不存在交错 |
| overflow 限流计数正确 | ✅ | overflow 与正常桶同走 `existing.count += 1` 与同一 `max`；运行时与测试均确认 overflow 达到 `max` 后返回 429 |
| `rateLimitStats()` 不泄露 IP / 桶键 | ✅ | 仅 `{ total, overflow }` 两个数字；遍历键只做 `endsWith` 计数，不返回值。生产代码零调用（grep 确认仅定义处与测试） |
| `resetRateLimiter()` 彻底清理 | ✅ | `buckets.clear()`；运行时 `reset` 后 `{total:0,overflow:0}` |
| 默认生产配置恒为 10000 | ✅ | `DEFAULT_MAX_BUCKETS = 10_000`；`env.ts` 直接引用，**无环境变量入口**（`.env.example` 中无 `MAX_BUCKETS`） |
| 三处配置传递完整一致 | ✅ | grep 全仓仅 3 个 `rateLimit({...})` 调用点（`auth.ts:57`、`oauth.ts:20`、`oauth.ts:28`），**三处全部**带 `maxBuckets`；无遗漏调用点 |

### 4.2 测试是否真正触发 overflow

**是，且经独立变异验证（在仓库外副本上进行，业务源码未被修改）：**

| 变异 | 预期 | 实测 |
|---|---|---|
| `const cap = DEFAULT_MAX_BUCKETS`（忽略注入，上限失效） | N-2 用例应失败 | **4/5 失败**：`expected {total:4,overflow:0} to equal {total:4,overflow:1}`、`{total:60,overflow:0}`、`{total:30,overflow:0}` —— 直接暴露无界增长 |
| `isIP(...)` 换回旧字符集正则 | N-1 非法值用例应失败 | **6/23 失败**，恰为带端口/裸 hex/纯点/纯冒号/五段点分/前导零六条，报错 `[401,401] ≠ [401,429]` |

说明测试确实耦合到被修逻辑，而非仅验证配置值。仅第 5 条 N-2 用例（`production default is the documented constant`）不随变异失败——它本就只断言常量值。

### 4.3 小容量配置是否影响生产 / 既有语义

- `maxBuckets` 只存在于 `RateLimitOptions`（调用方显式传参），**不读 `process.env`**；生产唯一来源是 `env.ts` 的常量。
- 注入小值只改变 `bucketKey` 的阈值判断，**不改动** `windowMs`、`count`、`purgeExpired`、`max` 的任何逻辑（diff 可见这些行零改动）。
- 测试隔离：`rate-limit-buckets.test.ts` 在 `beforeEach` / `afterEach` 双清空；vitest 按文件独立 worker；`trusted-proxy.test.ts` 内的 `probe()` 每次 `resetRateLimiter()`。无跨文件污染。

### 4.4 观察（Informational / Low，非本阶段引入）

**O-1：实际上界是 `maxBuckets + 端点数`，不是 `maxBuckets`。**
overflow 桶自身也是 Map 条目，创建时会让 `buckets.size` 超过 `cap`。运行时实测 `cap=2`、3 个端点 → `total=5 = cap + 3`。生产上界 `10000 + 3 = 10003`。测试已用 `toBeLessThanOrEqual(5 + 1)` 承认该上界，实施报告「真实桶数量始终符合上限约束」的措辞偏松，建议改为「`≤ maxBuckets + 端点数`」。**无安全影响**（多 3 个条目的内存）。

**O-2（既有设计，非本阶段引入）：cap 是全局的，overflow 桶是按端点的。**
`buckets.size` 跨端点共享。若攻击者能在 `authorize`（限值 30/min，但每个新来源立即建桶）上制造 10000 个不同键，则 `/auth/refresh` 的新来源也会被推入其 overflow 桶 → 跨端点**可用性耦合**（全体 429）。方向是 fail-closed，不是绕过；且需 10000 个真实不同 IP 或已违反部署红线。此为 1.1.1 起既有性质，本阶段未加重复未减。建议纳入 Phase 1.2 的容量规划讨论。

**O-3（既有耦合）：`purgeExpired` 用「调用方自己的 `windowMs`」清扫共享 Map。**
当前三个限流器 `windowMs` 同源（均为 `ctx.env.rateLimit.windowMs`），故无实际影响。若未来某个限流器改用更短窗口，它会提前清掉其他限流器的桶（计数被重置）。属隐式契约，建议在 `RateLimitOptions.windowMs` 注释中点明「必须与其他限流器一致」。

---

## 5. N-3 代理配置文档

### 5.1 结论：**PASS WITH CONDITIONS**（1 处表述需修正）

| 审查点 | 结论 | 证据 |
|---|---|---|
| 追加式是否明确要求 HOPS = 真实代理层数 | ✅ | 「`TRUST_PROXY_HOPS` 应等于真实追加链路上的可信代理层数：单层代理为 1，两层为 2」 |
| 单层覆盖式是否正确说明 HOPS=1 | ✅ | 「`HOPS=1` 仅适用于能保证该条目就是原始客户端 IP 的**单层**覆盖场景」 |
| 多层覆盖式 HOPS≥2 是否解释回退 socket 后果 | ✅ | 「`HOPS≥2` 会因『条目数不足』回退 socket 地址，而这些请求的 socket 对端是同一个上游代理，结果是**所有用户共享同一个限流桶**」——**与源码行为一致**（运行时已验证单条目 + HOPS=2 → 回退） |
| 是否明确要求应用端口不能绕过可信代理 | ✅ | 「**部署红线**：…否则直连请求自带的 XFF 头会占据右端位置」+ 「推荐做法」重复一次 |
| 两层追加式 Nginx 示例是否与算法一致 | ✅ | 示例注释 `XFF = "客户端, CDN" → HOPS=2`；运行时验证 3 条目链 `HOPS=2` 取第 2 个（即客户端），伪造条目被推到更左，一致 |

### 5.2 条件 C-1（Low，需合并前修正）

README 现有表述：

> 客户端的伪造条目只会被推到更左侧，**永远不落在选中位置**。

**该绝对化表述只在 `HOPS` 等于真实层数时成立；`HOPS` 超配时恰好相反。**

运行时实测（单层追加式代理，到达应用的 XFF = `1.2.3.4, 203.0.113.10`）：

```
HOPS=1 -> "203.0.113.10"   ← 正确
HOPS=2 -> "1.2.3.4"        ← 选中的是客户端伪造值（fail-open）
```

两层链 `5.5.5.5, 203.0.113.10, 198.51.100.1`：`HOPS=3` → `5.5.5.5`（同样是伪造值）。

**问题性质**：文档只描述了「HOPS 偏小 → 回退 socket → 全体共享一桶（fail-closed，可用性受损）」这一个方向，未描述「HOPS 偏大 → 选中位置落到客户端可控条目 → 限流被完全绕过（fail-open）」。而后者是更危险的方向，且「永远」一词会诱导读者认为「多设几层更安全」。

**说明**：该行为**不是本阶段引入**（1.1.1 起算法即如此，本阶段未改 `index` 计算），且 N-3 的任务正是修正文档歧义——因此把这句绝对化表述留在此处属于**文档正确性缺陷**，而非代码缺陷。

**建议修改（1–2 句）**：在追加式段落后补：

> 反向风险同样存在：`HOPS` **大于**真实层数时，选中位置会落到客户端可控的条目上，等于放弃限流（fail-open）。**宁小勿大**——偏小只会让用户共享代理 IP 的桶，偏大则会让伪造值成为限流键。

`.env.example` 同段亦建议补一句「HOPS 宁小勿大」。

---

## 6. 测试命令与真实执行结果

**环境**：macOS · Node v22.22 · pnpm 9.0.0 · Docker `postgres:16-alpine`
**数据库**：复用既有容器 `brewphase-cloud-test-pg` @ `127.0.0.1:54329`（`Up 21 minutes`，`pg_isready` = accepting connections）。**未新建容器**。
**真实性**：`tests/global-setup.ts` 在数据库不可达时 `throw`（`cannot reach test PostgreSQL at …`），不存在 mock 替代数据库集成测试——本轮首次执行前该断言曾真实阻止运行（前两轮），本轮数据库在线故通过。

| 命令 | 实执行结果 |
|---|---|
| `pnpm typecheck` | ✅ **exit 0**（无输出） |
| `pnpm lint` | ✅ **exit 0**（0 错误） |
| `pnpm test` | ✅ **exit 0** — `Test Files 9 passed (9)` / `Tests 113 passed (113)` |
| `pnpm build` | ✅ **exit 0** — `[copy-assets] copied src/db/migrations -> dist/db/migrations`；`dist/` 内**无** `*test*` 文件 |
| `git diff --check` | ✅ **exit 0**（无输出） |

补充核对：

- 未新增依赖（`package.json` / `pnpm-lock.yaml` 零改动）。
- 无数据库迁移（`src/db/migrations/` 零改动）。
- 生产构建不含测试专用配置（测试注入仅经 `RateLimitOptions`，生产由 `env.ts` 常量填充）。
- 未新增 `.skip` / `.only` / `.todo`。
- 仅 1 条断言被删除，属被替换的假用例（见 §2.1）。

---

## 7. 是否存在回归

| 回归维度 | 结论 | 依据 |
|---|---|---|
| 既有 91 项测试 | ✅ 全部继续通过 | 仅 1 条被替换（假用例），其余文件零改动；113 = 91 − 1 + 23 |
| 限流窗口 / 计数 / 过期清理语义 | ✅ 未变 | diff 中 `windowMs` / `count` / `purgeExpired` 行零改动 |
| `TRUST_PROXY=false` 行为 | ✅ 未变 | 门控 `if (trustProxy)` 未动；运行时三种输入均返回 socket 身份 |
| 追加式 HOPS 解析 | ✅ 未变 | `index = entries.length - Math.max(1, trustedHops)` 逐字未改 |
| OAuth / 账号认证流程 | ✅ 未受影响 | `callback.ts` / `state.ts` / `session-service.ts` / `user-service.ts` / `google.ts` / `github.ts` 零改动；改动仅在限流器装配处多传一个字段 |
| 新 fail-open 路径 | ✅ 未发现 | `isIP` 相对旧正则严格收窄（唯一放宽是 zone-id scoped IPv6，不可由客户端控制）；`maxBuckets` 生产为常量 |
| 异常输入导致崩溃 | ✅ 未发现 | `isIP` 仅做字符串判定；`index<0` 已保护；超长头先被长度门限拦截；`getConnInfo` 抛错已 catch |
| Map 内存增长 | ✅ 已封顶 | 上界 `maxBuckets + 端点数 = 10003`（见 O-1） |
| 不同限流器状态污染 | ✅ 无 | 键以 `options.name` 前缀隔离；三处 `windowMs` 同源（隐式契约见 O-3） |
| 新增 IP 信息泄露 | ✅ 无 | `rateLimitStats()` 只返回计数；限流模块无任何日志输出（grep 确认）；审计仍走既有 `hashIp(pepper, ip)` |
| 生产构建污染 | ✅ 无 | `rateLimitStats` 仅定义未调用；`dist` 无测试文件 |

---

## 8. 是否建议合并

**建议合并——完成条件 C-1（1–2 句文档修正）后即可。**

依据：

1. **两项验收目标均达成**。N-1 用 `node:net` 的 `isIP()` 取代字符集正则，实测拒绝全部 6 类畸形值并回退 socket；N-2 的 overflow 分支被**真实执行**（非仅验证配置值），并有变异验证证明测试能抓住上限失效。
2. **无回归、无新攻击面、无新依赖、无迁移**。改动面 11 文件、全部在 `cloud/`，生产逻辑净增约 50 行。
3. **生产默认行为不变**：桶上限仍 10000、`TRUST_PROXY=false` 仍完全忽略 XFF、追加式 HOPS 算法逐字未改。
4. 唯一条件是文档中一句绝对化表述不成立（C-1），修正成本 1–2 句，且正属 N-3 的职责范围。

**不建议以 FAIL 处理**：C-1 不影响运行时行为，源码层面无可修之处（应用无法自知真实代理层数）。

---

## 9. 新发现问题汇总

| ID | 严重度 | 类型 | 问题 | 建议时点 |
|---|---|---|---|---|
| **C-1** | **Low** | 文档 | README「伪造条目**永远**不落在选中位置」在 `HOPS` 超配时不成立，实测选中客户端伪造值（fail-open）；文档只描述了 HOPS 偏小的 fail-closed 方向 | **合并前**（1–2 句） |
| O-1 | Informational | 精确性 | 桶实际上界为 `maxBuckets + 端点数`（生产 10003），报告措辞「始终符合上限约束」偏松 | 随手改措辞 |
| O-2 | Low（既有） | 设计 | cap 全局而 overflow 按端点：填满一端点可把其他端点推入 overflow（可用性耦合，fail-closed） | Phase 1.2 容量讨论 |
| O-3 | Informational（既有） | 隐式契约 | `purgeExpired` 用调用方 `windowMs` 清扫共享 Map；若未来窗口不一致会互相提前清桶 | 补注释 |
| O-4 | Informational | 观察 | `isIP` 接受 scoped IPv6（`fe80::1%en0`），旧正则拒绝——本次唯一的取值放宽；字符集安全、长度受 2048 约束、不可由客户端控制 | 记录即可 |
| O-5 | Informational | 测试质量 | 空字符串用例的首个断言 `[401,401]` 较弱（`probe("","")` 因 `clientKey` 的 `\|\| "unknown"` 无法区分「拒绝」与「接受后为空」）；更直接的形式是 `probe("", "deadbeef") → [401,429]`。行为上无差别，非缺陷 | 可选 |
| O-6 | Informational | 清理 | `mkdir cloud/docs/reviews`（本报告目录）为审查新增，未跟踪 | 随报告提交 |

**未发现 Critical / High。**
N-4 ~ N-8 按范围纪律未处理，等级与建议时点维持第二轮报告；本轮确认其代码区零改动。

---

## 10. 尚未解决的问题与后续建议

### 10.1 本阶段遗留（需人工决策）

1. **C-1 文档修正**：见 §5.2，建议采纳「宁小勿大」表述。
2. **O-1 措辞**：`maxBuckets + 端点数`。

### 10.2 移交 Phase 1.2

| 项 | 内容 |
|---|---|
| N-4 | provider 5xx 在日志中只有 `{code,status}`，四种故障不可区分（1 行） |
| N-5 | `purgeExpired` 每请求全表扫描（桶近 10000 时 CPU 放大） |
| O-2 | cap 跨端点耦合的容量规划 |
| O-3 | `windowMs` 一致性契约写入注释 |
| N-9（上轮提出） | 多层覆盖式配置错误的运行期告警（socket 恒定 + XFF 条目数恒少于 HOPS） |

### 10.3 仍未完成的前置条件（沿用第二轮）

- Provider 真实凭据端到端联调（mock 无法覆盖真实 JWKS 轮换与授权页交互）。
- Desktop 端契约冻结（`shared/contracts`）。

---

## 11. 审查过程声明

- **未修改业务源码**：变异验证全部在仓库外副本（`/tmp/bp-mut`，已删除）进行；审查前后 `git status --short` 均为空。
- **未 commit / 未 push / 未 merge / 未切换分支**（HEAD 始终为 `48cf9ea`）。
- **未开始 Phase 1.2**。
- 唯一新增文件：本报告 `cloud/docs/reviews/phase-1.1.2-final-review.md`（及为容纳它的目录）。
- 环境副作用（项目外）：复用既有 PostgreSQL 容器；`cloud/dist/` 由 `pnpm build` 重建（属 `.gitignore` 覆盖范围）。

**审查结束，等待人工决策。**
