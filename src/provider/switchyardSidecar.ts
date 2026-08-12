import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { debugLog } from "../config/debug.js";

/** The curated NVIDIA models this integration routes across. */
export const SWITCHYARD_WEAK_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
export const SWITCHYARD_STRONG_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
/** Tried in order, direct against NVIDIA, if switchyard-server itself is unreachable or exhausts its own retries. */
export const SWITCHYARD_FALLBACK_MODELS = [
  "meta/muse-glimmer-30b",
  "thinkingmachines/inkling",
  "z-ai/glm-5.2",
];
/** The route id in the generated routes.toml — also the `model` field kritya sends. */
export const SWITCHYARD_ROUTE_ID = "switchyard";

/**
 * Difficulty cutoff for `mode = "capability"`: the classifier scores each
 * incoming request and anything above this goes to the strong tier. 0.5 is
 * NVIDIA's own default — lower sends more traffic to the strong model.
 *
 * The sibling mode, `"escalation"`, is deliberately not used: it answers on
 * the weak tier first and asks a judge whether that model is *stuck*, which
 * is a signal about a spinning agent loop, not about a hard question. A
 * difficult one-shot prompt that the weak model answers competently never
 * trips it, so per-question routing has to classify the request up front.
 */
const SWITCHYARD_BASE_THRESHOLD = 0.5;

const READY_TIMEOUT_MS = 10_000;

/** Exported for tests; the sidecar startup path is the only real caller. */
export function routesToml(nvidiaBaseUrl: string): string {
  return `schema_version = 1

[llm_clients.nvidia]
format = "openai_chat"
base_url = "${nvidiaBaseUrl}"
api_key_env = "NVIDIA_API_KEY"
max_retries = 2

[targets.weak]
id = "${SWITCHYARD_WEAK_MODEL}"
llm_client = "nvidia"

[targets.strong]
id = "${SWITCHYARD_STRONG_MODEL}"
llm_client = "nvidia"

[routes.${SWITCHYARD_ROUTE_ID}]
id = "${SWITCHYARD_ROUTE_ID}"
type = "llm_classifier"
mode = "capability"
classifier_target = "weak"
strong_target = "strong"
weak_target = "weak"
base_threshold = ${SWITCHYARD_BASE_THRESHOLD}
`;
}

/** Thrown when the switchyard-server binary can't be found or fails to come up. */
export class SwitchyardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchyardUnavailableError";
  }
}

interface SidecarHandle {
  baseUrl: string;
  proc: ChildProcess;
}

/** Module-level singleton: one sidecar per kritya process, reused across
 *  repeated `ensureSwitchyardSidecar` calls (e.g. /provider switching back
 *  and forth) rather than spawning a new server each time. */
let sidecar: Promise<SidecarHandle> | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ port, host: "127.0.0.1" }, () => {
        sock.end();
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(
            new SwitchyardUnavailableError(
              `switchyard-server did not start listening on port ${port} within ${timeoutMs}ms`
            )
          );
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

/**
 * The TCP port can accept connections before switchyard-server's HTTP layer
 * has finished wiring up routes internally — a socket that accepts and then
 * hangs up (or resets) looks identical to "still starting" from here, so
 * that's treated the same as connection-refused and retried. Any actual HTTP
 * response, even an error status, proves the server is dispatching requests
 * and is what a real chat request needs — this is deliberately not a chat
 * completion itself, so it costs no tokens and doesn't depend on a specific
 * route existing.
 */
function waitForHttpReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/v1/models", timeout: 2000 },
        (res) => {
          res.resume(); // drain so the socket can close
          resolve();
        }
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => {
        if (Date.now() >= deadline) {
          reject(
            new SwitchyardUnavailableError(
              `switchyard-server didn't respond to HTTP requests on port ${port} within ${timeoutMs}ms`
            )
          );
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

/**
 * Start (or reuse) the local switchyard-server sidecar for this kritya
 * process: writes a routes.toml scoped to the weak/strong tiers, launches
 * the binary on a free localhost port, and waits for it to accept
 * connections. Idempotent within a process.
 */
export async function ensureSwitchyardSidecar(
  nvidiaApiKey: string,
  nvidiaBaseUrl: string
): Promise<{ baseUrl: string }> {
  if (!sidecar) {
    sidecar = startSidecar(nvidiaApiKey, nvidiaBaseUrl).catch((err) => {
      sidecar = undefined; // let the next call retry instead of caching the failure forever
      throw err;
    });
  }
  const handle = await sidecar;
  return { baseUrl: handle.baseUrl };
}

async function startSidecar(nvidiaApiKey: string, nvidiaBaseUrl: string): Promise<SidecarHandle> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-switchyard-"));
  const configPath = path.join(dir, "routes.toml");
  fs.writeFileSync(configPath, routesToml(nvidiaBaseUrl));
  debugLog("switchyard-server", `config at ${configPath}, starting on 127.0.0.1:${port}`);

  const proc = spawn(
    "switchyard-server",
    ["--config", configPath, "--host", "127.0.0.1", "--port", String(port)],
    { env: { ...process.env, NVIDIA_API_KEY: nvidiaApiKey }, stdio: ["ignore", "pipe", "pipe"] }
  );
  proc.stdout?.on("data", (d: Buffer) => debugLog("switchyard-server stdout", d.toString()));
  proc.stderr?.on("data", (d: Buffer) => debugLog("switchyard-server stderr", d.toString()));

  const exited = new Promise<never>((_, reject) => {
    proc.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new SwitchyardUnavailableError(
            "switchyard-server not found on PATH. Install it with: cargo install --locked switchyard-server"
          )
        );
      } else {
        reject(err);
      }
    });
    proc.once("exit", (code) => {
      reject(
        new SwitchyardUnavailableError(
          `switchyard-server exited before it was ready (code ${code}). Run with KRITYA_DEBUG=1 to see its output.`
        )
      );
    });
  });
  exited.catch(() => {}); // observed via the race below; don't let the late rejection go unhandled

  const readyDeadline = Date.now() + READY_TIMEOUT_MS;
  await Promise.race([waitForPort(port, READY_TIMEOUT_MS), exited]);
  await Promise.race([waitForHttpReady(port, Math.max(readyDeadline - Date.now(), 1000)), exited]);
  debugLog("switchyard-server", `ready on 127.0.0.1:${port}`);

  const cleanup = () => {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  return { baseUrl: `http://127.0.0.1:${port}/v1`, proc };
}

/**
 * The single place every model-default chain (engine.ts, headless.ts,
 * index.tsx, and the /provider switch in useAgent.ts) should go through.
 * `SWITCHYARD_ROUTE_ID` is a routing directive, not a real model — it only
 * means anything when switchyard is the active provider. Without this guard,
 * it can end up carried over (via config.model, a --model flag left from a
 * previous run, or /provider switching away) to a provider that has no idea
 * what "switchyard" is and 404s on it. Candidates are tried in order; the
 * first one that isn't empty and isn't a stale route id wins.
 */
export function resolveEffectiveModel(
  providerName: string,
  candidates: (string | undefined)[],
  fallback: string
): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === SWITCHYARD_ROUTE_ID && providerName !== "switchyard") continue;
    return candidate;
  }
  return fallback;
}

/**
 * Warn when a persisted `config.model` will silently bypass switchyard's
 * routing this run — the scenario `/model` on switchyard now avoids going
 * forward (see useAgent.ts), but a config.json saved before that fix, or one
 * hand-edited, can still carry a raw model id. `explicitModel` (a --model
 * flag for this run) isn't flagged: that's a deliberate one-off, not a stale
 * leftover.
 */
export function staleSwitchyardModelWarning(
  providerName: string,
  configModel: string | undefined,
  explicitModel: string | undefined
): string | undefined {
  if (providerName !== "switchyard" || explicitModel) return undefined;
  if (!configModel || configModel === SWITCHYARD_ROUTE_ID) return undefined;
  return (
    `⚠ ~/.kritya/config.json has "model": "${configModel}" saved, which bypasses switchyard's ` +
    `routing and calls that model directly every turn. Run /model switchyard ` +
    `(or remove "model" from config.json) to restore routing.`
  );
}

/** Stop the sidecar, if one is running. Safe to call even if none was started. */
export function stopSwitchyardSidecar(): void {
  if (!sidecar) return;
  const started = sidecar;
  sidecar = undefined;
  started
    .then((h) => {
      try {
        h.proc.kill();
      } catch {
        // already gone
      }
    })
    .catch(() => {});
}
