import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

/**
 * 本地 mock Provider 服务器。测试里 Cloud 的 provider 端点指向这些服务器，
 * 走的是「真实 HTTP 调用 + 真实 jose JWKS 验签」的完整代码路径，只把
 * Google/GitHub 的前端页面与身份签发替换为可控实现。
 *
 * 约定：provider 授权码是一段 base64url(JSON)，承载身份与 nonce；
 * token 端点校验 redirect_uri / grant_type / client_id 后签发：
 * - Google：RS256 ID Token（JWKS 公钥开放在 /.well-known/jwks）；
 * - GitHub：不透明 access_token（gho_...），/user 端点凭其返回资料。
 */

const KID = "test-key";
const GOOGLE_ISSUER = "https://accounts.google.com";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodePayload<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export interface MockGoogleIdentity {
  sub: string;
  email?: string | null;
  email_verified?: boolean;
  name?: string;
  picture?: string | null;
}

export interface MockGithubIdentity {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
  /** 故障注入：/user 端点返回 2xx 非 JSON 垃圾体（I-6 测试） */
  badUserJson?: boolean;
}

interface GoogleTokenPayload {
  identity: MockGoogleIdentity;
  nonce: string;
  redirectUri: string;
  useWrongKey?: boolean;
  failToken?: boolean;
  /** 故障注入：token 端点返回 2xx 非 JSON 垃圾体（I-6 测试） */
  badJson?: boolean;
  /** 故障注入：token 端点返回合法 JSON 但缺 id_token 字段（I-6 测试） */
  omitIdToken?: boolean;
}

interface GithubTokenPayload {
  identity: MockGithubIdentity;
  redirectUri: string;
  failToken?: boolean;
  /** 故障注入：token 端点返回 2xx 非 JSON 垃圾体（I-6 测试） */
  badJson?: boolean;
}

export interface MockHttpServer {
  url: string;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startMockGoogle(): Promise<MockHttpServer> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const { privateKey: wrongKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url?.startsWith("/.well-known/jwks")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }],
          }),
        );
        return;
      }

      if (req.method === "POST" && req.url?.startsWith("/token")) {
        const params = new URLSearchParams(await readBody(req));
        const payload = decodePayload<GoogleTokenPayload>(params.get("code") ?? "");

        if (payload.badJson) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("not-json{{{");
          return;
        }
        if (payload.failToken) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "mock_provider_error" }));
          return;
        }
        if (params.get("grant_type") !== "authorization_code") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unsupported_grant_type" }));
          return;
        }
        if (params.get("redirect_uri") !== payload.redirectUri) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "redirect_uri_mismatch" }));
          return;
        }
        if (params.get("client_id") !== "test-google-client-id") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }

        const idToken = await new SignJWT({
          email: payload.identity.email ?? undefined,
          email_verified: payload.identity.email_verified ?? undefined,
          name: payload.identity.name,
          picture: payload.identity.picture ?? undefined,
          nonce: payload.nonce,
        })
          .setProtectedHeader({ alg: "RS256", kid: KID })
          .setSubject(payload.identity.sub)
          .setIssuer(GOOGLE_ISSUER)
          .setAudience(params.get("client_id") ?? "")
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(payload.useWrongKey ? wrongKey : (privateKey as CryptoKey));

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            payload.omitIdToken
              ? { access_token: "ya29.mock", token_type: "Bearer", expires_in: 3600 }
              : {
                  access_token: "ya29.mock-access-token",
                  id_token: idToken,
                  token_type: "Bearer",
                  expires_in: 3600,
                },
          ),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_mock_request" }));
    }
  });

  const url = await listen(server);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}

export async function startMockGithub(): Promise<MockHttpServer> {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url?.startsWith("/login/oauth/access_token")) {
        const params = new URLSearchParams(await readBody(req));
        const payload = decodePayload<GithubTokenPayload>(params.get("code") ?? "");

        if (payload.badJson) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("not-json{{{");
          return;
        }
        if (payload.failToken) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "mock_provider_error" }));
          return;
        }
        if (params.get("redirect_uri") !== payload.redirectUri) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "redirect_uri_mismatch" }));
          return;
        }
        if (
          params.get("client_id") !== "test-github-client-id" ||
          params.get("client_secret") !== "test-github-client-secret"
        ) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: `gho_${encodePayload(payload.identity)}`,
            token_type: "bearer",
            scope: "",
          }),
        );
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/user")) {
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token.startsWith("gho_")) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Bad credentials" }));
          return;
        }
        const identity = decodePayload<MockGithubIdentity>(token.slice(4));
        if (identity.badUserJson) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("not-json{{{");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: identity.id,
            login: identity.login,
            name: identity.name ?? null,
            avatar_url: identity.avatar_url ?? null,
            email: identity.email ?? null,
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_mock_request" }));
    }
  });

  const url = await listen(server);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}
