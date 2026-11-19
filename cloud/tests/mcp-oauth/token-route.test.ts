import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestDb, ensureDatabaseOrThrow, getTestDb, resetDb } from "../helpers/db.js";
import { createMcpOAuthHarness, seedAuthorizeClient, type McpOAuthHarness } from "../helpers/mcp-oauth-app.js";
import { resetRateLimiter } from "../../src/security/rate-limit.js";
import {
  exchangeCode,
  obtainAuthCode,
  postToken,
  postTokenRaw,
  readTokenResponse,
  refreshToken,
  refreshRows,
  sessionCount,
  type AuthCodeFixture,
} from "../helpers/mcp-token.js";

/**
 * Token Endpoint 的**协议面**（Phase 1.3.1-C3a）：表单解析、错误码、限流与隔离。
 *
 * 这一组不重复业务判据（那些在 token-code / token-refresh / token-atomicity），
 * 只钉三件事：畸形请求怎么拒、错误码对不对、以及「它绝不碰 Desktop 的任何表」。
 */

const handle = await getTestDb();
let h: McpOAuthHarness;
let fixture: AuthCodeFixture;

beforeEach(async () => {
  await ensureDatabaseOrThrow();
  await resetDb(handle);
  resetRateLimiter();
  h = await createMcpOAuthHarness();
  await seedAuthorizeClient(handle);
  fixture = await obtainAuthCode(h);
});

afterAll(async () => {
  await closeTestDb();
});

function baseFields(): Record<string, string> {
  return {
    grant_type: "authorization_code",
    code: fixture.code,
    client_id: fixture.clientId,
    redirect_uri: fixture.redirectUri,
    code_verifier: fixture.verifier,
    resource: "https://gateway.example/mcp",
  };
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error: string };
  return body.error;
}

describe("表单格式", () => {
  it("JSON body → invalid_request", async () => {
    const res = await postTokenRaw(h, JSON.stringify(baseFields()), "application/json");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("multipart 同样拒绝", async () => {
    const res = await postTokenRaw(h, "grant_type=authorization_code", "multipart/form-data; boundary=x");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("缺少任何一个必填字段 → invalid_request", async () => {
    for (const field of ["grant_type", "client_id", "resource", "code", "redirect_uri", "code_verifier"]) {
      const fields = baseFields();
      delete (fields as Record<string, string | undefined>)[field];
      const res = await postToken(h, fields);
      expect(res.status, field).toBe(400);
      expect(await errorOf(res), field).toBe("invalid_request");
    }
  });

  it("重复字段 → invalid_request（不做「取第一个/最后一个」的猜测）", async () => {
    const body =
      `grant_type=authorization_code&grant_type=refresh_token` +
      `&code=${fixture.code}&client_id=${fixture.clientId}` +
      `&redirect_uri=${encodeURIComponent(fixture.redirectUri)}` +
      `&code_verifier=${fixture.verifier}&resource=${encodeURIComponent("https://gateway.example/mcp")}`;
    const res = await postTokenRaw(h, body);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("重复字段的错误文案不回显字段名（也不带换行）", async () => {
    // 字段名是请求方可控的（这里塞了 %0A），拼进 description 就是日志注入面。
    const res = await postTokenRaw(h, "x-evil%0Ainjected=1&x-evil%0Ainjected=2");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description?: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toBe("a parameter appears more than once");
    expect(JSON.stringify(body)).not.toContain("x-evil");
    expect(JSON.stringify(body)).not.toContain("\\n");
    expect(await codeConsumed()).toBe(false);
  });

  it("请求体超限 → invalid_request", async () => {
    const res = await postTokenRaw(h, `grant_type=${"x".repeat(9000)}`);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("未知 grant_type → unsupported_grant_type", async () => {
    const res = await postToken(h, { ...baseFields(), grant_type: "client_credentials" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("unsupported_grant_type");
  });

  it("GET 不提供服务（不是 200）", async () => {
    const res = await h.app.request("/mcp/oauth/token");
    expect(res.status).not.toBe(200);
  });
});

/**
 * 请求体边界（Phase 1.3.1-C3a-R1）。
 *
 * 要修的三件事：用 `.length`（UTF-16 码元）冒充字节数、先整体读入再判大小、
 * 以及 `startsWith` 放行 `…-evil` 后缀的媒体类型。每一条都用真实请求打路由，
 * 并且**验证数据库状态**——只断言 400 无法区分「拒绝了」与「拒绝了但已经
 * 把授权码烧掉了」。
 */

interface RawRequestOptions {
  body: string | Uint8Array;
  /** 传 `null` 表示不带 Content-Type。 */
  contentType?: string | null;
  contentLength?: string;
}

async function postRawRequest(
  h: McpOAuthHarness,
  options: RawRequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.contentType !== null) {
    headers["content-type"] = options.contentType ?? "application/x-www-form-urlencoded";
  }
  if (options.contentLength !== undefined) {
    headers["content-length"] = options.contentLength;
  }
  return h.app.request("/mcp/oauth/token", {
    method: "POST",
    headers,
    body: options.body as NonNullable<RequestInit["body"]>,
  });
}

/** 授权码是否已被消费（读库，不读响应）。 */
async function codeConsumed(): Promise<boolean> {
  const rows = await handle.sql<{ count: string }[]>`
    select count(*)::text as count from mcp_auth_codes where consumed_at is not null`;
  return Number(rows[0]?.count ?? "0") > 0;
}

/** 针对某枚授权码的完整表单。 */
function formFor(target: AuthCodeFixture): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: target.code,
    client_id: target.clientId,
    redirect_uri: target.redirectUri,
    code_verifier: target.verifier,
    resource: "https://gateway.example/mcp",
  }).toString();
}

/**
 * 一条「本来能成功」的表单，填充到**恰好** `targetBytes` 个 UTF-8 字节。
 *
 * 填充被拆成每段 ≤500 字符的独立字段：单字段有 512 字符上限（C3a-R2），
 * 用一个 7000 字符的 `pad` 去撑 body 会先撞上字段上限，测不到「请求体字节
 * 上限」这条判据。最后的零头用 `&` 补齐（空键、空值，不影响解析）。
 */
function formWithPaddingBytes(targetBytes: number): string {
  const base = formFor(fixture);
  let body = base;
  let index = 0;
  const size = () => Buffer.byteLength(body, "utf8");
  while (size() < targetBytes) {
    const remaining = targetBytes - size();
    const prefix = `&pad${index}=`;
    if (remaining <= prefix.length + 1) {
      body += "&".repeat(remaining);
      break;
    }
    const chunk = "p".repeat(Math.min(500, remaining - prefix.length));
    body += prefix + chunk;
    index += 1;
  }
  return body;
}

/**
 * 用多字节字符把 body 撑到「字节超限、字符数远小于 8192」。
 *
 * 每个字段 500 个汉字（1500 字节、500 字符），仍在单字段上限内。
 */
function formWithMultibytePadding(fieldCount: number, charsPerField: number): string {
  const parts = [formFor(fixture)];
  for (let i = 0; i < fieldCount; i += 1) {
    parts.push(`pad${i}=${"汉".repeat(charsPerField)}`);
  }
  return parts.join("&");
}

describe("请求体字节上限", () => {
  it("小于 8 KiB 的请求仍然可以兑换（上限没有被改小）", async () => {
    // 8 KiB 减去表单本身的长度，留一点余量，确保仍在限内。
    const res = await postRawRequest(h, { body: formWithPaddingBytes(7000) });
    expect(res.status).toBe(200);
    expect(await codeConsumed()).toBe(true);
  });

  it("UTF-8 实际字节数超限、但字符串长度没超 → 拒绝（.length 不能当字节）", async () => {
    // 3000 个汉字：JS 字符串长度约 3050（< 8192），实际 UTF-8 9000 字节（> 8192）。
    const body = formWithMultibytePadding(6, 500);
    expect(body.length).toBeLessThan(8192);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(8192);

    const res = await postRawRequest(h, { body });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");

    // 关键：拒绝必须发生在任何写入之前。
    expect(await codeConsumed()).toBe(false);
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(0);
  });

  it("没有 Content-Length 时按实际流累计截断", async () => {
    // `app.request` 不会自动带 content-length，所以这条走的就是流累计路径。
    const body = formWithPaddingBytes(9000);
    const res = await postRawRequest(h, { body });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    expect(await codeConsumed()).toBe(false);
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
  });

  it("Content-Length 声称超限 → 提前拒绝（不读 body）", async () => {
    const res = await postRawRequest(h, {
      body: "grant_type=authorization_code",
      contentLength: "9000",
    });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    expect(await codeConsumed()).toBe(false);
  });

  it("Content-Length 撒谎（声称 10，实际超限）→ 仍按实际字节拒绝", async () => {
    const body = formWithPaddingBytes(9000);
    const res = await postRawRequest(h, { body, contentLength: "10" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    expect(await codeConsumed()).toBe(false);
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(0);
  });

  it("Content-Length 不是合法字节数（空 / 负数 / 小数 / 科学计数）→ 拒绝", async () => {
    // 同样用**完整合法表单**：这样「返回 400」只可能来自 header 校验，
    // 而不是来自「body 解析后缺字段」。
    for (const value of ["", "-1", "1.5", "1e3", "12abc"]) {
      const res = await postRawRequest(h, { body: formFor(fixture), contentLength: value });
      expect(res.status, value).toBe(400);
      expect(await errorOf(res), value).toBe("invalid_request");
    }
    // 五条都没通过 header 校验，授权码不能被消费。
    expect(await codeConsumed()).toBe(false);
  });

  it("超限后立刻停止读取（不把整个 body 拉进内存）", async () => {
    // 1 MiB 的流式 body。若实现是「先读完再判大小」，这里的 `pulled` 会到
    // 1 MiB；正确实现只可能拉到略多于 8 KiB（允许一个 chunk 的超出）。
    const chunk = new Uint8Array(1024).fill(0x61);
    const maxPulled = 1024 * 1024;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= maxPulled) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const res = await h.app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      // undici 对「流式请求体」要求显式声明半双工。
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    // 下限：必须真的读到超过上限才停（否则「根本没读」也会让上界通过）。
    expect(pulled).toBeGreaterThan(8192);
    // 上限 8192 + 一个 1024 的 chunk 已经是宽松上界；读满 1 MiB 必然失败。
    expect(pulled).toBeLessThanOrEqual(9 * 1024);
    expect(await codeConsumed()).toBe(false);
  });

  it("恰好 8192 字节仍然接受（上限是「大于」才拒）", async () => {
    const body = formWithPaddingBytes(8192);
    expect(Buffer.byteLength(body, "utf8")).toBe(8192);

    const res = await postRawRequest(h, { body });
    expect(res.status).toBe(200);
  });

  it("8193 字节被拒绝（边界只差一个字节）", async () => {
    const res = await postRawRequest(h, { body: formWithPaddingBytes(8193) });
    expect(res.status).toBe(400);
    expect(await codeConsumed()).toBe(false);
  });
});

describe("字段值统一限长（C3a-R2）", () => {
  /** 512 字符、语义仍是单个合法 scope（尾部空格不产生 token）。 */
  function scopeOfLength(length: number): string {
    return "records:read".padEnd(length, " ");
  }

  it("scope 恰好 512 字符 → 正常兑换（上限是 512，不是 511）", async () => {
    const scope = scopeOfLength(512);
    expect(scope.length).toBe(512);

    const res = await exchangeCode(h, fixture, { scope });
    expect(res.status).toBe(200);
    // 兑换真的发生了：授权码被消费，Session 与初代 Refresh 都建了。
    expect(await codeConsumed()).toBe(true);
    expect(await sessionCount(handle, fixture.userId)).toBe(1);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(1);
  });

  it("scope 513 字符 → 400 invalid_request，且不消费授权码", async () => {
    const res = await exchangeCode(h, fixture, { scope: scopeOfLength(513) });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");

    expect(await codeConsumed()).toBe(false);
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(0);
  });

  it("未知扩展字段 513 字符 → 400（扩展字段可以忽略，但不能无限长）", async () => {
    const body = `${formFor(fixture)}&extension=${"x".repeat(513)}`;
    const res = await postRawRequest(h, { body });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");

    expect(await codeConsumed()).toBe(false);
    expect(await sessionCount(handle, fixture.userId)).toBe(0);
    expect(await refreshRows(handle, fixture.userId)).toHaveLength(0);
  });

  it("未知扩展字段 512 字符 → 照旧忽略，兑换正常", async () => {
    const body = `${formFor(fixture)}&extension=${"x".repeat(512)}`;
    const res = await postRawRequest(h, { body });
    expect(res.status).toBe(200);
    expect(await codeConsumed()).toBe(true);
  });

  it("必填字段超长同样拒绝（code 700 字符）", async () => {
    const res = await exchangeCode(h, fixture, { code: "c".repeat(700) });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    expect(await codeConsumed()).toBe(false);
  });
});

describe("Content-Type 严格解析", () => {
  it("charset 参数（大小写混合、带引号、无空格）都被接受", async () => {
    for (const contentType of [
      "application/x-www-form-urlencoded; charset=UTF-8",
      "application/x-www-form-urlencoded;charset=utf-8",
      'application/x-www-form-urlencoded; charset="UTF-8"',
      "APPLICATION/X-WWW-FORM-URLENCODED; Charset=Utf-8",
    ]) {
      // 每次换一枚新授权码：授权码一次性，复用会让后续迭代变成 invalid_grant，
      // 那样「200」就永远不可能出现，断言会空转。
      const fresh = await obtainAuthCode(h);
      const res = await postRawRequest(h, { body: formFor(fresh), contentType });
      expect(res.status, contentType).toBe(200);
    }
  });

  it("charset 合法 → 200（用独立授权码验证真的解析成功）", async () => {
    const fresh = await obtainAuthCode(h);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: fresh.code,
      client_id: fresh.clientId,
      redirect_uri: fresh.redirectUri,
      code_verifier: fresh.verifier,
      resource: "https://gateway.example/mcp",
    }).toString();

    const res = await postRawRequest(h, {
      body,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    expect(res.status).toBe(200);
    const tokens = await readTokenResponse(res);
    expect(tokens.token_type).toBe("Bearer");
  });

  it("同一个参数重复出现 → 拒绝（即使值完全相同）", async () => {
    for (const contentType of [
      "application/x-www-form-urlencoded; charset=utf-8; charset=utf-8",
      "application/x-www-form-urlencoded; Charset=UTF-8; charset=utf-8",
      "application/x-www-form-urlencoded; charset=utf-8; CHARSET=utf-8",
      "application/x-www-form-urlencoded; charset=utf-8; charset=UTF-8",
    ]) {
      const res = await postTokenRaw(h, formFor(fixture), contentType);
      expect(res.status, contentType).toBe(400);
      expect(await errorOf(res), contentType).toBe("invalid_request");
    }
    // 四种写法都被拒绝，授权码不能被消费。
    expect(await codeConsumed()).toBe(false);
  });

  it("单个 charset 参数仍然接受（与重复声明区分开）", async () => {
    const fresh = await obtainAuthCode(h);
    const res = await postRawRequest(h, {
      body: formFor(fresh),
      contentType: "application/x-www-form-urlencoded; charset=utf-8",
    });
    expect(res.status).toBe(200);
  });

  it("非法媒体类型后缀 → 拒绝（不是 startsWith 就放行）", async () => {
    for (const contentType of [
      "application/x-www-form-urlencoded-evil",
      "application/x-www-form-urlencodedx",
      "application/x-www-form-urlencoded;",
      "application/x-www-form-urlencoded; charset=utf-8;",
      "application/x-www-form-urlencoded; charset",
      "application/x-www-form-urlencoded; charset=iso-8859-1",
      "application/x-www-form-urlencoded; boundary=x",
      "application/x-www-form-urlencoded, application/json",
      "text/plain",
      "application/json",
      "multipart/form-data; boundary=x",
    ]) {
      const res = await postTokenRaw(h, formFor(fixture), contentType);
      expect(res.status, contentType).toBe(400);
      expect(await errorOf(res), contentType).toBe("invalid_request");
    }
    // 一个都没成功，授权码自然也不能被消费。
    expect(await codeConsumed()).toBe(false);
  });

  it("缺 Content-Type → 拒绝", async () => {
    const res = await postRawRequest(h, { body: formFor(fixture), contentType: null });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    expect(await codeConsumed()).toBe(false);
  });
});

describe("UTF-8 严格解码", () => {
  it("非法 UTF-8 字节序列 → invalid_request（不替换成 U+FFFD）", async () => {
    // **完整合法表单** + 尾部非法字节（0xFF 0xFE 在 UTF-8 里不是合法起始/延续）。
    //
    // 这一点很关键：如果只发 `grant_type=…` 这一段，宽松解码之后仍然会死在
    // 「缺 client_id」上，错误码同为 invalid_request——两种实现就区分不出来了。
    // 表单必须是「除了解码之外一切正常」，断言才有意义。
    const head = Buffer.from(`&note=`, "utf8");
    const bytes = new Uint8Array(
      Buffer.concat([Buffer.from(formFor(fixture), "utf8"), head, Buffer.from([0xff, 0xfe])]),
    );
    const res = await postRawRequest(h, { body: bytes });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    expect(await codeConsumed()).toBe(false);
  });

  it("被截断的多字节序列（半个汉字）同样拒绝", async () => {
    const body = Buffer.from(`code=${fixture.code}&x=`, "utf8");
    const partial = Buffer.from("汉", "utf8").subarray(0, 2);
    const res = await postRawRequest(h, { body: new Uint8Array(Buffer.concat([body, partial])) });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("invalid_request");
    expect(await codeConsumed()).toBe(false);
  });

  it("合法 UTF-8（含中文值）不会因为严格解码被误拒", async () => {
    // 中文出现在一个未知字段里：解析要成功，兑换也要成功（未知参数被忽略）。
    const body = `${formFor(fixture)}&pad=值&note=烘焙`;
    const res = await postRawRequest(h, { body });
    expect(res.status).toBe(200);
  });
});

describe("Cookie 与认证", () => {
  it("不依赖任何 Cookie：带一个伪造的 bp_mcp_bs 也能正常兑换", async () => {
    const res = await h.app.request("/mcp/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "bp_mcp_bs=forged.value",
      },
      body: new URLSearchParams(baseFields()).toString(),
    });
    expect(res.status).toBe(200);
  });

  it("不需要 Authorization 头", async () => {
    const res = await postToken(h, baseFields());
    expect(res.status).toBe(200);
  });

  it("成功响应不带 Location（token 绝不出现在 URL 里）", async () => {
    const res = await exchangeCode(h, fixture);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("响应头：凭据不许被缓存", () => {
  it("成功响应带 no-store + no-cache", async () => {
    const res = await exchangeCode(h, fixture);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("错误响应同样带（错误体里也可能有可用信息）", async () => {
    const res = await postToken(h, { ...baseFields(), grant_type: "client_credentials" });
    expect(res.status).toBe(400);
    // `respondError` 走 `c.json(..., headers)`，必须与 `c.header()` 合并而不是覆盖。
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });
});

describe("限流", () => {
  it("token 桶独立且按 maxToken 计数", async () => {
    // 第 21 次（maxToken = 20）应当被限流，而不是继续返回 400。
    const statuses: number[] = [];
    for (let i = 0; i < h.env.rateLimit.maxToken + 1; i += 1) {
      const res = await postToken(h, {
        ...baseFields(),
        grant_type: "unsupported_value",
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, h.env.rateLimit.maxToken).every((s) => s === 400)).toBe(true);
    expect(statuses[h.env.rateLimit.maxToken]).toBe(429);
  });
});

describe("隔离：不碰 Desktop 的任何东西", () => {
  it("兑换 + 刷新都不写 oauth_codes / oauth_transactions / auth_sessions", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));
    await refreshToken(h, { refreshToken: tokens.refresh_token });

    for (const table of ["oauth_codes", "oauth_transactions", "auth_sessions"]) {
      const rows = await handle.sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from "${table}"`,
      );
      expect(Number(rows[0]?.count ?? "-1"), table).toBe(0);
    }
  });

  it("Desktop 的 /oauth/token 行为不变（仍是 JSON invalid_request）", async () => {
    const res = await h.app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await errorOf(res)).toBe("invalid_request");
  });

  it("MCP 的 token 不能通过 Desktop 的校验（aud 隔离）", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));
    const res = await h.app.request("/auth/me", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("日志与存储不含凭据", () => {
  it("审计事件里没有 access / refresh token 明文", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));
    const next = await readTokenResponse(await refreshToken(h, { refreshToken: tokens.refresh_token }));

    for (const secret of [tokens.access_token, tokens.refresh_token, next.access_token, next.refresh_token]) {
      const rows = await handle.sql<{ count: string }[]>`
        select count(*)::text as count from auth_events where strpos(detail::text, ${secret}) > 0`;
      expect(rows[0]?.count).toBe("0");
    }
  });

  it("库里没有明文 refresh token，也没有明文授权码", async () => {
    const tokens = await readTokenResponse(await exchangeCode(h, fixture));

    const refresh = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_refresh_tokens where strpos(token_hash, ${tokens.refresh_token}) > 0`;
    expect(refresh[0]?.count).toBe("0");

    const code = await handle.sql<{ count: string }[]>`
      select count(*)::text as count from mcp_auth_codes where strpos(code_hash, ${fixture.code}) > 0`;
    expect(code[0]?.count).toBe("0");
  });
});
