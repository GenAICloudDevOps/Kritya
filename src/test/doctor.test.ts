import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  collectDiagnostics,
  probeProvider,
  renderReport,
  summarize,
  type Section,
} from "../commands/doctor.js";

async function tempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const SECTIONS: Section[] = [
  {
    title: "Runtime",
    checks: [
      { level: "ok", label: "node 22.22.2" },
      { level: "warn", label: "something odd" },
    ],
  },
  { title: "Provider", checks: [{ level: "fail", label: "no API key" }] },
];

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test("summarize counts failures and warnings across every section", () => {
  const report = summarize(SECTIONS, "/tmp/ws");

  assert.equal(report.failures, 1);
  assert.equal(report.warnings, 1);
  assert.equal(report.sections.length, 2);
  assert.equal(report.workspace, "/tmp/ws");
});

test("summarize reports zero when everything passes", () => {
  const report = summarize([{ title: "X", checks: [{ level: "ok", label: "fine" }] }], "/tmp/ws");

  assert.equal(report.failures, 0);
  assert.equal(report.warnings, 0);
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

test("renderReport marks each level distinctly", () => {
  const output = renderReport(summarize(SECTIONS, "/tmp/ws"));

  assert.match(output, /✓ node 22\.22\.2/);
  assert.match(output, /! something odd/);
  assert.match(output, /✗ no API key/);
  assert.match(output, /^Runtime$/m);
  assert.match(output, /^Provider$/m);
});

test("renderReport says so plainly when there is nothing wrong", () => {
  const output = renderReport(
    summarize([{ title: "X", checks: [{ level: "ok", label: "fine" }] }], "/tmp/ws")
  );

  assert.match(output, /No problems found\.$/);
});

test("renderReport distinguishes warnings-only from failures", () => {
  const warningsOnly = renderReport(
    summarize([{ title: "X", checks: [{ level: "warn", label: "meh" }] }], "/tmp/ws")
  );
  assert.match(warningsOnly, /No problems found \(1 warning\(s\)/);

  const failures = renderReport(summarize(SECTIONS, "/tmp/ws"));
  assert.match(failures, /1 problem\(s\) found, 1 warning\(s\)\.$/);
});

test("renderReport shortens a path under the home directory", () => {
  const output = renderReport(summarize([], os.homedir()));

  assert.match(output, /workspace: ~/);
});

// ---------------------------------------------------------------------------
// collectDiagnostics
// ---------------------------------------------------------------------------

test("collectDiagnostics covers every expected section", async () => {
  const workspace = await tempDir("kritya-doctor-");

  const sections = await collectDiagnostics({ workspace, offline: true });
  const titles = sections.map((s) => s.title);

  assert.deepEqual(titles, [
    "Runtime",
    "Releases",
    "Configuration",
    "Provider",
    "Workspace",
    "Safety & persistence",
    "Skills & hooks",
  ]);
});

test("collectDiagnostics skips the network probes when offline", async () => {
  const workspace = await tempDir("kritya-doctor-");

  const sections = await collectDiagnostics({ workspace, offline: true });
  const provider = sections.find((s) => s.title === "Provider");

  assert.ok(provider);
  assert.ok(provider.checks.some((c) => /--offline/.test(c.label)));
  // The release check must not have gone to the registry either.
  const releases = sections.find((s) => s.title === "Releases");
  assert.ok(releases?.checks.some((c) => /--offline/.test(c.label)));
});

test("collectDiagnostics reports a workspace that does not exist", async () => {
  const missing = path.join(await tempDir("kritya-doctor-"), "nope");

  const sections = await collectDiagnostics({ workspace: missing, offline: true });
  const workspaceSection = sections.find((s) => s.title === "Workspace");

  assert.ok(workspaceSection);
  assert.equal(workspaceSection.checks.length, 1);
  assert.equal(workspaceSection.checks[0].level, "fail");
  assert.match(workspaceSection.checks[0].label, /is not a directory/);
});

test("collectDiagnostics flags an unusable config file instead of silently ignoring it", async () => {
  const configDir = await tempDir("kritya-doctor-cfg-");
  await fsp.writeFile(path.join(configDir, "config.json"), "{ this is not json");

  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    configDir,
    offline: true,
  });
  const config = sections.find((s) => s.title === "Configuration");

  assert.ok(config);
  const failed = config.checks.filter((c) => c.level === "fail");
  assert.equal(failed.length, 1);
  assert.match(failed[0].label, /is unusable/);
});

test("collectDiagnostics accepts a valid config file", async () => {
  const configDir = await tempDir("kritya-doctor-cfg-");
  await fsp.writeFile(path.join(configDir, "config.json"), '{"provider":"nvidia"}\n');

  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    configDir,
    offline: true,
  });
  const config = sections.find((s) => s.title === "Configuration");

  assert.ok(config);
  assert.equal(config.checks.filter((c) => c.level === "fail").length, 0);
  assert.ok(config.checks.some((c) => /parsed/.test(c.label)));
});

test("collectDiagnostics names the project MCP servers it found", async () => {
  const workspace = await tempDir("kritya-doctor-");
  await fsp.writeFile(
    path.join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      },
    })
  );

  const sections = await collectDiagnostics({ workspace, offline: true });
  const workspaceSection = sections.find((s) => s.title === "Workspace");

  assert.ok(workspaceSection);
  assert.ok(
    workspaceSection.checks.some((c) => /1 MCP server\(s\) configured: files/.test(c.label))
  );
});

test("collectDiagnostics warns about an MCP server with an unset variable", async () => {
  const workspace = await tempDir("kritya-doctor-");
  await fsp.writeFile(
    path.join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: {
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${DEFINITELY_UNSET_TOKEN}" },
        },
      },
    })
  );

  const sections = await collectDiagnostics({ workspace, offline: true });
  const workspaceSection = sections.find((s) => s.title === "Workspace");

  assert.ok(workspaceSection);
  const warning = workspaceSection.checks.find((c) => /DEFINITELY_UNSET_TOKEN/.test(c.label));
  assert.ok(warning, "expected a warning naming the unset variable");
  assert.equal(warning.level, "warn");
});

// ---------------------------------------------------------------------------
// probeProvider — one case per response class
// ---------------------------------------------------------------------------

const PROVIDER = { name: "testprov", baseUrl: "https://provider.test/v1", apiKey: "secret" };

/** A fetch stand-in returning a fixed status. */
const statusFetch = (status: number) =>
  (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as typeof fetch;

test("probeProvider reports a reachable endpoint", async () => {
  const check = await probeProvider(PROVIDER, statusFetch(200));

  assert.equal(check.level, "ok");
  assert.match(check.label, /endpoint reachable/);
  assert.match(check.label, /https:\/\/provider\.test\/v1\/models/);
});

test("probeProvider treats a rejected key as a failure, not a warning", async () => {
  for (const status of [401, 403]) {
    const check = await probeProvider(PROVIDER, statusFetch(status));

    assert.equal(check.level, "fail", `HTTP ${status} should be a failure`);
    assert.match(check.label, /rejected the API key/);
    assert.match(check.label, new RegExp(String(status)));
  }
});

test("probeProvider treats a 404 as a warning — not every provider has /models", async () => {
  const check = await probeProvider(PROVIDER, statusFetch(404));

  assert.equal(check.level, "warn");
  assert.match(check.label, /not every provider/);
});

test("probeProvider warns on any other unexpected status", async () => {
  const check = await probeProvider(PROVIDER, statusFetch(500));

  assert.equal(check.level, "warn");
  assert.match(check.label, /returned 500/);
});

test("probeProvider reports an unreachable endpoint without throwing", async () => {
  const failing = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const check = await probeProvider(PROVIDER, failing);

  assert.equal(check.level, "fail");
  assert.match(check.label, /could not reach/);
  assert.match(check.label, /ECONNREFUSED/);
});

test("probeProvider strips a trailing slash before appending /models", async () => {
  const check = await probeProvider(
    { ...PROVIDER, baseUrl: "https://provider.test/v1/" },
    statusFetch(200)
  );

  assert.match(check.label, /https:\/\/provider\.test\/v1\/models/);
});

// ---------------------------------------------------------------------------
// collectDiagnostics with an injected config
// ---------------------------------------------------------------------------

/** The section named `title`, or a failed assertion. */
function section(sections: Section[], title: string): Section {
  const found = sections.find((s) => s.title === title);
  assert.ok(found, `expected a "${title}" section`);
  return found;
}

const labels = (s: Section) => s.checks.map((c) => c.label).join("\n");

test("collectDiagnostics fails when the active provider has no key at all", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    offline: true,
    config: { provider: "nokey", providers: { nokey: { baseUrl: "https://nokey.test/v1" } } },
  });
  const provider = section(sections, "Provider");

  assert.ok(provider.checks.some((c) => c.level === "fail" && /no API key/.test(c.label)));
  // A provider that exists in config.providers is not "unknown".
  assert.ok(!/not a built-in/.test(labels(provider)));
});

test("collectDiagnostics warns when a pinned provider is unknown", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    offline: true,
    config: { provider: "ghost" },
  });
  const provider = section(sections, "Provider");

  assert.match(labels(provider), /not a built-in/);
  assert.match(labels(provider), /ghost/);
});

test("collectDiagnostics does not call a built-in provider unknown", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    offline: true,
    config: { provider: "openai" },
  });

  assert.ok(!/not a built-in/.test(labels(section(sections, "Provider"))));
});

test("collectDiagnostics probes the provider when a literal key is configured", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    config: {
      provider: "litkey",
      providers: { litkey: { baseUrl: "https://litkey.test/v1", apiKey: "k" } },
    },
    fetchImpl: statusFetch(200),
  });
  const provider = section(sections, "Provider");

  assert.match(labels(provider), /API key resolved \(a literal key is configured\)/);
  assert.match(labels(provider), /endpoint reachable/);
});

test("collectDiagnostics surfaces a rejected key end to end", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    config: {
      provider: "litkey",
      providers: { litkey: { baseUrl: "https://litkey.test/v1", apiKey: "bad" } },
    },
    fetchImpl: statusFetch(401),
  });

  assert.ok(
    section(sections, "Provider").checks.some((c) => c.level === "fail" && /rejected/.test(c.label))
  );
});

test("collectDiagnostics skips the probe for switchyard, which has no remote endpoint", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    config: { provider: "switchyard", providers: { switchyard: { apiKey: "k" } } },
    fetchImpl: statusFetch(200),
  });

  assert.match(labels(section(sections, "Provider")), /local sidecar/);
});

test("collectDiagnostics never probes when the provider has no key", async () => {
  const requested: string[] = [];
  const recording = (async (url: string) => {
    requested.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;

  await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    config: { provider: "nokey", providers: { nokey: { baseUrl: "https://nokey.test/v1" } } },
    fetchImpl: recording,
  });

  // The same fetch is shared with the update check, so assert on the URL
  // rather than on the call count.
  assert.ok(
    !requested.some((url) => url.includes("nokey.test")),
    `must not send an unauthenticated request to the provider, got: ${requested.join(", ")}`
  );
});

test("collectDiagnostics flags an explicitly disabled sandbox", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    offline: true,
    config: { sandboxExec: "off" },
  });

  assert.match(labels(section(sections, "Safety & persistence")), /run unconfined/);
});

test("collectDiagnostics reports privacy mode and disabled retention", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    offline: true,
    config: { privacyMode: true, retentionDays: 0, audit: "off", otel: "file" },
  });
  const safety = labels(section(sections, "Safety & persistence"));

  assert.match(safety, /privacy mode is ON/);
  assert.match(safety, /retention disabled/);
  assert.match(safety, /audit off, telemetry file/);
});

test("collectDiagnostics counts the global MCP servers from config", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    offline: true,
    config: { mcpServers: { one: { command: "a" }, two: { url: "https://two.test/mcp" } } },
  });

  assert.match(labels(section(sections, "Workspace")), /2 MCP server\(s\) configured: one, two/);
});

test("collectDiagnostics resolves the model from config and reports its context window", async () => {
  const sections = await collectDiagnostics({
    workspace: await tempDir("kritya-doctor-"),
    offline: true,
    config: { providers: { nvidia: { model: "z-ai/glm-5.3" } } },
  });

  assert.match(
    labels(section(sections, "Provider")),
    /model: z-ai\/glm-5\.3 \(context 1,048,576\)/
  );
});
