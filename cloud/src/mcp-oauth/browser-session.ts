import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { sha256Hex } from "../security/crypto.js";
import {
  MCP_BROWSER_COOKIE_NAME,
  MCP_BROWSER_COOKIE_PATH,
  MCP_BROWSER_SESSION_KEY_MIN_BYTES,
  MCP_BROWSER_SESSION_TTL_SECONDS,
} from "./constants.js";

/**
 * 浏览器授权会话（签名 Cookie，服务端零存储）。
 *
 * ## 它到底证明什么
 *
 * **只有一件事**：这个浏览器发起（或接管）了这一次授权请求。
 *
 * 它**不是** Cloud 登录态：`/auth/*` 不读它，`/mcp` 的 Bearer 校验也不看它。
 * 它**不是** API 凭据：不能换 token、不能调工具。它的全部用途是让
 * `mcp_auth_requests.browser_binding_hash` 有东西可比对——于是「别人拿到
 * rid 也打不开同意页」。
 *
 * 因此不需要建表：没有需要撤销的长期状态，30 分钟后自然失效。
 *
 * ## 为什么 Path 是 `/mcp/oauth` 而不是 `/mcp`
 *
 * Cookie 的 Path 是前缀匹配。写成 `/mcp` 会让它出现在每一次 `POST /mcp`
 * ——那是真正的数据端点，由第三方客户端调用、由 Cloud 转发给 Desktop，
 * 授权 Cookie 在那里没有任何用途，却把「浏览器授权状态」带进了数据通道。
 * 代价是 consent 页必须放在 `/mcp/oauth/consent`（两者是同一个决定的两面）。
 */

/** 内容只有这三项。`sid` 是随机值，不是用户标识。 */
export interface BrowserSessionPayload {
  sid: string;
  iat: number;
  exp: number;
}

export type BrowserSessionResult =
  | { ok: true; session: BrowserSessionPayload }
  /** 四种失败对外只有一种结果：没有可用会话。 */
  | { ok: false; reason: "missing" | "tampered" | "malformed" | "expired" };

const SID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * `iat` 允许超前多少秒。
 *
 * 服务器之间有时钟漂移，断言「iat 不能晚于现在」会让一台快 2 秒的机器
 * 完全无法登录；但完全不查又会让「有效期 30 分钟」变成可以伪造起点。
 * 60 秒足够覆盖 NTP 抖动，又不足以把窗口显著拉长。
 */
const IAT_FUTURE_TOLERANCE_SECONDS = 60;

export interface BrowserSessionOptions {
  /** `MCP_BROWSER_SESSION_KEY`。缺失或过短时**抛错**，不降级。 */
  key: string;
  /** 生产环境为 `true`；开发环境允许 `false`（`http://localhost` 下 Secure 会被丢弃）。 */
  secure: boolean;
  /** 可注入时钟（测试过期边界用）。 */
  now?: (() => Date) | undefined;
}

/**
 * 校验密钥。
 *
 * **fail-closed**：缺失或过短直接抛错，绝不退化成「不加签名」或「临时生成
 * 一把随机密钥」——后者会让重启后所有进行中的授权静默失效，且极难排查
 * （表现为「用户点了同意却回到原点」）。
 */
export function assertBrowserSessionKey(key: string | undefined): string {
  if (!key) {
    throw new Error(
      "[mcp-oauth] MCP_BROWSER_SESSION_KEY is required for MCP browser authorization",
    );
  }
  // 按 UTF-8 字节数算：多字节字符的口令长度不等于熵。
  const bytes = Buffer.byteLength(key, "utf8");
  if (bytes < MCP_BROWSER_SESSION_KEY_MIN_BYTES) {
    throw new Error(
      `[mcp-oauth] MCP_BROWSER_SESSION_KEY must be at least ${MCP_BROWSER_SESSION_KEY_MIN_BYTES} bytes (got ${bytes})`,
    );
  }
  return key;
}

function nowSeconds(options: BrowserSessionOptions): number {
  return Math.floor((options.now ? options.now() : new Date()).getTime() / 1000);
}

function cookieOptions(options: BrowserSessionOptions) {
  return {
    path: MCP_BROWSER_COOKIE_PATH,
    httpOnly: true,
    secure: options.secure,
    sameSite: "Lax" as const,
    maxAge: MCP_BROWSER_SESSION_TTL_SECONDS,
    // 刻意不设 domain：host-only，不跨子域。
  };
}

/** 新建一次浏览器会话（不写 Cookie）。`sid` 是 32 字节随机值。 */
export function createBrowserSession(options: BrowserSessionOptions): BrowserSessionPayload {
  const iat = nowSeconds(options);
  return {
    sid: randomBytes(32).toString("base64url"),
    iat,
    exp: iat + MCP_BROWSER_SESSION_TTL_SECONDS,
  };
}

/**
 * 写入签名 Cookie。
 *
 * 密钥只在这里作为 `setSignedCookie` 的入参，**绝不**出现在 payload、
 * 日志或错误信息里。
 */
export async function setBrowserSessionCookie(
  c: Context,
  session: BrowserSessionPayload,
  options: BrowserSessionOptions,
): Promise<void> {
  const key = assertBrowserSessionKey(options.key);
  await setSignedCookie(c, MCP_BROWSER_COOKIE_NAME, JSON.stringify(session), key, {
    ...cookieOptions(options),
  });
}

/**
 * 读取并校验。
 *
 * 六种失败（缺 Cookie / 签名不符 / 非法 JSON / 字段类型错 / sid 形态错 /
 * 过期）都返回 `{ok:false}`，**绝不**降级成「匿名但放行」——那会把一次
 * 绑定校验失败变成一个可用的授权会话。
 *
 * **不续期**：这里只读，不回写 Cookie 的 `Max-Age`，所以 30 分钟是硬窗口。
 */
export async function readBrowserSessionCookie(
  c: Context,
  options: BrowserSessionOptions,
): Promise<BrowserSessionResult> {
  const key = assertBrowserSessionKey(options.key);

  const raw = await getSignedCookie(c, key, MCP_BROWSER_COOKIE_NAME);
  // Hono 在「没有这个 Cookie」与「签名不匹配」两种情况下都返回 false；
  // 两者都归结为「没有可用会话」，不必区分（区分只对攻击者有用）。
  if (raw === false || raw === undefined) return { ok: false, reason: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };

  const { sid, iat, exp } = parsed as Record<string, unknown>;
  if (typeof sid !== "string" || typeof iat !== "number" || typeof exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return { ok: false, reason: "malformed" };
  if (!SID_PATTERN.test(sid)) return { ok: false, reason: "malformed" };

  // 窗口长度必须是契约值：`exp - iat > TTL` 意味着有人拿旧 Cookie 自己
  // 改了 exp（签名会拦住，但这是第二道——万一某天换了签名实现）。
  if (exp - iat > MCP_BROWSER_SESSION_TTL_SECONDS) {
    return { ok: false, reason: "malformed" };
  }
  if (exp <= iat) return { ok: false, reason: "malformed" };

  const now = nowSeconds(options);
  if (iat > now + IAT_FUTURE_TOLERANCE_SECONDS) return { ok: false, reason: "malformed" };
  if (exp <= now) return { ok: false, reason: "expired" };

  return { ok: true, session: { sid, iat, exp } };
}

/**
 * 清除 Cookie。
 *
 * **必须用同一个 Path**：不同 Path 的 `Set-Cookie` 是另一个 Cookie，
 * 用默认 Path（`/`）清除只会留下原来的那个，于是「点完同意 Cookie 还在」。
 */
export function clearBrowserSessionCookie(c: Context, options: BrowserSessionOptions): void {
  deleteCookie(c, MCP_BROWSER_COOKIE_NAME, {
    path: MCP_BROWSER_COOKIE_PATH,
    httpOnly: true,
    secure: options.secure,
    sameSite: "Lax",
  });
}

/**
 * 浏览器 sid 的绑定哈希（设计 §5.4 的 L1 层）。
 *
 * 存进 `mcp_auth_requests.browser_binding_hash`，与 Cookie 内的 `sid` 比对。
 * 用**无 pepper 的 SHA-256**：这里的输入是 32 字节随机值，不是口令，
 * 不需要抗暴力破解；而绑定哈希必须能被服务端在任意实例上重算
 * （加 pepper 会让它依赖另一把密钥，多一处能配错的地方）。
 *
 * 域分隔（`mcp-browser:`）保证同一哈希函数在其它用途下不会撞上这里。
 */
export function browserBindingHash(sid: string): string {
  return sha256Hex(`mcp-browser:${sid}`);
}
