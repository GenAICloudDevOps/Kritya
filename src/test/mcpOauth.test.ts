import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { loadMcpTools, mcpStatus, shutdownMcp } from "../mcp/client.js";
import { startCallbackServer } from "../mcp/callback.js";
import { beginLogin, extractCode, logout } from "../mcp/login.js";
import {
  authServerMetadataUrls,
  buildAuthorizeUrl,
  createPkce,
  parseWwwAuthenticate,
  resourceMetadataUrls,
} from "../mcp/oauth.js";
import { authKey, isExpired, loadAuth, saveAuth, type StoredAuth } from "../mcp/tokens.js";

/**
 * Covers the OAuth 2.1 path for remote MCP servers end to end against a fake
 * provider: discovery → dynamic registration → PKCE → loopback callback →
 * token exchange → an authenticated tools/list → refresh on 401 → logout.
 *
 * The "browser" is a plain fetch that follows the authorize redirect, which is
 * exactly what a real browser does with the loopback URI.
 */

let authFile: string;

before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-oauth-test-"));
  authFile = path.join(dir, "mcp-auth.json");
  // Never touch the developer's real ~/.kritya/mcp-auth.json.
  process.env.KRITYA_MCP_AUTH_FILE = authFile;
  // No browser windows during a test run; login falls back to printing the URL.
  process.env.KRITYA_NO_BROWSER = "1";
});

after(() => {
  shutdownMcp();
  delete process.env.KRITYA_MCP_AUTH_FILE;
  delete process.env.KRITYA_NO_BROWSER;
});

// ---------- pure helpers ----------

test("parseWwwAuthenticate pulls resource_metadata out of a challenge", () => {
  assert.equal(
    parseWwwAuthenticate(
      'Bearer error="invalid_token", resource_metadata="https://x.test/.well-known/oauth-protected-resource"'
    ),
    "https://x.test/.well-known/oauth-protected-resource"
  );
  assert.equal(parseWwwAuthenticate("Bearer"), undefined);
  assert.equal(parseWwwAuthenticate(null), undefined);
});

test("resourceMetadataUrls prefers the path-scoped well-known document", () => {
  assert.deepEqual(resourceMetadataUrls("https://api.test/mcp"), [
    "https://api.test/.well-known/oauth-protected-resource/mcp",
    "https://api.test/.well-known/oauth-protected-resource",
  ]);
});

test("authServerMetadataUrls covers RFC 8414 and OIDC layouts", () => {
  const urls = authServerMetadataUrls("https://as.test/tenant1");
  assert.ok(urls.includes("https://as.test/.well-known/oauth-authorization-server/tenant1"));
  assert.ok(urls.includes("https://as.test/tenant1/.well-known/openid-configuration"));
  assert.ok(urls.includes("https://as.test/.well-known/oauth-authorization-server"));
});

test("createPkce produces a verifier whose S256 hash is the challenge", () => {
  const { verifier, challenge } = createPkce();
  assert.equal(crypto.createHash("sha256").update(verifier).digest("base64url"), challenge);
  // RFC 7636 requires 43-128 chars; base64url of 32 bytes lands at 43.
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
});

test("buildAuthorizeUrl sends PKCE and the resource binding", () => {
  const url = new URL(
    buildAuthorizeUrl({
      meta: {
        issuer: "https://as.test",
        authorizationEndpoint: "https://as.test/authorize",
        tokenEndpoint: "https://as.test/token",
      },
      clientId: "cid",
      redirectUri: "http://127.0.0.1:1234/callback",
      challenge: "chal",
      state: "st",
      resource: "https://api.test/mcp",
      scope: "read write",
    })
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "chal");
  // RFC 8707 — without this a token minted here is replayable at another resource.
  assert.equal(url.searchParams.get("resource"), "https://api.test/mcp");
  assert.equal(url.searchParams.get("scope"), "read write");
});

test("extractCode accepts a bare code or a pasted redirect URL", () => {
  assert.equal(extractCode("  abc123 "), "abc123");
  assert.equal(extractCode("http://127.0.0.1:9/callback?code=xyz&state=s"), "xyz");
});

// ---------- token store ----------

test("authKey normalizes trailing slashes, query, and fragment to one record", () => {
  assert.equal(authKey("https://api.test/mcp/?x=1#f"), authKey("https://api.test/mcp"));
});

test("token store round-trips and enforces owner-only permissions", async () => {
  const auth: StoredAuth = {
    resource: "https://api.test/mcp",
    issuer: "https://as.test",
    tokenEndpoint: "https://as.test/token",
    clientId: "cid",
    accessToken: "at",
  };
  saveAuth("https://api.test/mcp", auth, authFile);
  assert.equal(loadAuth("https://api.test/mcp/", authFile)?.accessToken, "at");

  if (os.platform() !== "win32") {
    const stat = await fs.stat(authFile);
    // This file holds live third-party bearer tokens.
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test("isExpired treats a token inside the skew window as already expired", () => {
  const base: StoredAuth = {
    resource: "r",
    issuer: "i",
    tokenEndpoint: "t",
    clientId: "c",
    accessToken: "a",
  };
  assert.equal(isExpired({ ...base, expiresAt: Date.now() + 5 * 60_000 }), false);
  assert.equal(isExpired({ ...base, expiresAt: Date.now() + 30_000 }), true);
  // No expiry stated: valid until a 401 says otherwise.
  assert.equal(isExpired(base), false);
});

// ---------- loopback callback ----------

test("callback server returns the code and rejects a state mismatch", async () => {
  const good = await startCallbackServer("state-1");
  const waiting = good.waitForCode();
  await fetch(`${good.redirectUri}?code=the-code&state=state-1`);
  assert.equal(await waiting, "the-code");

  const bad = await startCallbackServer("state-2");
  // Attach the rejection handler before the callback arrives, not after: the
  // fetch below spans enough microtasks for node to call it unhandled.
  const rejecting = assert.rejects(bad.waitForCode(), /state mismatch/);
  await fetch(`${bad.redirectUri}?code=stolen&state=wrong`);
  await rejecting;
});

test("callback server binds loopback only", async () => {
  const server = await startCallbackServer("s");
  assert.match(server.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  server.close();
});

// ---------- a fake OAuth-protected MCP server ----------

interface FakeProvider {
  url: string;
  close(): void;
  /** Tokens the AS currently considers valid. */
  valid: Set<string>;
  issued: string[];
  revoked: string[];
  registrations: number;
  /** Force the next tools/list to 401, as an expired access token would. */
  expireTokens(): void;
}

async function startFakeProvider(opts: { expiresIn?: number } = {}): Promise<FakeProvider> {
  const valid = new Set<string>();
  const issued: string[] = [];
  const revoked: string[] = [];
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  let registrations = 0;
  let origin = "";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const readBody = async (): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    };

    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        return json(200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["mcp:read"],
        });

      case "/.well-known/oauth-authorization-server":
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
        });

      case "/register": {
        registrations++;
        const body = JSON.parse(await readBody());
        assert.equal(
          body.token_endpoint_auth_method,
          "none",
          "kritya must register as a public client"
        );
        assert.ok(String(body.redirect_uris[0]).startsWith("http://127.0.0.1:"));
        return json(201, { client_id: `client-${registrations}` });
      }

      case "/authorize": {
        // Stand in for the user clicking "Allow".
        const code = crypto.randomBytes(8).toString("hex");
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirectUri: url.searchParams.get("redirect_uri") ?? "",
        });
        const back = new URL(url.searchParams.get("redirect_uri") as string);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") as string);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }

      case "/token": {
        const form = new URLSearchParams(await readBody());
        if (form.get("grant_type") === "refresh_token") {
          if (!form.get("refresh_token")) return json(400, { error: "invalid_grant" });
        } else {
          const record = codes.get(form.get("code") ?? "");
          if (!record) return json(400, { error: "invalid_grant" });
          codes.delete(form.get("code") as string);
          const verifier = form.get("code_verifier") ?? "";
          const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
          if (computed !== record.challenge) return json(400, { error: "invalid_grant" });
        }
        const access = `at-${issued.length + 1}`;
        issued.push(access);
        valid.add(access);
        return json(200, {
          access_token: access,
          refresh_token: "rt-1",
          token_type: "Bearer",
          expires_in: opts.expiresIn ?? 3600,
          scope: "mcp:read",
        });
      }

      case "/revoke": {
        const form = new URLSearchParams(await readBody());
        revoked.push(form.get("token") as string);
        valid.clear();
        return json(200, {});
      }

      case "/mcp": {
        const auth = req.headers.authorization ?? "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token || !valid.has(token)) {
          return json(
            401,
            { error: "invalid_token" },
            {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            }
          );
        }
        const msg = JSON.parse(await readBody());
        if (msg.method === "initialize") {
          return json(200, {
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          });
        }
        if (msg.method === "tools/list") {
          return json(200, {
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [{ name: "echo", description: "echo it back" }] },
          });
        }
        res.writeHead(202).end();
        return;
      }

      default:
        res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/mcp`,
    close: () => server.close(),
    valid,
    issued,
    revoked,
    get registrations() {
      return registrations;
    },
    expireTokens: () => valid.clear(),
  };
}

test("an unauthenticated server is reported as needing login, not as a failure", async () => {
  const provider = await startFakeProvider();
  try {
    const tools = await loadMcpTools({ demo: { url: provider.url } });
    assert.equal(tools.length, 0);
    const status = mcpStatus().find((s) => s.name === "demo");
    assert.equal(status?.needsAuth, true);
    // Distinct from a crash: startup must stay quiet and point at the fix.
    assert.match(status?.error ?? "", /\/mcp login demo/);
    assert.match(status?.authMetadataUrl ?? "", /oauth-protected-resource/);
  } finally {
    shutdownMcp();
    provider.close();
  }
});

test("full login: discovery, registration, PKCE, loopback, then authenticated tools", async () => {
  const provider = await startFakeProvider();
  try {
    const login = await beginLogin({ serverName: "demo", serverUrl: provider.url });
    // Stand in for the browser: follow the authorize redirect to the loopback.
    await fetch(login.authorizeUrl, { redirect: "follow" });
    const auth = await login.completed;

    assert.equal(auth.scope, "mcp:read");
    assert.equal(provider.registrations, 1);
    assert.equal(loadAuth(provider.url, authFile)?.accessToken, auth.accessToken);

    const tools = await loadMcpTools({ demo: { url: provider.url } });
    assert.deepEqual(
      tools.map((t) => t.name),
      ["mcp_demo_echo"]
    );
    assert.equal(mcpStatus().find((s) => s.name === "demo")?.ok, true);
  } finally {
    shutdownMcp();
    provider.close();
  }
});

test("an expired access token is refreshed and the request retried, silently", async () => {
  const provider = await startFakeProvider();
  try {
    const login = await beginLogin({ serverName: "demo", serverUrl: provider.url });
    await fetch(login.authorizeUrl, { redirect: "follow" });
    await login.completed;
    assert.equal(provider.issued.length, 1);

    // The server now rejects everything it has issued, exactly as it would an
    // hour later. The connect must recover without another browser trip.
    provider.expireTokens();

    const tools = await loadMcpTools({ demo: { url: provider.url } });
    assert.deepEqual(
      tools.map((t) => t.name),
      ["mcp_demo_echo"]
    );
    assert.equal(provider.issued.length, 2, "should have refreshed exactly once");
    assert.equal(provider.registrations, 1, "refresh must not re-register the client");
  } finally {
    shutdownMcp();
    provider.close();
  }
});

test("logout revokes with the server and deletes locally", async () => {
  const provider = await startFakeProvider();
  try {
    const login = await beginLogin({ serverName: "demo", serverUrl: provider.url });
    await fetch(login.authorizeUrl, { redirect: "follow" });
    await login.completed;

    const result = await logout(provider.url);
    assert.equal(result.hadToken, true);
    assert.equal(result.revoked, true);
    assert.equal(provider.revoked.length, 1);
    assert.equal(loadAuth(provider.url, authFile), undefined);

    // Logging out of a server with no stored grant is a no-op, not an error.
    assert.deepEqual(await logout(provider.url), { revoked: false, hadToken: false });
  } finally {
    provider.close();
  }
});

test("logout reports honestly when the server offers no revocation endpoint", async () => {
  saveAuth(
    "https://no-revoke.test/mcp",
    {
      resource: "https://no-revoke.test/mcp",
      issuer: "https://no-revoke.test",
      tokenEndpoint: "https://no-revoke.test/token",
      clientId: "cid",
      accessToken: "at",
    },
    authFile
  );
  const result = await logout("https://no-revoke.test/mcp");
  assert.equal(result.hadToken, true);
  // Deleted locally, but the token is still live on their side — callers must
  // be able to tell the user which of the two actually happened.
  assert.equal(result.revoked, false);
  assert.equal(loadAuth("https://no-revoke.test/mcp", authFile), undefined);
});
