import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import {
  decodeBase64UrlStrict,
  filterScopes,
  helloSigningPayload,
  helloSchema,
  negotiateVersion,
  REMOTE_SCOPES,
  REMOTE_TOOLS,
  type Hello,
} from "../../src/link/schemas.js";
import {
  ed25519PublicKeyFromRaw,
  parseHelloFrame,
  verifyHelloSignature,
} from "../../src/link/handshake.js";

/**
 * 线格式与签名的**纯**单元测试（不碰数据库、不碰 socket）。
 *
 * 这一组里最重要的一条是「与 Desktop 共用同一份 golden fixture」。
 * 如果只在 Cloud 里写「我签我验都能过」，那证明的只是自洽——
 * 而两端规范串不一致时，两边各自的测试都会绿，线上却永远握不上手。
 */

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "remote-mcp",
  "hello-v1.json",
);

interface GoldenFixture {
  protocol: string;
  private_key: { seed_base64url: string };
  public_key: { base64url: string; spki_der_base64url: string };
  hello: Hello;
  canonical_payload: string;
  signature_base64url: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenFixture;

/** 由固定 seed 重建测试私钥（PKCS8 = 16 字节固定头 + 32 字节 seed）。 */
function fixturePrivateKey() {
  const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
  const seed = Buffer.from(fixture.private_key.seed_base64url, "base64url");
  expect(seed).toHaveLength(32);
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

const { sig: _sig, ...fixtureSigningInput } = fixture.hello;

describe("hello 规范串（与 Desktop 共用 golden fixture）", () => {
  it("Cloud 的规范串逐字节等于 fixture", () => {
    expect(helloSigningPayload(fixtureSigningInput).toString("utf8")).toBe(fixture.canonical_payload);
  });

  it("用 fixture 的固定私钥能复现出同一个签名（Ed25519 是确定性的）", () => {
    const signature = cryptoSign(
      null,
      helloSigningPayload(fixtureSigningInput),
      fixturePrivateKey(),
    ).toString("base64url");
    expect(signature).toBe(fixture.signature_base64url);
  });

  it("Cloud 验签接受 fixture 的签名", () => {
    expect(verifyHelloSignature(fixture.public_key.base64url, fixture.hello)).toBe(true);
  });

  it("fixture 的公钥两种表示互相一致（raw 32B ↔ SPKI 44B）", () => {
    const spki = Buffer.from(fixture.public_key.spki_der_base64url, "base64url");
    expect(spki).toHaveLength(44);
    expect(spki.subarray(12).toString("base64url")).toBe(fixture.public_key.base64url);
    const key = ed25519PublicKeyFromRaw(spki.subarray(12));
    expect(key?.asymmetricKeyType).toBe("ed25519");
    expect(key?.export({ type: "spki", format: "der" }).toString("base64url")).toBe(
      fixture.public_key.spki_der_base64url,
    );
  });

  it("capabilities 的顺序不影响签名（排序后再连接）", () => {
    const reordered = { ...fixtureSigningInput, capabilities: ["tools.call", "cancel", "drain"] };
    expect(helloSigningPayload(reordered).toString("utf8")).toBe(fixture.canonical_payload);
  });
});

describe("验签必须拒绝的九种篡改（逐条对应一个真实攻击面）", () => {
  const publicKey = fixture.public_key.base64url;

  it("改 ts", () => {
    expect(verifyHelloSignature(publicKey, { ...fixture.hello, ts: fixture.hello.ts + 1 })).toBe(false);
  });

  it("改 device_id（换一台设备的身份）", () => {
    expect(
      verifyHelloSignature(publicKey, { ...fixture.hello, device_id: "another-device-id" }),
    ).toBe(false);
  });

  it("改 capabilities（偷偷少声明一个能力）", () => {
    expect(
      verifyHelloSignature(publicKey, { ...fixture.hello, capabilities: ["cancel"] }),
    ).toBe(false);
  });

  it("改 serviceable（把不可服务的设备说成可服务）", () => {
    expect(verifyHelloSignature(publicKey, { ...fixture.hello, serviceable: false })).toBe(false);
  });

  it("改成另一台设备的公钥", () => {
    const other = createPublicKey(fixturePrivateKey());
    // 换个 seed 生成另一把公钥
    const otherSeed = Buffer.alloc(32, 0x7f);
    const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
    const otherKey = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, otherSeed]),
      format: "der",
      type: "pkcs8",
    });
    const otherRaw = createPublicKey(otherKey)
      .export({ type: "spki", format: "der" })
      .subarray(12)
      .toString("base64url");
    expect(otherRaw).not.toBe(publicKey);
    expect(other.asymmetricKeyType).toBe("ed25519"); // 确保证明文本身是合法的 Ed25519
    expect(verifyHelloSignature(otherRaw, fixture.hello)).toBe(false);
  });

  it("签名长度不是 64 字节（截断 / 补字节）", () => {
    const sig = Buffer.from(fixture.signature_base64url, "base64url");
    expect(sig).toHaveLength(64);
    for (const slice of [sig.subarray(0, 63), Buffer.concat([sig, Buffer.from([0])])]) {
      expect(verifyHelloSignature(publicKey, { ...fixture.hello, sig: slice.toString("base64url") })).toBe(
        false,
      );
    }
  });

  it("公钥多一个字节（DER 尾部垃圾的真实形态）", () => {
    const raw = Buffer.from(publicKey, "base64url");
    const padded = Buffer.concat([raw, Buffer.from([0])]).toString("base64url");
    expect(verifyHelloSignature(padded, fixture.hello)).toBe(false);
    // 拼成 SPKI 也必须被长度断言挡住
    expect(ed25519PublicKeyFromRaw(Buffer.concat([raw, Buffer.from([0])]))).toBeNull();
  });

  it("公钥不是 Ed25519 曲线上的点：验签必须失败（而不是抛错）", () => {
    // 重要发现：Node 的 `createPublicKey` **不校验**压缩点是否在曲线上——
    // 任意 32 字节都能被包成 `asymmetricKeyType === 'ed25519'` 的 KeyObject。
    // 所以「类型检查」挡不住伪造公钥，真正的判据只能是 `crypto.verify` 本身。
    // 这里断言的是行为：返回 false，而不是抛出一个被上层 catch 掉后当成 false 的异常。
    const bogus = Buffer.alloc(32, 0xff);
    expect(verifyHelloSignature(bogus.toString("base64url"), fixture.hello)).toBe(false);
    // 即便能构造出 KeyObject，它也只能是 ed25519（我们只拼这一种 SPKI 前缀）。
    const key = ed25519PublicKeyFromRaw(bogus);
    if (key) expect(key.asymmetricKeyType).toBe("ed25519");
  });

  it("签名不是规范 base64url（含填充 / 非法字符）", () => {
    const sig = fixture.signature_base64url;
    for (const bad of [`${sig}=`, sig.replace(/-/g, "+"), "!!!", ""]) {
      expect(verifyHelloSignature(publicKey, { ...fixture.hello, sig: bad })).toBe(false);
    }
  });

  it("缺 sig 字段 → 失败而不是抛错", () => {
    const { sig: _omit, ...withoutSig } = fixture.hello;
    expect(verifyHelloSignature(publicKey, withoutSig as unknown as Hello)).toBe(false);
  });

  it("换掉公钥的最后一个字节 → 失败", () => {
    const raw = Buffer.from(fixture.public_key.base64url, "base64url");
    const mutated = Buffer.concat([raw.subarray(0, 31), Buffer.from([raw[31]! ^ 1])]).toString("base64url");
    expect(mutated).not.toBe(fixture.public_key.base64url);
    expect(verifyHelloSignature(mutated, fixture.hello)).toBe(false);
  });
});

describe("hello 帧的形状校验（闭合键集）", () => {
  const golden = JSON.stringify(fixture.hello);

  it("fixture 本身合法", () => {
    const parsed = parseHelloFrame(golden);
    expect(parsed.ok).toBe(true);
  });

  it("未知字段被拒绝", () => {
    const withExtra = JSON.stringify({ ...fixture.hello, extra: 1 });
    const parsed = parseHelloFrame(withExtra);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toEqual({ kind: "protocol", detail: "hello shape invalid" });
  });

  it("缺字段被拒绝", () => {
    const { capabilities: _c, ...withoutCapabilities } = fixture.hello;
    expect(parseHelloFrame(JSON.stringify(withoutCapabilities)).ok).toBe(false);
  });

  it("v 是 2 → 归到 version（4002），不是形状错误", () => {
    const parsed = parseHelloFrame(JSON.stringify({ ...fixture.hello, v: 2 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.kind).toBe("version");
  });

  it("v 不是整数 → 形状错误（4009），不是版本问题", () => {
    for (const v of ["1", 1.5, null]) {
      const parsed = parseHelloFrame(JSON.stringify({ ...fixture.hello, v }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.failure.kind).toBe("protocol");
    }
  });

  it("第一帧不是 hello → protocol", () => {
    const parsed = parseHelloFrame(JSON.stringify({ v: 1, type: "ping", ts: 1, seq: 1 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toMatchObject({ kind: "protocol" });
  });

  it("字段值含换行 → 拒绝（规范串歧义）", () => {
    for (const field of ["device_id", "platform", "app_version"] as const) {
      const parsed = parseHelloFrame(JSON.stringify({ ...fixture.hello, [field]: "a\nb" }));
      expect(parsed.ok, `${field} 含换行时必须拒绝`).toBe(false);
    }
    const parsed = parseHelloFrame(
      JSON.stringify({ ...fixture.hello, capabilities: ["cancel\nserviceable=false"] }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("nonce 不是 22 字符 base64url → 拒绝", () => {
    for (const nonce of ["short", "A".repeat(23), "A".repeat(22) + "=", "!!!!!!!!!!!!!!!!!!!!!!"]) {
      expect(parseHelloFrame(JSON.stringify({ ...fixture.hello, nonce })).ok).toBe(false);
    }
  });

  it("min_version > max_version → 拒绝（区间不成立）", () => {
    expect(
      parseHelloFrame(JSON.stringify({ ...fixture.hello, min_version: 3, max_version: 2 })).ok,
    ).toBe(false);
  });

  it("不是 JSON / 不是对象 / 是数组 → protocol", () => {
    for (const raw of ["not json", "[]", "null", "\"hello\""]) {
      const parsed = parseHelloFrame(raw);
      expect(parsed.ok).toBe(false);
    }
  });
});

describe("版本协商公式", () => {
  it("默认区间 [1,1] 只有 1 有交集", () => {
    expect(negotiateVersion(1, 1)).toBe(1);
    expect(negotiateVersion(1, 2)).toBe(1);
    expect(negotiateVersion(0, 1)).toBe(1);
  });

  it("无交集返回 null", () => {
    expect(negotiateVersion(2, 2)).toBeNull();
    expect(negotiateVersion(2, 3)).toBeNull();
    expect(negotiateVersion(0, 0)).toBeNull();
  });

  it("取双方共同支持的最高版本（不是简单的 min）", () => {
    // 服务端 [1,2]、客户端 [1,3] → 2
    expect(negotiateVersion(1, 3, 1, 2)).toBe(2);
    // 客户端下限高于服务端上限 → 无交集
    expect(negotiateVersion(3, 5, 1, 2)).toBeNull();
  });

  it("区间本身不成立 → null", () => {
    expect(negotiateVersion(3, 2)).toBeNull();
    expect(negotiateVersion(1, 1, 3, 2)).toBeNull();
  });
});

describe("scope 白名单", () => {
  it("只保留 REMOTE_SCOPES 内的项，并去重", () => {
    expect(
      filterScopes(["records:read", "records:write", "coffee:read", "records:read"]),
    ).toEqual(["records:read", "coffee:read"]);
  });

  it("全部越界 → 空数组（而不是抛错：授权存在但无一可用是合法状态）", () => {
    expect(filterScopes(["records:write", "admin"])).toEqual([]);
  });

  it("白名单恰好是文档里的 4 个", () => {
    expect([...REMOTE_SCOPES]).toEqual(["records:read", "tags:read", "coffee:read", "canvas:read"]);
  });
});

describe("远程工具白名单", () => {
  it("恰好是协议 §4.4 的 8 个只读工具，顺序一致", () => {
    expect([...REMOTE_TOOLS]).toEqual([
      "search_records",
      "get_record",
      "list_record_tags",
      "list_beans",
      "list_brews",
      "list_tastings",
      "list_canvases",
      "get_canvas",
    ]);
  });
});

describe("base64url 严格解码", () => {
  it("接受规范编码", () => {
    const buf = Buffer.from("hello world");
    const text = buf.toString("base64url");
    expect(decodeBase64UrlStrict(text, buf.length)?.equals(buf)).toBe(true);
  });

  it("长度不符 / 非法字符 / 空串 → null", () => {
    expect(decodeBase64UrlStrict("AAAA", 5)).toBeNull();
    expect(decodeBase64UrlStrict("!!!!", 3)).toBeNull();
    expect(decodeBase64UrlStrict("", 0)).toBeNull();
  });

  it("带填充的 base64 → null（不是 base64url 的无填充形态）", () => {
    expect(decodeBase64UrlStrict("aGVsbG8=", 5)).toBeNull();
  });

  it("拒绝非规范编码（同一字节有多种文本表示）", () => {
    // 22 字符的 nonce：最后一个字符的低 4 bit 是填充位。
    // 把末位换成另一个「解码后字节相同」的字符，重新编码会得到规范形态，
    // 因此严格解码必须拒绝那个非规范输入。
    const canonical = Buffer.from(Array.from({ length: 16 }, (_, i) => i)).toString("base64url");
    expect(decodeBase64UrlStrict(canonical, 16)).not.toBeNull();
    const lastChar = canonical.at(-1) as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(lastChar);
    // 末位字符的低 2 bit 是填充位：同一字节对应 4 个字符，只有 1 个是规范的。
    for (let delta = 1; delta < 4; delta += 1) {
      const mutated = canonical.slice(0, -1) + alphabet[(index & ~3) + ((index + delta) & 3)];
      if (mutated === canonical) continue;
      const decoded = Buffer.from(mutated, "base64url");
      if (!decoded.equals(Buffer.from(canonical, "base64url"))) continue;
      expect(decodeBase64UrlStrict(mutated, 16), `${mutated} 是非规范编码`).toBeNull();
    }
  });
});

describe("helloSchema 与 fixture 的字段集一致", () => {
  it("字段集合恰好是 13 个（含 sig）", () => {
    const keys = Object.keys(helloSchema.shape).sort();
    expect(keys).toEqual(
      [
        "app_version",
        "capabilities",
        "device_id",
        "max_version",
        "min_version",
        "nonce",
        "platform",
        "serviceable",
        "sig",
        "ts",
        "type",
        "v",
      ].sort(),
    );
  });

  it("fixture 的字段集也是这 13 个（防止 fixture 落后于 schema）", () => {
    expect(Object.keys(fixture.hello).sort()).toEqual(Object.keys(helloSchema.shape).sort());
  });
});
