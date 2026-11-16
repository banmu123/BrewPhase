/**
 * 极简结构化日志。纪律：
 * - 永远不打印请求体、Authorization 头、Token、OAuth Code、Client Secret；
 * - 只记录方法、路径、状态码与耗时，附加对象经过 redact 脱敏。
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_PATTERN = /(token|code|secret|authorization|password|refresh|verifier|nonce)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date || typeof value !== "object") {
    return value instanceof Error ? value.message : value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: Level = "info"): Logger {
  const min = LEVEL_ORDER[level];
  const emit = (target: Level, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[target] < min) return;
    const line = {
      ts: new Date().toISOString(),
      level: target,
      msg: message,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const text = JSON.stringify(line);
    if (target === "error") console.error(text);
    else if (target === "warn") console.warn(text);
    else console.log(text);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
