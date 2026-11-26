import { createHash } from "node:crypto";

/**
 * `request_hash` 的**唯一实现**（协议运行时 §8.2）。
 *
 * ## 它是什么，不是什么
 *
 * | 是 | 不是 |
 * |---|---|
 * | 「同一个 `delivery_id` 的内容有没有被换掉」的指纹 | 幂等键 |
 * | 跨进程可比的一段十六进制 | 授权判据（不携带 scope / user / device） |
 *
 * **绝不能**用它合并两个不同 `delivery_id` 的相同查询——用户两次独立问
 * 「上周喝了什么」参数完全相同，却是两个独立意图，合并会回放陈旧结果。
 *
 * ## 为什么两端各写一份
 *
 * `cloud/` 是独立发布单元，不能 import Desktop 源码（那会把桌面端构建产物
 * 拖进服务端）。所以两条实现靠**共享黄金向量**
 * `fixtures/remote-mcp/req-v1.json` 对齐：两端对同一份向量必须得出同一串
 * 哈希。各自「我算我验都能过」证明的只是自洽。
 *
 * ## 五条规则（与 fixture 的 `canonical_rules` 逐条对应）
 *
 * 1. 对象键按 **UTF-16 代码单元**升序（JS 默认字符串比较）；
 * 2. 值为 `undefined` 的键**剔除**，不是写成 `null`——`{a:undefined}` 与 `{}`
 *    必须同哈希，否则「传了但没传值」会与「没传」产生不同指纹；
 * 3. 数组**保留原顺序**（`[3,1,2]` ≠ `[1,2,3]`：顺序对查询有意义）；
 * 4. **不做 Unicode 归一化**。NFC 的 `é` 与 NFD 的 `e\u0301` 字节不同、哈希
 *    不同。归一化会让「用户看到的同一个词」与「数据库里存的那个词」产生
 *    两种指纹，而 Desktop 侧根本不归一化；
 * 5. 字符串用 `JSON.stringify` 的标准转义（含代理对与转义字符）。
 *
 * `v` 必须在指纹内：跨版本的同一个工具调用语义可能不同，不纳入版本会让
 * 一次 v2 请求命中 v1 的缓存。
 */
export function computeRequestHash(input: {
  v: number;
  tool: string;
  arguments: unknown;
}): string {
  const canonical = canonicalJson(input);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/**
 * 规范 JSON。
 *
 * `JSON.stringify` 对 `undefined` 的处理在**数组**里是 `null`、在**对象**里
 * 是丢弃——这里的实现保留前者（数组保序保长度）、显式做后者（对象剔除），
 * 与协议描述一致。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    // 用 `<`/`>` 而不是 `localeCompare`：后者受 locale 影响，同一份数据在
    // 不同 LANG 的机器上会排出不同顺序，而两端的哈希必须一致。
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
