import { openBrowser, startCallbackServer, type CallbackServer } from "./callback.js";
import {
  buildAuthorizeUrl,
  createPkce,
  discoverAuthServer,
  discoverProtectedResource,
  exchangeCode,
  randomState,
  registerClient,
  revokeToken,
  type AuthServerMetadata,
} from "./oauth.js";
import { deleteAuth, loadAuth, saveAuth, type StoredAuth } from "./tokens.js";

/**
 * Drives one interactive login from start to finish, and its inverse.
 *
 * Two ways the authorization code can come back, raced against each other:
 *
 *  - the loopback listener, when a browser opened on this machine (the normal
 *    path — one click, nothing to copy);
 *  - a code the user pastes with `/mcp code`, for SSH and headless sessions
 *    where there is no browser to open and no reachable loopback port.
 *
 * Whichever arrives first wins and the other is torn down. Pending logins live
 * in a module-level map because the two halves arrive as separate slash
 * commands in the same session.
 */

export interface PendingLogin {
  serverName: string;
  serverUrl: string;
  authorizeUrl: string;
  redirectUri: string;
  /** True when a browser was actually launched; false means "open this yourself". */
  browserOpened: boolean;
  /** Resolves once a code arrives from either path, with the stored grant. */
  completed: Promise<StoredAuth>;
  /** Feed a code (or a full redirect URL containing one) from `/mcp code`. */
  submitCode(codeOrUrl: string): void;
  cancel(): void;
}

const pending = new Map<string, PendingLogin>();

export function pendingLogin(serverName: string): PendingLogin | undefined {
  return pending.get(serverName);
}

/** Pull the `code` out of a pasted redirect URL, or accept a bare code. */
export function extractCode(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (code) return code;
  } catch {
    // Not a URL — treat the whole thing as the code.
  }
  return trimmed;
}

export interface LoginOptions {
  serverName: string;
  serverUrl: string;
  /** From the 401 that triggered this, when we have one. */
  resourceMetadataUrl?: string;
}

export async function beginLogin(opts: LoginOptions): Promise<PendingLogin> {
  const existing = pending.get(opts.serverName);
  if (existing) existing.cancel();

  const resource = await discoverProtectedResource(opts.serverUrl, opts.resourceMetadataUrl);
  const issuer = resource.authorizationServers[0];
  const meta = await discoverAuthServer(issuer);

  const state = randomState();
  const pkce = createPkce();
  // The listener has to exist before registration: DCR pins the exact
  // redirect_uri, so the port can't be chosen afterwards.
  const callback: CallbackServer = await startCallbackServer(state);

  const scope = resource.scopesSupported?.join(" ") ?? meta.scopesSupported?.join(" ");
  const registration = await reuseOrRegister(opts.serverUrl, meta, callback.redirectUri, scope);

  const authorizeUrl = buildAuthorizeUrl({
    meta,
    clientId: registration.clientId,
    redirectUri: callback.redirectUri,
    challenge: pkce.challenge,
    state,
    resource: resource.resource,
    scope,
  });

  let submitManual: (code: string) => void = () => {};
  let cancelManual: (err: Error) => void = () => {};
  const manual = new Promise<string>((resolve, reject) => {
    submitManual = resolve;
    cancelManual = reject;
  });
  // Nothing may ever consume this branch (the loopback usually wins); without
  // this an unhandled rejection would surface when we cancel it.
  manual.catch(() => {});

  const browserOpened = openBrowser(authorizeUrl);

  const completed = Promise.race([callback.waitForCode(), manual]).then(async (code) => {
    callback.close();
    const auth = await exchangeCode({
      meta,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      code,
      verifier: pkce.verifier,
      redirectUri: callback.redirectUri,
      resource: resource.resource,
    });
    auth.serverName = opts.serverName;
    saveAuth(opts.serverUrl, auth);
    pending.delete(opts.serverName);
    return auth;
  });
  completed.catch(() => pending.delete(opts.serverName));

  const entry: PendingLogin = {
    serverName: opts.serverName,
    serverUrl: opts.serverUrl,
    authorizeUrl,
    redirectUri: callback.redirectUri,
    browserOpened,
    completed,
    submitCode: (codeOrUrl) => submitManual(extractCode(codeOrUrl)),
    cancel: () => {
      callback.close();
      cancelManual(new Error("login cancelled"));
      pending.delete(opts.serverName);
    },
  };
  pending.set(opts.serverName, entry);
  return entry;
}

/**
 * Reuse a client_id already registered with this authorization server when the
 * redirect URI still matches. Re-registering on every login would leave a trail
 * of dead client records on the provider's side, and some rate-limit it.
 */
async function reuseOrRegister(
  serverUrl: string,
  meta: AuthServerMetadata,
  redirectUri: string,
  scope?: string
): Promise<{ clientId: string; clientSecret?: string }> {
  const prior = loadAuth(serverUrl);
  // The loopback port changes every run, so a stored client_id is only reusable
  // if the AS registered a wildcard-ish URI or the port happened to repeat.
  // Registration is cheap and always correct, so only reuse on an exact match.
  if (prior?.clientId && prior.issuer === meta.issuer && prior.redirectUri === redirectUri) {
    return { clientId: prior.clientId, clientSecret: prior.clientSecret };
  }
  return registerClient(meta, redirectUri, scope);
}

export interface LogoutResult {
  /** True when the authorization server confirmed revocation. */
  revoked: boolean;
  /** True when there was a stored grant to remove at all. */
  hadToken: boolean;
}

/**
 * Log out of a server: try to revoke server-side, then always delete locally.
 * The two are reported separately on purpose — telling someone they are "logged
 * out" when the token is merely forgotten, and still live on the provider's
 * side, would be a lie they can't act on.
 */
export async function logout(serverUrl: string): Promise<LogoutResult> {
  const auth = loadAuth(serverUrl);
  if (!auth) return { revoked: false, hadToken: false };
  const revoked = await revokeToken(auth);
  deleteAuth(serverUrl);
  return { revoked, hadToken: true };
}
