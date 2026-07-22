import crypto from "node:crypto";
import { VERSION } from "../version.js";
import { debugLog } from "../config/debug.js";
import { isExpired, loadAuth, saveAuth, type StoredAuth } from "./tokens.js";

/**
 * OAuth 2.1 for remote (Streamable HTTP) MCP servers.
 *
 * Every major hosted MCP server — Linear, Notion, Sentry, GitHub, Atlassian —
 * gates on OAuth rather than a static bearer token, so `headers` in config only
 * ever reached unauthenticated servers and ones handing out long-lived PATs.
 * The flow implemented here is the one the MCP spec pins down:
 *
 *   401 + WWW-Authenticate  → protected-resource metadata (RFC 9728)
 *                           → authorization-server metadata (RFC 8414)
 *                           → dynamic client registration (RFC 7591)
 *                           → authorization code + PKCE (RFC 7636) in a browser
 *                           → loopback redirect (RFC 8252) captures the code
 *                           → token exchange, scoped with `resource` (RFC 8707)
 *
 * Two deliberate choices:
 *
 *  - No client secret is required or expected. kritya is a public client on the
 *    user's own machine; there is nowhere to keep a secret that the user
 *    couldn't already read. PKCE is what makes the code exchange safe. A secret
 *    is stored only if an AS insists on issuing one.
 *  - Discovery degrades to spec defaults rather than failing. Real deployments
 *    are inconsistent about which .well-known documents they publish, and a
 *    missing metadata file is not a good enough reason to refuse to log in.
 */

const DISCOVERY_TIMEOUT_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;

/** Thrown when a server needs a login kritya doesn't have yet. Carries enough to start one. */
export class McpAuthRequiredError extends Error {
  constructor(
    readonly serverUrl: string,
    readonly resourceMetadataUrl?: string
  ) {
    super("authentication required (run /mcp login)");
    this.name = "McpAuthRequiredError";
  }
}

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
}

export interface ProtectedResourceMetadata {
  /** Canonical resource identifier to send as `resource` on token requests. */
  resource: string;
  authorizationServers: string[];
  scopesSupported?: string[];
}

function ua(): Record<string, string> {
  return { "user-agent": `kritya/${VERSION}`, accept: "application/json" };
}

async function getJson(url: string, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { headers: ua(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/**
 * Pull `resource_metadata="…"` out of a 401's WWW-Authenticate challenge.
 * Returns undefined when the header is missing or doesn't name one — common
 * enough that callers fall back to well-known probing rather than giving up.
 */
export function parseWwwAuthenticate(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match?.[1];
}

/** Candidate .well-known URLs for a resource, per RFC 9728's path-aware rules. */
export function resourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const origin = u.origin;
  const p = u.pathname.replace(/\/$/, "");
  const urls = [`${origin}/.well-known/oauth-protected-resource`];
  // Path-scoped variant first when the endpoint isn't at the root: a host can
  // serve several distinct MCP resources under one origin.
  if (p && p !== "") urls.unshift(`${origin}/.well-known/oauth-protected-resource${p}`);
  return urls;
}

export async function discoverProtectedResource(
  serverUrl: string,
  metadataUrl?: string
): Promise<ProtectedResourceMetadata> {
  const candidates = metadataUrl
    ? [metadataUrl, ...resourceMetadataUrls(serverUrl)]
    : resourceMetadataUrls(serverUrl);
  for (const url of candidates) {
    try {
      const doc = (await getJson(url)) as {
        resource?: string;
        authorization_servers?: string[];
        scopes_supported?: string[];
      };
      if (doc?.authorization_servers?.length) {
        return {
          resource: doc.resource ?? serverUrl,
          authorizationServers: doc.authorization_servers,
          scopesSupported: doc.scopes_supported,
        };
      }
    } catch (err) {
      debugLog(`mcp oauth protected-resource ${url}`, err);
    }
  }
  // No document: assume the resource server is also its own authorization
  // server, which is how most single-tenant MCP deployments are set up.
  return { resource: serverUrl, authorizationServers: [new URL(serverUrl).origin] };
}

/** Candidate .well-known URLs for an authorization server, RFC 8414 + OIDC. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const origin = u.origin;
  const p = u.pathname.replace(/\/$/, "");
  const urls: string[] = [];
  if (p) {
    urls.push(`${origin}/.well-known/oauth-authorization-server${p}`);
    urls.push(`${origin}/.well-known/openid-configuration${p}`);
    urls.push(`${origin}${p}/.well-known/openid-configuration`);
  }
  urls.push(`${origin}/.well-known/oauth-authorization-server`);
  urls.push(`${origin}/.well-known/openid-configuration`);
  return urls;
}

export async function discoverAuthServer(issuer: string): Promise<AuthServerMetadata> {
  for (const url of authServerMetadataUrls(issuer)) {
    try {
      const doc = (await getJson(url)) as {
        issuer?: string;
        authorization_endpoint?: string;
        token_endpoint?: string;
        registration_endpoint?: string;
        revocation_endpoint?: string;
        scopes_supported?: string[];
      };
      if (doc?.authorization_endpoint && doc?.token_endpoint) {
        return {
          issuer: doc.issuer ?? issuer,
          authorizationEndpoint: doc.authorization_endpoint,
          tokenEndpoint: doc.token_endpoint,
          registrationEndpoint: doc.registration_endpoint,
          revocationEndpoint: doc.revocation_endpoint,
          scopesSupported: doc.scopes_supported,
        };
      }
    } catch (err) {
      debugLog(`mcp oauth as-metadata ${url}`, err);
    }
  }
  // RFC 8414 default endpoint layout — enough for servers that publish nothing.
  const base = issuer.replace(/\/$/, "");
  return {
    issuer,
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    registrationEndpoint: `${base}/register`,
  };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
}

/**
 * Register kritya with the authorization server. Public client, no secret
 * requested: `token_endpoint_auth_method: "none"` plus PKCE is the OAuth 2.1
 * shape for a native app.
 */
export async function registerClient(
  meta: AuthServerMetadata,
  redirectUri: string,
  scope?: string
): Promise<ClientRegistration> {
  if (!meta.registrationEndpoint) {
    throw new Error(
      `authorization server ${meta.issuer} does not support dynamic client registration; ` +
        `register kritya manually and put the client_id in mcp-auth.json`
    );
  }
  const res = await fetch(meta.registrationEndpoint, {
    method: "POST",
    headers: { ...ua(), "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "kritya",
      client_uri: "https://github.com/GenAICloudDevOps/kritya",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `client registration failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`
    );
  }
  const doc = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!doc.client_id) throw new Error("client registration returned no client_id");
  return { clientId: doc.client_id, clientSecret: doc.client_secret };
}

export function buildAuthorizeUrl(opts: {
  meta: AuthServerMetadata;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  resource: string;
  scope?: string;
}): string {
  const url = new URL(opts.meta.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", opts.state);
  // RFC 8707: binds the issued token to this MCP server, so a token minted for
  // one resource can't be replayed against another on the same AS.
  url.searchParams.set("resource", opts.resource);
  if (opts.scope) url.searchParams.set("scope", opts.scope);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  tokenEndpoint: string,
  params: Record<string, string>,
  clientSecret?: string
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    ...ua(),
    "content-type": "application/x-www-form-urlencoded",
  };
  // Confidential-client fallback: only when the AS insisted on issuing a secret.
  if (clientSecret) {
    const basic = Buffer.from(`${params.client_id}:${clientSecret}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const doc = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || doc.error || !doc.access_token) {
    const detail = doc.error_description ?? doc.error ?? `HTTP ${res.status}`;
    throw new Error(`token request failed: ${detail}`);
  }
  return doc;
}

export async function exchangeCode(opts: {
  meta: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource: string;
}): Promise<StoredAuth> {
  const doc = await postToken(
    opts.meta.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: opts.verifier,
      resource: opts.resource,
    },
    opts.clientSecret
  );
  return {
    resource: opts.resource,
    issuer: opts.meta.issuer,
    tokenEndpoint: opts.meta.tokenEndpoint,
    revocationEndpoint: opts.meta.revocationEndpoint,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    redirectUri: opts.redirectUri,
    accessToken: doc.access_token as string,
    refreshToken: doc.refresh_token,
    expiresAt: doc.expires_in ? Date.now() + doc.expires_in * 1000 : undefined,
    scope: doc.scope,
  };
}

export async function refreshToken(auth: StoredAuth): Promise<StoredAuth> {
  if (!auth.refreshToken) throw new Error("no refresh token — a new login is required");
  const doc = await postToken(
    auth.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: auth.clientId,
      resource: auth.resource,
    },
    auth.clientSecret
  );
  return {
    ...auth,
    accessToken: doc.access_token as string,
    // An AS may rotate the refresh token; keep the old one when it doesn't.
    refreshToken: doc.refresh_token ?? auth.refreshToken,
    expiresAt: doc.expires_in ? Date.now() + doc.expires_in * 1000 : undefined,
    scope: doc.scope ?? auth.scope,
  };
}

/**
 * Ask the AS to invalidate a token (RFC 7009). Returns false when the server
 * doesn't advertise a revocation endpoint or rejects the call — the caller
 * still deletes locally, but must say which of the two happened rather than
 * claiming the token is dead when it is merely forgotten.
 */
export async function revokeToken(auth: StoredAuth): Promise<boolean> {
  if (!auth.revocationEndpoint) return false;
  const token = auth.refreshToken ?? auth.accessToken;
  const hint = auth.refreshToken ? "refresh_token" : "access_token";
  try {
    const res = await fetch(auth.revocationEndpoint, {
      method: "POST",
      headers: { ...ua(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: auth.clientId,
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    debugLog(`mcp oauth revoke ${auth.revocationEndpoint}`, err);
    return false;
  }
}

/**
 * The token side of one server's session, shared by every request on that
 * transport. Refreshes are serialized through a single in-flight promise:
 * kritya connects to all servers in parallel and a transport can have several
 * requests outstanding, so without this a batch of simultaneous 401s would
 * fire a burst of refreshes and — against an AS that rotates refresh tokens —
 * invalidate each other's grant.
 */
export class OAuthSession {
  private auth: StoredAuth | undefined;
  private refreshing: Promise<StoredAuth> | undefined;

  constructor(
    private serverUrl: string,
    auth?: StoredAuth
  ) {
    this.auth = auth ?? loadAuth(serverUrl);
  }

  get hasAuth(): boolean {
    return this.auth !== undefined;
  }

  /** Current access token, refreshing first if it is known to be expiring. */
  async accessToken(): Promise<string | undefined> {
    if (!this.auth) return undefined;
    if (isExpired(this.auth) && this.auth.refreshToken) {
      const next = await this.doRefresh(this.auth);
      return next?.accessToken;
    }
    return this.auth.accessToken;
  }

  /**
   * Called after a 401. Returns true when a refreshed token is now in place and
   * the request is worth retrying; false when the user must log in again.
   */
  async handleUnauthorized(): Promise<boolean> {
    if (!this.auth?.refreshToken) return false;
    const next = await this.doRefresh(this.auth);
    return next !== undefined;
  }

  private doRefresh(current: StoredAuth): Promise<StoredAuth | undefined> {
    const inFlight =
      this.refreshing ??
      (this.refreshing = refreshToken(current)
        .then((next) => {
          this.auth = next;
          saveAuth(this.serverUrl, next);
          return next;
        })
        .finally(() => {
          this.refreshing = undefined;
        }));
    return inFlight.catch((err) => {
      debugLog(`mcp oauth refresh ${this.serverUrl}`, err);
      return undefined;
    });
  }
}
