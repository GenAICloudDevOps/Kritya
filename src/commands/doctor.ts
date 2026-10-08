import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  BUILTIN_PROVIDERS,
  CONFIG_DIR,
  CONFIG_FILE,
  legacyGlobalModel,
  loadConfig,
  loadDotEnv,
  privacyModeFor,
  resolveProvider,
} from "../config/config.js";
import type { CliConfig, McpServerConfig } from "../config/config.js";
import { DEFAULT_MODEL, contextWindowFor } from "../config/models.js";
import { retentionDaysFor } from "../config/retention.js";
import { assertJsonWithinLimits } from "../config/jsonSafety.js";
import { isGitRepo } from "../agent/worktree.js";
import { loadHooks } from "../hooks/hooks.js";
import { loadProjectMcpServers, missingVars } from "../mcp/servers.js";
import { scanSkillsDetailed, skillsDir, userSkillsDir } from "../agent/skills.js";
import {
  defaultSandboxMode,
  sandboxAvailable,
  sandboxUnavailableReason,
} from "../shell/sandbox.js";
import { SWITCHYARD_ROUTE_ID, resolveEffectiveModel } from "../provider/switchyardSidecar.js";
import { gatedContentHash, isTrusted } from "../trust/trust.js";
import { checkForUpdate, updateCheckDisabled } from "../update/check.js";
import { VERSION } from "../version.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { engines?: { node?: string } };

export const DOCTOR_USAGE = `kritya doctor — check that this installation is set up correctly

Usage:
  kritya doctor [dir]            diagnose the setup for [dir] (default: current directory)
  kritya doctor [dir] --json     machine-readable output
  kritya doctor [dir] --offline  skip the network probes (provider, update check)

Exits non-zero if any check failed. Warnings alone do not fail it — most are
"this works, but not the way you may expect" (an unavailable sandbox, an
untrusted workspace).

Checks: Node version against the package's engines, config file validity, the
active provider and whether its key resolves and the endpoint answers, workspace
trust and git state, MCP servers, sandbox availability, persistence/privacy
settings, discovered skills and hooks, and whether a newer release exists.`;

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  level: CheckLevel;
  label: string;
}

export interface Section {
  title: string;
  checks: Check[];
}

export interface DoctorOptions {
  /** Directory to diagnose. Defaults to the current working directory. */
  workspace?: string;
  /** Overrides ~/.kritya, so tests don't read or write the real one. */
  configDir?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Skip the provider and update network probes. */
  offline?: boolean;
  /**
   * The config to diagnose. Defaults to `loadConfig()`. Injectable so every
   * branch below can be exercised from a fixture — the alternative is a test
   * suite whose coverage depends on whatever happens to be in the developer's
   * own ~/.kritya/config.json, which is not a test at all.
   */
  config?: CliConfig;
}

const MARKS: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };

function ok(label: string): Check {
  return { level: "ok", label };
}
function warn(label: string): Check {
  return { level: "warn", label };
}
function fail(label: string): Check {
  return { level: "fail", label };
}

/** A path shortened to `~/…` when it lives under the home directory. */
function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function runtimeSection(): Section {
  const checks: Check[] = [];
  const required = pkg.engines?.node;
  const actual = process.versions.node;
  const [major = 0, minor = 0] = actual.split(".").map(Number);

  // engines.node is `>=22.19.0`. Parsed by hand because the only operators
  // this package ever uses are `>=` and a bare version.
  const minimum = required?.replace(/^>=\s*/, "");
  const [reqMajor = 0, reqMinor = 0] = (minimum ?? "").split(".").map(Number);
  const tooOld = Boolean(minimum) && (major < reqMajor || (major === reqMajor && minor < reqMinor));

  checks.push(
    tooOld
      ? fail(`node ${actual} — this package requires >=${minimum}`)
      : ok(`node ${actual}${minimum ? ` (requires >=${minimum})` : ""}`)
  );
  checks.push(ok(`${process.platform} ${process.arch}`));
  checks.push(ok(`kritya ${VERSION}`));
  return { title: "Runtime", checks };
}

async function updateSection(options: DoctorOptions): Promise<Section> {
  if (options.offline) {
    return { title: "Releases", checks: [warn("update check skipped (--offline)")] };
  }
  if (updateCheckDisabled()) {
    return {
      title: "Releases",
      checks: [warn(`update check disabled by ${"KRITYA_NO_UPDATE_CHECK"}`)],
    };
  }

  const status = await checkForUpdate({ fetchImpl: options.fetchImpl, force: true });
  const checks: Check[] = [];

  if (status.source === "unavailable") {
    checks.push(warn(`could not reach the npm registry — ${status.reason}`));
    return { title: "Releases", checks };
  }

  checks.push(ok(`installed ${status.current}`));
  if (status.outdated) {
    checks.push(
      warn(`newer version available: ${status.latest} — npm install -g kritya@${status.latest}`)
    );
  } else {
    checks.push(ok(`newest published: ${status.latest}`));
  }
  return { title: "Releases", checks };
}

function configSection(options: DoctorOptions): Section {
  const configDir = options.configDir ?? CONFIG_DIR;
  const configFile = options.configDir ? path.join(options.configDir, "config.json") : CONFIG_FILE;
  const checks: Check[] = [];

  if (!exists(configFile)) {
    checks.push(warn(`${tilde(configFile)} not found — built-in defaults are in use`));
  } else {
    try {
      const raw = fs.readFileSync(configFile, "utf8");
      // The same two guards loadConfig applies. Reported separately because
      // loadConfig swallows both and returns {} — which otherwise looks
      // identical to "no config at all", the classic "my config isn't taking
      // effect" report.
      assertJsonWithinLimits(raw, "config.json");
      JSON.parse(raw);
      checks.push(ok(`${tilde(configFile)} parsed`));
    } catch (err) {
      checks.push(
        fail(
          `${tilde(configFile)} is unusable: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
  }

  checks.push(
    exists(configDir)
      ? ok(`${tilde(configDir)} exists`)
      : warn(`${tilde(configDir)} not created yet`)
  );

  return { title: "Configuration", checks };
}

function providerSection(
  config: ReturnType<typeof loadConfig>,
  provider: ReturnType<typeof resolveProvider>
): Section {
  const checks: Check[] = [];

  checks.push(ok(`active provider: ${provider.name}`));
  checks.push(ok(`base URL: ${provider.baseUrl}`));

  if (provider.apiKey) {
    const source = provider.apiKeyEnv
      ? `${provider.apiKeyEnv} is set`
      : "a literal key is configured";
    checks.push(ok(`API key resolved (${source})`));
  } else if (provider.apiKeyEnv) {
    checks.push(
      fail(
        `no API key — ${provider.apiKeyEnv} is unset and no literal key is configured. ` +
          `Set it in the environment, in a .env file, or under providers.${provider.name}.apiKey ` +
          `in ${tilde(CONFIG_FILE)}`
      )
    );
  } else {
    checks.push(fail(`no API key resolved for provider "${provider.name}"`));
  }

  const model = resolveEffectiveModel(
    provider.name,
    [config.providers?.[provider.name]?.model, legacyGlobalModel(config, provider.name)],
    provider.name === "switchyard" ? SWITCHYARD_ROUTE_ID : DEFAULT_MODEL
  );
  checks.push(
    ok(`model: ${model} (context ${contextWindowFor(model, config).toLocaleString("en-US")})`)
  );

  // A pinned provider name with no matching entry is a silent misconfiguration:
  // resolveProvider falls back to NVIDIA's URL, so requests go somewhere the
  // user never intended. Built-ins count as known even with no config entry.
  const known = Boolean(BUILTIN_PROVIDERS[provider.name] ?? config.providers?.[provider.name]);
  if (!known) {
    checks.push(
      warn(
        `provider "${provider.name}" is not a built-in and has no config.providers entry — ` +
          `falling back to the default base URL`
      )
    );
  }

  return { title: "Provider", checks };
}

/**
 * Ask the provider's `/models` endpoint whether the key works. A 401/403 here
 * is the single most useful thing doctor can report — it is the difference
 * between "your setup is wrong" and "the model is having a bad day".
 *
 * Exported so each response class can be tested without a real provider.
 */
export async function probeProvider(
  provider: ReturnType<typeof resolveProvider>,
  fetchImpl: typeof fetch | undefined,
  timeoutMs = 5_000
): Promise<Check> {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const response = await (fetchImpl ?? fetch)(url, {
      headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return ok(`endpoint reachable — GET ${url} returned ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      return fail(
        `the endpoint rejected the API key — GET ${url} returned ${response.status}. ` +
          `Check that the key is valid, not expired, and belongs to this provider.`
      );
    }
    if (response.status === 404) {
      return warn(
        `endpoint reachable, but GET ${url} returned 404 — not every provider ` +
          `implements /models, so this is not necessarily a problem`
      );
    }
    return warn(`GET ${url} returned ${response.status}`);
  } catch (err) {
    return fail(
      `could not reach ${url} — ${err instanceof Error ? err.message : String(err)}. ` +
        `Check your network, proxy, and the provider's baseUrl.`
    );
  }
}

function workspaceSection(workspace: string, config: ReturnType<typeof loadConfig>): Section {
  const checks: Check[] = [];
  const krityaDir = path.join(workspace, ".kritya");

  checks.push(ok(tilde(workspace)));
  checks.push(
    isGitRepo(workspace)
      ? ok("git repository")
      : warn("not a git repository — /commit and isolated write subagents are unavailable")
  );

  // Trust gates the workspace's own settings.json allow rules, hooks, .env and
  // custom commands. Worth stating explicitly: an untrusted workspace looks
  // like "my hooks just don't run".
  const hash = gatedContentHash(workspace);
  if (!hash) {
    checks.push(ok("no trust-gated content present"));
  } else if (isTrusted(workspace, hash)) {
    checks.push(ok("workspace trust-gated content is trusted"));
  } else {
    checks.push(
      warn(
        "workspace is NOT trusted — .kritya/settings.json allow rules, hooks, .env and " +
          ".kritya/commands/*.md will be ignored until you accept the prompt"
      )
    );
  }

  for (const [rel, note] of [
    ["settings.json", "permission rules"],
    [".mcp.json", "project MCP servers"],
    [".env", "workspace environment"],
  ] as const) {
    const file = rel === ".mcp.json" ? path.join(workspace, rel) : path.join(krityaDir, rel);
    if (exists(file)) checks.push(ok(`${rel} present (${note})`));
  }

  const commandsDir = path.join(krityaDir, "commands");
  if (exists(commandsDir)) {
    const count = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md")).length;
    checks.push(ok(`${count} custom command(s) in .kritya/commands`));
  }

  // Surfaced here rather than only on use: a configured MCP server whose env
  // var is missing fails at load with a warning that is easy to miss.
  const servers: Record<string, McpServerConfig> = {
    ...loadProjectMcpServers(workspace),
    ...config.mcpServers,
  };
  const names = Object.keys(servers);
  if (names.length === 0) {
    checks.push(ok("no MCP servers configured"));
  } else {
    checks.push(ok(`${names.length} MCP server(s) configured: ${names.join(", ")}`));
    for (const name of names) {
      const missing = missingVars(servers[name]).filter((v) => process.env[v] === undefined);
      if (missing.length > 0) {
        checks.push(
          warn(`MCP server "${name}" references unset variable(s): ${missing.join(", ")}`)
        );
      }
    }
  }

  return { title: "Workspace", checks };
}

function safetySection(config: ReturnType<typeof loadConfig>): Section {
  const checks: Check[] = [];
  const mode = config.sandboxExec ?? defaultSandboxMode();
  const available = sandboxAvailable();

  if (mode === "off") {
    checks.push(warn('sandboxExec is "off" — shell commands run unconfined'));
  } else if (available) {
    checks.push(ok(`sandboxExec "${mode}" and a sandbox backend is available`));
  } else if (mode === "strict") {
    // "strict" fails closed — the command is refused rather than run
    // unprotected, so this is not a "falls back with a warning" situation.
    checks.push(
      warn(
        `sandboxExec is "strict" but ${sandboxUnavailableReason()} — commands that would be ` +
          `sandboxed are refused outright rather than run unprotected`
      )
    );
  } else {
    checks.push(
      warn(
        `sandboxExec is "${mode}" but ${sandboxUnavailableReason()} — sandboxed commands ` +
          `fall back to unsandboxed execution with a warning`
      )
    );
  }

  const privacy = privacyModeFor(config);
  checks.push(
    privacy
      ? warn("privacy mode is ON — transcripts, audit logs and telemetry are not written")
      : ok("privacy mode is off")
  );

  const audit = config.audit ?? "on";
  const otel = config.otel ?? "off";
  const retention = retentionDaysFor(config);
  checks.push(ok(`audit ${audit}, telemetry ${otel}`));
  checks.push(
    retention > 0
      ? ok(`retention ${retention} day(s)`)
      : warn(`retention disabled (${retention}) — transcripts and logs are kept forever`)
  );

  return { title: "Safety & persistence", checks };
}

function extensionsSection(workspace: string, config: ReturnType<typeof loadConfig>): Section {
  const checks: Check[] = [];
  const hash = gatedContentHash(workspace);
  const trusted = !hash || isTrusted(workspace, hash);

  const { loaded, skipped } = scanSkillsDetailed([skillsDir(workspace), userSkillsDir()]);
  checks.push(
    skipped.length === 0
      ? ok(`${loaded.length} skill(s) discovered`)
      : warn(
          `${loaded.length} skill(s) discovered, ${skipped.length} skipped — ` +
            skipped.map((s) => `${s.name} (${s.reason})`).join("; ")
        )
  );

  const hooks = loadHooks(workspace, trusted);
  // HooksConfig is keyed by event, each holding an array — sum across events
  // rather than looking for a `hooks` key that does not exist.
  const hookCount = Object.values(hooks).reduce(
    (total, list) => total + (Array.isArray(list) ? list.length : 0),
    0
  );
  checks.push(hookCount > 0 ? ok(`${hookCount} hook(s) configured`) : ok("no hooks configured"));

  checks.push(
    ok(`KRITYA.md ${exists(path.join(workspace, "KRITYA.md")) ? "present" : "not present"}`)
  );
  checks.push(ok(`config.mcpServers: ${Object.keys(config.mcpServers ?? {}).length}`));

  return { title: "Skills & hooks", checks };
}

/** Every diagnostic, in display order. Exported so it can be tested directly. */
export async function collectDiagnostics(options: DoctorOptions = {}): Promise<Section[]> {
  const workspace = path.resolve(options.workspace ?? ".");
  const config = options.config ?? loadConfig();

  const configSec = configSection(options);
  const sections: Section[] = [runtimeSection(), await updateSection(options), configSec];

  if (!exists(workspace) || !fs.statSync(workspace).isDirectory()) {
    sections.push({
      title: "Workspace",
      checks: [fail(`${workspace} is not a directory`)],
    });
    return sections;
  }

  const resolved = resolveProvider(config);
  const provider = providerSection(config, resolved);
  if (options.offline) {
    provider.checks.push(warn("provider endpoint not probed (--offline)"));
  } else if (resolved.name === "switchyard") {
    // Its baseUrl is a placeholder; the real client is a local sidecar that
    // only exists for the lifetime of a session, so there is nothing to probe.
    provider.checks.push(
      warn("endpoint not probed — switchyard runs a local sidecar, started on launch")
    );
  } else if (resolved.apiKey) {
    provider.checks.push(await probeProvider(resolved, options.fetchImpl));
  }
  sections.push(provider);

  sections.push(workspaceSection(workspace, config));
  sections.push(safetySection(config));
  sections.push(extensionsSection(workspace, config));

  return sections;
}

export interface DoctorReport {
  version: string;
  workspace: string;
  sections: Section[];
  failures: number;
  warnings: number;
}

export function summarize(sections: Section[], workspace: string): DoctorReport {
  const checks = sections.flatMap((s) => s.checks);
  return {
    version: VERSION,
    workspace,
    sections,
    failures: checks.filter((c) => c.level === "fail").length,
    warnings: checks.filter((c) => c.level === "warn").length,
  };
}

/** Exported for tests: the human-readable rendering, given the collected checks. */
export function renderReport(report: DoctorReport): string {
  const lines: string[] = [
    `kritya doctor — ${report.version}`,
    `workspace: ${tilde(report.workspace)}`,
    "",
  ];

  for (const section of report.sections) {
    lines.push(section.title);
    for (const check of section.checks) lines.push(`  ${MARKS[check.level]} ${check.label}`);
    lines.push("");
  }

  if (report.failures > 0) {
    lines.push(
      `${report.failures} problem(s) found${report.warnings ? `, ${report.warnings} warning(s)` : ""}.`
    );
  } else if (report.warnings > 0) {
    lines.push(`No problems found (${report.warnings} warning(s) — see ! above).`);
  } else {
    lines.push("No problems found.");
  }

  return lines.join("\n");
}

/** Handles `kritya doctor ...`. Resolves to the process exit code. */
export async function runDoctorCli(argv: string[], options: DoctorOptions = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(DOCTOR_USAGE);
    return 0;
  }

  const json = argv.includes("--json");
  const offline = argv.includes("--offline");
  const dirArg = argv.find((a) => !a.startsWith("-"));
  const workspace = path.resolve(options.workspace ?? dirArg ?? ".");

  // The user's own global .env is unconditionally trusted and is where the
  // interactive and headless paths both pick up provider keys (see
  // `runInteractive` in index.tsx and `runHeadless` in headless.ts). Without
  // loading it here the provider check below sees only the ambient
  // environment, so a key that lives solely in ~/.kritya/.env is reported as
  // missing — a false "no API key" that also flips the exit code to 1.
  loadDotEnv([path.join(CONFIG_DIR, ".env")]);

  const sections = await collectDiagnostics({ ...options, workspace, offline });
  const report = summarize(sections, workspace);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }

  return report.failures > 0 ? 1 : 0;
}
