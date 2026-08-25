import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import { debugLog } from "../config/debug.js";

/**
 * The loopback half of the OAuth flow (RFC 8252): kritya runs in a terminal and
 * must never see the user's password, so the browser does the login and hands
 * the authorization code back over a one-shot HTTP server on 127.0.0.1.
 *
 * The listener binds an OS-assigned port on the loopback interface only, is
 * created *before* dynamic client registration (the exact redirect_uri has to
 * be registered, so the port must already be known), and shuts down the moment
 * it has an answer. `state` is checked here rather than by the caller: a
 * mismatched callback is an attempted CSRF, not a user-visible error case.
 */

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CallbackServer {
  redirectUri: string;
  /** Resolves with the authorization code, or rejects on error/timeout/state mismatch. */
  waitForCode(): Promise<string>;
  close(): void;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, detail: string): string {
  // Deliberately dependency-free and inline-styled: this renders in the user's
  // browser, and a login callback should not fetch anything from the network.
  // `detail` in particular can carry query-string content from the OAuth
  // provider (e.g. error_description), so both fields must be HTML-escaped.
  const safeTitle = escapeHtml(title);
  const safeDetail = escapeHtml(detail);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:6rem auto;padding:0 1.5rem;line-height:1.6">
<h1 style="font-size:1.25rem;margin:0 0 .5rem">${safeTitle}</h1>
<p style="color:#555;margin:0">${safeDetail}</p>
</body></html>`;
}

export async function startCallbackServer(state: string): Promise<CallbackServer> {
  let settle: { resolve(code: string): void; reject(err: Error): void } | undefined;
  let outcome: { code?: string; error?: Error } | undefined;

  const finish = (result: { code?: string; error?: Error }) => {
    if (outcome) return;
    outcome = result;
    if (!settle) return;
    if (result.code) settle.resolve(result.code);
    else settle.reject(result.error ?? new Error("authorization failed"));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");

    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Login failed", description));
      finish({ error: new Error(`authorization denied: ${description}`) });
      return;
    }
    if (gotState !== state) {
      // Someone else's callback, or a forged one. Say nothing useful to it.
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Login failed", "State mismatch — this callback was ignored."));
      finish({ error: new Error("state mismatch on OAuth callback") });
      return;
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(page("Login failed", "No authorization code was returned."));
      finish({ error: new Error("no authorization code in callback") });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page("kritya is connected", "You can close this tab and return to your terminal."));
    finish({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only — never 0.0.0.0. Port 0 lets the OS pick a free one.
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error("could not bind a loopback port for the OAuth callback");
  }

  const close = () => {
    server.close();
    server.closeAllConnections?.();
  };

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    waitForCode() {
      return new Promise<string>((resolve, reject) => {
        settle = { resolve, reject };
        // A callback that already arrived (fast browser, slow caller) must not
        // be lost between listen() and waitForCode().
        if (outcome) {
          if (outcome.code) resolve(outcome.code);
          else reject(outcome.error ?? new Error("authorization failed"));
          return;
        }
        const timer = setTimeout(() => {
          finish({ error: new Error("timed out waiting for the browser callback (5 minutes)") });
        }, CALLBACK_TIMEOUT_MS);
        timer.unref?.();
      }).finally(close);
    },
    close,
  };
}

/**
 * Best-effort browser launch. Returns false when there is nothing to open —
 * over SSH, in a container, or on a headless box — so the caller can fall back
 * to printing the URL for the user to open somewhere else.
 */
export function openBrowser(url: string): boolean {
  if (process.env.KRITYA_NO_BROWSER) return false;
  // No DISPLAY/WAYLAND_DISPLAY on Linux means no browser to hand this to.
  if (
    os.platform() === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY &&
    !process.env.WSL_DISTRO_NAME
  ) {
    return false;
  }
  const [cmd, args] =
    os.platform() === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : os.platform() === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", (err) => debugLog(`openBrowser(${cmd})`, err));
    child.unref();
    return true;
  } catch (err) {
    debugLog(`openBrowser(${cmd})`, err);
    return false;
  }
}
