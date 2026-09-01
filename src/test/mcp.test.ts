import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  connectServer,
  loadMcpTools,
  mcpPrompts,
  mcpResources,
  mcpStatus,
  mcpToolDef,
  PROTOCOL_VERSION,
  shutdownMcp,
  toolAllowed,
} from "../mcp/client.js";
import type { McpToolSpec } from "../mcp/client.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import {
  expandVars,
  expandServerConfig,
  loadProjectMcpServers,
  mergeMcpServers,
  missingVars,
} from "../mcp/servers.js";
import { planSpawn, resolveWindowsCommand } from "../mcp/spawnWin.js";
import { gatedContentHash, describeGatedContent } from "../trust/trust.js";
import { serverFingerprint, trustServer } from "../trust/mcpTrust.js";

after(() => shutdownMcp());

test("PROTOCOL_VERSION matches the 2026-07-28 MCP spec revision", () => {
  assert.equal(PROTOCOL_VERSION, "2026-07-28");
});

function makeConsentTestSpec(overrides: Partial<McpToolSpec> = {}): McpToolSpec {
  return {
    name: "search",
    description: "search",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    ...overrides,
  };
}

test("mcpToolDef respects readOnlyHint when consent is trust-hints (default)", () => {
  const conn = {} as Parameters<typeof mcpToolDef>[0];
  const def = mcpToolDef(conn, "srv", makeConsentTestSpec(), { consent: "trust-hints" });
  assert.equal(def.requiresPermission, false);
});

test("mcpToolDef forces requiresPermission when consent is always-confirm, even for a read-only tool", () => {
  const conn = {} as Parameters<typeof mcpToolDef>[0];
  const def = mcpToolDef(conn, "srv", makeConsentTestSpec(), { consent: "always-confirm" });
  assert.equal(def.requiresPermission, true);
});

test("mcpToolDef defaults to trust-hints when consent is omitted", () => {
  const conn = {} as Parameters<typeof mcpToolDef>[0];
  const def = mcpToolDef(
    conn,
    "srv",
    makeConsentTestSpec({ annotations: { readOnlyHint: false } })
  );
  assert.equal(def.requiresPermission, true);
});

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-mcp-test-"));
}

// ---------- ${VAR} expansion ----------

test("expandVars substitutes known vars and leaves unknown ones intact", () => {
  process.env.KRITYA_TEST_TOKEN = "sekret";
  assert.equal(expandVars("Bearer ${KRITYA_TEST_TOKEN}"), "Bearer sekret");
  assert.equal(expandVars("${KRITYA_TEST_UNSET_VAR}/x"), "${KRITYA_TEST_UNSET_VAR}/x");
});

test("expandServerConfig expands command, args, env, url, and headers", () => {
  process.env.KRITYA_TEST_TOKEN = "sekret";
  const out = expandServerConfig({
    command: "${KRITYA_TEST_TOKEN}-bin",
    args: ["--token=${KRITYA_TEST_TOKEN}"],
    env: { KEY: "${KRITYA_TEST_TOKEN}" },
    url: "https://x/${KRITYA_TEST_TOKEN}",
    headers: { authorization: "Bearer ${KRITYA_TEST_TOKEN}" },
  });
  assert.equal(out.command, "sekret-bin");
  assert.deepEqual(out.args, ["--token=sekret"]);
  assert.deepEqual(out.env, { KEY: "sekret" });
  assert.equal(out.url, "https://x/sekret");
  assert.deepEqual(out.headers, { authorization: "Bearer sekret" });
});

test("missingVars finds unexpanded ${VAR}s across every field", () => {
  process.env.KRITYA_TEST_TOKEN = "sekret";
  const cfg = expandServerConfig({
    url: "https://example.com/${KRITYA_TEST_TOKEN}",
    headers: { authorization: "Bearer ${KRITYA_TEST_UNSET_A}" },
    env: { EXTRA: "${KRITYA_TEST_UNSET_B}" },
  });
  assert.deepEqual(missingVars(cfg), ["KRITYA_TEST_UNSET_A", "KRITYA_TEST_UNSET_B"]);
  assert.deepEqual(missingVars(expandServerConfig({ command: "node" })), []);
});

test("a server with an unset ${VAR} fails by name instead of reaching the network", async () => {
  delete process.env.KRITYA_TEST_UNSET_A;
  const tools = await loadMcpTools({
    leaky: {
      url: "http://127.0.0.1:1/mcp",
      headers: { authorization: "Bearer ${KRITYA_TEST_UNSET_A}" },
    },
  });
  assert.equal(tools.length, 0);
  const status = mcpStatus().find((s) => s.name === "leaky");
  assert.equal(status?.ok, false);
  assert.match(status?.error ?? "", /missing env var KRITYA_TEST_UNSET_A/);
  // Specifically not misreported as an OAuth problem.
  assert.notEqual(status?.needsAuth, true);
});

// ---------- Windows command resolution ----------

test("planSpawn is a passthrough off Windows", () => {
  if (os.platform() === "win32") return;
  const plan = planSpawn("npx", ["-y", "pkg"]);
  assert.equal(plan.command, "npx");
  assert.deepEqual(plan.args, ["-y", "pkg"]);
  assert.equal(plan.windowsVerbatimArguments, undefined);
});

test("planSpawn routes Windows batch files through cmd.exe with escaped args", () => {
  if (os.platform() !== "win32") return;
  // npx ships with Node, so it is present wherever these tests run.
  const resolved = resolveWindowsCommand("npx");
  assert.ok(resolved, "npx should resolve via PATHEXT");
  assert.match(resolved, /\.(cmd|exe)$/i);

  const plan = planSpawn("npx", ["-y", "pkg & calc"]);
  if (/\.cmd$/i.test(resolved)) {
    assert.match(plan.command, /cmd\.exe$/i);
    assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(plan.windowsVerbatimArguments, true);
    // The injection attempt is caret-escaped, not handed to cmd.exe as syntax.
    assert.ok(plan.args[3].includes("^&"));
    assert.ok(!/[^^]&/.test(plan.args[3]));
  }
});

test("resolveWindowsCommand returns undefined for a command that does not exist", () => {
  if (os.platform() !== "win32") return;
  assert.equal(resolveWindowsCommand("kritya-definitely-not-a-real-command"), undefined);
});

// ---------- .mcp.json loading and merging ----------

test("loadProjectMcpServers reads valid entries and skips invalid ones", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(
    path.join(ws, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        good: { command: "node", args: ["server.js"] },
        remote: { url: "https://example.com/mcp" },
        bad: { neither: true },
      },
    })
  );
  const servers = loadProjectMcpServers(ws);
  assert.ok(servers);
  assert.deepEqual(Object.keys(servers).sort(), ["good", "remote"]);
});

test("loadProjectMcpServers tolerates missing or malformed files", async () => {
  const ws = await makeWorkspace();
  assert.equal(loadProjectMcpServers(ws), undefined);
  await fs.writeFile(path.join(ws, ".mcp.json"), "{ not json");
  assert.equal(loadProjectMcpServers(ws), undefined);
});

test("mergeMcpServers lets global config win on name clashes", () => {
  const merged = mergeMcpServers(
    { shared: { command: "global-bin" } },
    { shared: { command: "project-bin" }, extra: { url: "https://example.com/mcp" } }
  );
  assert.equal(merged.shared.command, "global-bin");
  assert.equal(merged.extra.url, "https://example.com/mcp");
});

// ---------- trust gating ----------

test(".mcp.json is part of the workspace trust gate", async () => {
  const ws = await makeWorkspace();
  assert.equal(gatedContentHash(ws), null);
  await fs.writeFile(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { x: { command: "evil" } } })
  );
  const hash = gatedContentHash(ws);
  assert.ok(hash, "an .mcp.json alone must require trust");
  assert.match(describeGatedContent(ws), /\.mcp\.json/);
  assert.match(describeGatedContent(ws), /evil/);

  // Editing the file (e.g. via git pull) invalidates the previous hash.
  await fs.writeFile(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { x: { command: "eviler" } } })
  );
  assert.notEqual(gatedContentHash(ws), hash);
});

// ---------- stdio end-to-end ----------

// A minimal MCP server as an inline node script: initialize, tools/list, and
// an "echo" tool. Newline-delimited JSON-RPC on stdio.
const STDIO_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  if (m.id === undefined) return; // notification
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize')
    reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} },
            serverInfo: { name: 'echo', version: '1.0.0' } });
  else if (m.method === 'tools/list')
    reply({ tools: [{ name: 'echo', description: 'echoes text back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
  else if (m.method === 'tools/call')
    reply({ content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] });
});
`;

test("stdio: loads tools from a real child-process server and calls them", async () => {
  const tools = await loadMcpTools({
    echoer: { command: process.execPath, args: ["-e", STDIO_SERVER] },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "mcp_echoer_echo");
  assert.equal(tools[0].external, true);
  assert.equal(tools[0].requiresPermission, true);

  const out = await tools[0].execute({ text: "hi" }, { workspace: "." });
  assert.equal(out, "echo:hi");

  const status = mcpStatus().find((s) => s.name === "echoer");
  assert.ok(status?.ok);
  assert.deepEqual(status?.tools, ["echo"]);
});

test("stdio: a server that fails to start is reported, not fatal", async () => {
  const tools = await loadMcpTools({
    broken: { command: process.execPath, args: ["-e", "process.exit(1)"] },
  });
  assert.equal(tools.length, 0);
  const status = mcpStatus().find((s) => s.name === "broken");
  assert.equal(status?.ok, false);
  assert.ok(status?.error);
});

test("stdio: a dying server reports its exit code and its stderr", async () => {
  const tools = await loadMcpTools({
    noisy: {
      command: process.execPath,
      args: ["-e", "console.error('auth error: bad token'); process.exit(3)"],
    },
  });
  assert.equal(tools.length, 0);
  const status = mcpStatus().find((s) => s.name === "noisy");
  assert.equal(status?.ok, false);
  assert.match(status?.error ?? "", /auth error: bad token/);
  assert.match(status?.error ?? "", /code 3/);
});

test("stdio: a server that floods stderr keeps working", async () => {
  // Well past the ~64KB pipe buffer: without a stderr reader the child blocks
  // in write() forever and this never completes.
  const flood = `process.stderr.write('x'.repeat(400000));\n${STDIO_SERVER}`;
  const tools = await loadMcpTools({
    chatty: { command: process.execPath, args: ["-e", flood] },
  });
  assert.equal(tools.length, 1);
  assert.equal(await tools[0].execute({ text: "hi" }, { workspace: "." }), "echo:hi");
});

test("stdio: a trusted server whose tool shape changed since approval is refused, not silently connected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-mcp-shape-test-"));
  const serverFile = path.join(dir, "server.cjs");
  const storeFile = path.join(dir, "mcp-trusted.json");
  await fs.writeFile(serverFile, STDIO_SERVER);

  const cfg = { command: process.execPath, args: [serverFile] };
  trustServer("shapeshifter", serverFingerprint(cfg), storeFile);

  // First connect against the approved config: nothing to compare against
  // yet, so the shape is recorded and the connection succeeds.
  const first = await connectServer("shapeshifter", cfg, {
    tracer: NOOP_TRACER,
    mcpTrustFile: storeFile,
  });
  assert.ok(first.status.ok);
  assert.equal(first.tools.length, 1);

  // The server binary is swapped for one with a different tool shape, while
  // the approved config (command/args) is untouched.
  await fs.writeFile(
    serverFile,
    STDIO_SERVER.replace("echoes text back", "echoes text back and exfiltrates it")
  );

  const second = await connectServer("shapeshifter", cfg, {
    tracer: NOOP_TRACER,
    mcpTrustFile: storeFile,
  });
  assert.equal(second.status.ok, false);
  assert.equal(second.status.shapeChanged, true);
  assert.equal(second.tools.length, 0);
});

test("a config with neither command nor url is rejected per-server", async () => {
  const tools = await loadMcpTools({ empty: {} });
  assert.equal(tools.length, 0);
  const status = mcpStatus().find((s) => s.name === "empty");
  assert.equal(status?.ok, false);
  assert.match(status?.error ?? "", /command.*url|url.*command/i);
});

// ---------- Streamable HTTP end-to-end ----------

interface SeenRequest {
  method: string;
  sessionId?: string;
  protocolVersion?: string;
  auth?: string;
}

function startHttpMcpServer(opts: { hangOnCall?: boolean } = {}): Promise<{
  url: string;
  seen: SeenRequest[];
  close(): void;
}> {
  const seen: SeenRequest[] = [];
  const hung: http.ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const m = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; arguments?: { text?: string } };
      };
      seen.push({
        method: m.method,
        sessionId: req.headers["mcp-session-id"] as string | undefined,
        protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
        auth: req.headers["authorization"] as string | undefined,
      });
      if (m.id === undefined) {
        res.writeHead(202).end(); // notification
        return;
      }
      const json = (result: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(200, { "content-type": "application/json", ...extra });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      };
      if (m.method === "initialize") {
        json(
          {
            protocolVersion: m.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "http-echo", version: "1.0.0" },
          },
          { "mcp-session-id": "sess-42" }
        );
      } else if (m.method === "tools/list") {
        json({
          tools: [
            {
              name: "shout",
              description: "uppercases text",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        });
      } else if (m.method === "tools/call") {
        if (opts.hangOnCall) {
          // Open the stream and never answer, so the client's cancellation
          // path is the only thing that can end the call.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": keep-alive comment\n\n");
          hung.push(res);
          return;
        }
        // Respond as an SSE stream to exercise the event-stream parsing path.
        res.writeHead(200, { "content-type": "text/event-stream" });
        const result = {
          content: [{ type: "text", text: (m.params?.arguments?.text ?? "").toUpperCase() }],
        };
        res.write(": keep-alive comment\n\n");
        res.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`
        );
        res.end();
      } else {
        // Unrecognized method (e.g. the modern-era `server/discover` probe):
        // answer with a JSON-RPC error immediately, matching how a real
        // legacy server would reject a method it doesn't implement, instead
        // of leaving the request hanging until probeHttpEra's timeout.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32601, message: "Method not found" },
          })
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        seen,
        close: () => {
          for (const res of hung) res.end();
          server.close();
        },
      });
    });
  });
}

test("http: initializes, tracks the session id, sends headers, and parses SSE responses", async () => {
  const srv = await startHttpMcpServer();
  process.env.KRITYA_TEST_TOKEN = "sekret";
  try {
    const tools = await loadMcpTools(
      mergeMcpServers(
        {
          remote: {
            url: srv.url,
            headers: { authorization: "Bearer ${KRITYA_TEST_TOKEN}" },
          },
        },
        undefined
      )
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "mcp_remote_shout");

    const out = await tools[0].execute({ text: "quiet" }, { workspace: "." });
    assert.equal(out, "QUIET");

    // Every request carried the expanded Authorization header.
    assert.ok(srv.seen.every((r) => r.auth === "Bearer sekret"));
    // The session id from initialize is echoed on all subsequent requests.
    const afterInit = srv.seen.filter(
      (r) => r.method !== "initialize" && r.method !== "server/discover"
    );
    assert.ok(afterInit.length >= 2);
    assert.ok(afterInit.every((r) => r.sessionId === "sess-42"));
    // The negotiated protocol version is sent after initialize.
    const call = srv.seen.find((r) => r.method === "tools/call");
    assert.ok(call?.protocolVersion);
  } finally {
    srv.close();
  }
});

test("http: cancelling a tool call rejects at once and tells the server", async () => {
  const srv = await startHttpMcpServer({ hangOnCall: true });
  try {
    const tools = await loadMcpTools({ hanger: { url: srv.url } });
    assert.equal(tools.length, 1);

    const ctrl = new AbortController();
    const started = Date.now();
    const call = tools[0].execute({ text: "x" }, { workspace: "." }, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(call, /cancelled/);
    // Not the 120s CALL_TIMEOUT_MS.
    assert.ok(Date.now() - started < 5_000);

    // The server is told to stop working, per the spec's notifications/cancelled.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(srv.seen.some((r) => r.method === "notifications/cancelled"));
  } finally {
    srv.close();
  }
});

test("http: an unreachable server is reported, not fatal", async () => {
  const tools = await loadMcpTools({
    down: { url: "http://127.0.0.1:1/mcp" },
  });
  assert.equal(tools.length, 0);
  const status = mcpStatus().find((s) => s.name === "down");
  assert.equal(status?.ok, false);
});

// ---------- stdio working directory ----------

/** A stdio server whose one tool reports the directory it was launched in. */
const CWD_SERVER = STDIO_SERVER.replace("'echo:' + m.params.arguments.text", "process.cwd()");

test("stdio: a server runs in the workspace, not in kritya's launch directory", async () => {
  const workspace = await fs.realpath(await makeWorkspace());
  const tools = await loadMcpTools(
    { where: { command: process.execPath, args: ["-e", CWD_SERVER] } },
    { tracer: NOOP_TRACER, workspace }
  );
  assert.equal(tools.length, 1);
  const reported = await tools[0].execute({ text: "" }, { workspace });
  assert.equal(reported, workspace);
  assert.notEqual(reported, process.cwd());
});

test("stdio: an explicit cwd resolves against the workspace, keeping .mcp.json portable", async () => {
  const workspace = await fs.realpath(await makeWorkspace());
  await fs.mkdir(path.join(workspace, "docs"));
  const tools = await loadMcpTools(
    { where: { command: process.execPath, args: ["-e", CWD_SERVER], cwd: "./docs" } },
    { tracer: NOOP_TRACER, workspace }
  );
  assert.equal(await tools[0].execute({}, { workspace }), path.join(workspace, "docs"));
});

// ---------- transport security ----------

test("a remote server on plain http:// is refused before any request is sent", async () => {
  const tools = await loadMcpTools({ leaky: { url: "http://mcp.example.com/mcp" } });
  assert.equal(tools.length, 0);
  const status = mcpStatus().find((s) => s.name === "leaky");
  assert.equal(status?.ok, false);
  assert.match(status?.error ?? "", /plain http/i);
  // Not reported as a login problem — that would send the user to /mcp login.
  assert.notEqual(status?.needsAuth, true);
});

test("loopback stays exempt from the https requirement", async () => {
  const srv = await startHttpMcpServer();
  try {
    const tools = await loadMcpTools({ local: { url: srv.url } });
    assert.equal(tools.length, 1);
  } finally {
    srv.close();
  }
});

/** An endpoint that answers every POST with a redirect to `target`. */
function startRedirector(target: string): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: target }).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/mcp`, close: () => server.close() });
    });
  });
}

test("a cross-origin redirect is refused rather than forwarding credentials", async () => {
  const real = await startHttpMcpServer();
  // Same host, different port — a different origin, and the cheapest stand-in
  // for the attacker-controlled destination this check exists to stop.
  const redirector = await startRedirector(real.url);
  try {
    const tools = await loadMcpTools({
      hijack: { url: redirector.url, headers: { authorization: "Bearer sekret" } },
    });
    assert.equal(tools.length, 0);
    const status = mcpStatus().find((s) => s.name === "hijack");
    assert.match(status?.error ?? "", /different origin/i);
    // The decisive part: the token never reached the redirect target.
    assert.equal(real.seen.length, 0);
  } finally {
    redirector.close();
    real.close();
  }
});

// ---------- tool naming ----------

/** A stdio server exposing exactly the given tool specs. */
function stdioServerWith(specs: unknown[]): string {
  return STDIO_SERVER.replace(
    /reply\(\{ tools: \[[\s\S]*?\] \}\);/,
    `reply({ tools: ${JSON.stringify(specs)} });`
  );
}

test("tools whose sanitized names would collide get distinct names", async () => {
  const server = stdioServerWith([{ name: "my.tool" }, { name: "my-tool" }]);
  const tools = await loadMcpTools({
    dup: { command: process.execPath, args: ["-e", server] },
  });
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].name, tools[1].name, "one tool would otherwise shadow the other");
  // The first claimant keeps the readable name; the other is disambiguated.
  assert.equal(tools[0].name, "mcp_dup_my_tool");
});

test("an over-long server+tool pair is shortened to fit the provider's 64-char limit", async () => {
  const longTool = "b".repeat(60);
  const server = stdioServerWith([{ name: longTool }, { name: "short" }]);
  const tools = await loadMcpTools({
    ["a".repeat(40)]: { command: process.execPath, args: ["-e", server] },
  });
  assert.equal(tools.length, 2);
  for (const t of tools) {
    assert.ok(t.name.length <= 64, `"${t.name}" is ${t.name.length} chars`);
  }
  assert.notEqual(tools[0].name, tools[1].name);
});

// ---------- annotations ----------

test("readOnlyHint drops the permission prompt; destructiveHint overrides it", async () => {
  const server = stdioServerWith([
    { name: "lookup", annotations: { readOnlyHint: true } },
    { name: "wipe", annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "plain" },
  ]);
  const tools = await loadMcpTools({
    ann: { command: process.execPath, args: ["-e", server] },
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName["mcp_ann_lookup"].requiresPermission, false);
  assert.equal(byName["mcp_ann_wipe"].requiresPermission, true);
  assert.equal(byName["mcp_ann_plain"].requiresPermission, true);
  // Read-only or not, MCP output is still untrusted external content.
  assert.equal(byName["mcp_ann_lookup"].external, true);
});

// ---------- per-server tool allow/deny ----------

test("toolAllowed: deny wins, wildcards match, absent allow means everything", () => {
  assert.equal(toolAllowed("search", undefined), true);
  assert.equal(toolAllowed("search", {}), true);
  // allow narrows
  assert.equal(toolAllowed("search", { allow: ["search"] }), true);
  assert.equal(toolAllowed("delete", { allow: ["search"] }), false);
  // deny overrides an allow that would otherwise match
  assert.equal(toolAllowed("delete_repo", { allow: ["*"], deny: ["delete_*"] }), false);
  assert.equal(toolAllowed("list_repo", { allow: ["*"], deny: ["delete_*"] }), true);
  // an empty allow list is "unset", not "nothing"
  assert.equal(toolAllowed("search", { allow: [] }), true);
  // patterns are literal apart from *, so regex characters don't match wildly
  assert.equal(toolAllowed("axb", { allow: ["a.b"] }), false);
  assert.equal(toolAllowed("a.b", { allow: ["a.b"] }), true);
});

test("a server's denied tools never reach the model, and /mcp says how many", async () => {
  const server = stdioServerWith([{ name: "search" }, { name: "delete_all" }, { name: "list" }]);
  const tools = await loadMcpTools({
    gh: {
      command: process.execPath,
      args: ["-e", server],
      tools: { deny: ["delete_*"] },
    },
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ["mcp_gh_search", "mcp_gh_list"]
  );
  const status = mcpStatus().find((s) => s.name === "gh");
  assert.deepEqual(status?.tools, ["search", "list"]);
  assert.equal(status?.hiddenTools, 1);
});

test("an allow list keeps only what it names", async () => {
  const server = stdioServerWith([{ name: "search" }, { name: "write" }]);
  const tools = await loadMcpTools({
    narrow: {
      command: process.execPath,
      args: ["-e", server],
      tools: { allow: ["search"] },
    },
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "mcp_narrow_search");
  assert.equal(mcpStatus().find((s) => s.name === "narrow")?.hiddenTools, 1);
});

test("expandServerConfig carries the tool filter through", () => {
  const out = expandServerConfig({
    command: "node",
    tools: { allow: ["a"], deny: ["b"] },
  });
  assert.deepEqual(out.tools, { allow: ["a"], deny: ["b"] });
});

// ---------- non-text tool results ----------

/** A stdio server that answers tools/call with a fixed result object. */
function stdioServerReturning(result: unknown): string {
  return STDIO_SERVER.replace(
    "reply({ content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] })",
    `reply(${JSON.stringify(result)})`
  );
}

async function callOnce(result: unknown, name = "res"): Promise<string> {
  const tools = await loadMcpTools({
    [name]: { command: process.execPath, args: ["-e", stdioServerReturning(result)] },
  });
  return tools[0].execute({ text: "x" }, { workspace: "." });
}

test("structuredContent is used when there are no text blocks", async () => {
  const out = await callOnce({ content: [], structuredContent: { count: 3, ok: true } });
  assert.equal(out, JSON.stringify({ count: 3, ok: true }));
});

test("a text block wins over structuredContent, so the payload isn't sent twice", async () => {
  const out = await callOnce({
    content: [{ type: "text", text: "the answer" }],
    structuredContent: { answer: 42 },
  });
  assert.equal(out, "the answer");
});

test("an embedded resource's text is inlined rather than discarded", async () => {
  const out = await callOnce({
    content: [
      { type: "resource", resource: { uri: "file:///notes.md", text: "# Notes" } },
      { type: "resource_link", uri: "file:///other.md", name: "other" },
    ],
  });
  assert.match(out, /# Notes/);
  assert.match(out, /file:\/\/\/notes\.md/);
  // A link is a pointer, not a payload — it should still name the target.
  assert.match(out, /file:\/\/\/other\.md/);
  assert.match(out, /other/);
});

test("binary content becomes a labelled placeholder, not a bare [image content]", async () => {
  const out = await callOnce({
    content: [{ type: "image", mimeType: "image/png", data: "AAAAAAAAAAAA" }],
  });
  assert.match(out, /image\/png/);
  assert.match(out, /bytes/);
  assert.notEqual(out, "[image content]");
});

// ---------- roots/list ----------

// A server that asks the client for its roots right after initialize, then
// reports whatever came back as the text of its one tool.
const ROOTS_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "let roots = 'none';",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'initialize')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
  "      capabilities: { tools: {} }, serverInfo: { name: 'roots', version: '1' } } });",
  "  if (m.method === 'notifications/initialized')",
  "    return send({ jsonrpc: '2.0', id: 9001, method: 'ROOTS_METHOD' });",
  "  if (m.id === 9001) { roots = JSON.stringify(m.result !== undefined ? m.result : { error: m.error }); return; }",
  "  if (m.method === 'tools/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'where' }] } });",
  "  if (m.method === 'tools/call')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: roots }] } });",
  "});",
].join("\n");

test("a server asking roots/list is told the workspace", async () => {
  const workspace = await fs.realpath(await makeWorkspace());
  const tools = await loadMcpTools(
    {
      rooted: {
        command: process.execPath,
        args: ["-e", ROOTS_SERVER.replace("ROOTS_METHOD", "roots/list")],
      },
    },
    { tracer: NOOP_TRACER, workspace }
  );
  assert.equal(tools.length, 1);
  const answer = await tools[0].execute({}, { workspace });
  assert.match(answer, /"roots"/);
  assert.match(answer, /file:/);
  // The root must be the workspace, not kritya's own directory.
  assert.match(answer, new RegExp(path.basename(workspace)));
});

test("an unsupported server request gets an error reply, not silence", async () => {
  const tools = await loadMcpTools({
    unsupported: {
      command: process.execPath,
      args: ["-e", ROOTS_SERVER.replace("ROOTS_METHOD", "sampling/createMessage")],
    },
  });
  // A reply arrived, and it was a proper JSON-RPC error rather than silence
  // or a bogus success.
  const answer = await tools[0].execute({}, { workspace: "." });
  assert.match(answer, /-32601/);
  assert.match(answer, /not supported/);
});

// ---------- sampling/createMessage ----------

// A server that records whether it saw the sampling capability on
// initialize, then asks the client to sample a completion right after
// notifications/initialized, and reports both as the text of its one tool
// — same shape as ROOTS_SERVER above.
const SAMPLING_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "let outcome = 'none';",
  "let sawSampling = false;",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'initialize') {",
  "    sawSampling = Boolean(m.params.capabilities && m.params.capabilities.sampling);",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
  "      capabilities: { tools: {} }, serverInfo: { name: 'sampling', version: '1' } } });",
  "  }",
  "  if (m.method === 'notifications/initialized')",
  "    return send({ jsonrpc: '2.0', id: 9002, method: 'sampling/createMessage',",
  "      params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] } });",
  "  if (m.id === 9002) { outcome = JSON.stringify(m.result !== undefined ? { result: m.result } : { error: m.error }); return; }",
  "  if (m.method === 'tools/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'check' }] } });",
  "  if (m.method === 'tools/call')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ sawSampling, outcome }) }] } });",
  "});",
].join("\n");

test("initialize declares the sampling capability, and the client forwards sampling/createMessage to onSampling with its result", async () => {
  const calls: { server: string; req: unknown }[] = [];
  const tools = await loadMcpTools(
    { sampler: { command: process.execPath, args: ["-e", SAMPLING_SERVER] } },
    {
      tracer: NOOP_TRACER,
      onSampling: async (server, req) => {
        calls.push({ server, req });
        return {
          ok: true,
          role: "assistant" as const,
          content: "the answer",
          model: "test-model",
          stopReason: "stop",
        };
      },
    }
  );
  const answer = await tools[0].execute({}, { workspace: "." });
  const { sawSampling, outcome } = JSON.parse(answer);
  assert.equal(sawSampling, true);
  assert.deepEqual(JSON.parse(outcome).result, {
    role: "assistant",
    content: { type: "text", text: "the answer" },
    model: "test-model",
    stopReason: "stop",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0].req as { messages: unknown[] }).messages, [
    { role: "user", content: "hi" },
  ]);
});

test("replies with a JSON-RPC error when onSampling declines", async () => {
  const tools = await loadMcpTools(
    { sampler2: { command: process.execPath, args: ["-e", SAMPLING_SERVER] } },
    {
      tracer: NOOP_TRACER,
      onSampling: async () => ({ ok: false as const, reason: "user declined" }),
    }
  );
  const answer = await tools[0].execute({}, { workspace: "." });
  const { outcome } = JSON.parse(answer);
  assert.equal(JSON.parse(outcome).error.message, "user declined");
});

// ---------- elicitation/create ----------

// A server that, right after initialize, asks the client to elicit a
// boolean field from the user, and reports whatever came back as the text
// of its one tool.
const ELICITATION_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "let outcome = 'none';",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'initialize')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
  "      capabilities: { tools: {} }, serverInfo: { name: 'elicit', version: '1' } } });",
  "  if (m.method === 'notifications/initialized')",
  "    return send({ jsonrpc: '2.0', id: 9003, method: 'elicitation/create',",
  "      params: { message: 'Proceed with deletion?', requestedSchema: { type: 'object',",
  "        properties: { proceed: { type: 'boolean', title: 'Proceed' } } } } });",
  "  if (m.id === 9003) { outcome = JSON.stringify(m.result !== undefined ? { result: m.result } : { error: m.error }); return; }",
  "  if (m.method === 'tools/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'check' }] } });",
  "  if (m.method === 'tools/call')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: outcome }] } });",
  "});",
].join("\n");

// Same shape, but the schema has a nested/unsupported field.
const ELICITATION_SERVER_NESTED = ELICITATION_SERVER.replace(
  "properties: { proceed: { type: 'boolean', title: 'Proceed' } } } } });",
  "properties: { nested: { type: 'object', properties: {} } } } } });"
);

test("declares the elicitation capability and translates a flat schema into ElicitationFields", async () => {
  const calls: { server: string; message: string; fields: unknown }[] = [];
  const tools = await loadMcpTools(
    { elicit: { command: process.execPath, args: ["-e", ELICITATION_SERVER] } },
    {
      tracer: NOOP_TRACER,
      onElicitation: async (server, message, fields) => {
        calls.push({ server, message, fields });
        return { action: "accept" as const, content: { proceed: true } };
      },
    }
  );
  const answer = await tools[0].execute({}, { workspace: "." });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, "Proceed with deletion?");
  assert.deepEqual(calls[0].fields, [{ name: "proceed", kind: "boolean", label: "Proceed" }]);
  assert.deepEqual(JSON.parse(answer).result, { action: "accept", content: { proceed: true } });
});

test("rejects a nested/unsupported schema with a JSON-RPC error naming the field", async () => {
  const onElicitation = async () => {
    throw new Error("onElicitation must not be called for an unsupported schema");
  };
  const tools = await loadMcpTools(
    { elicitNested: { command: process.execPath, args: ["-e", ELICITATION_SERVER_NESTED] } },
    { tracer: NOOP_TRACER, onElicitation }
  );
  const answer = await tools[0].execute({}, { workspace: "." });
  const { error } = JSON.parse(answer);
  assert.match(error.message, /nested/);
});

// ---------- Tasks extension (io.modelcontextprotocol/tasks) ----------

// A server whose one tool immediately returns a task, then completes it
// after N `tasks/get` polls. TASK_POLLS_TO_COMPLETE controls how many
// "working" replies precede the "completed" one.
function tasksServerScript(pollsBeforeDone: number): string {
  return [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "let polls = 0;",
    `const pollsBeforeDone = ${pollsBeforeDone};`,
    "let sawTasksMeta = false;",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'tasker', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call') {",
    "    sawTasksMeta = Boolean(m.params._meta && m.params._meta['io.modelcontextprotocol/clientCapabilities']",
    "      && m.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions",
    "      && m.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions['io.modelcontextprotocol/tasks']);",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1',",
    "      status: 'working', statusMessage: 'started', createdAt: 'now', lastUpdatedAt: 'now',",
    "      ttlMs: null, pollIntervalMs: 5 } });",
    "  }",
    "  if (m.method === 'tasks/get') {",
    "    polls++;",
    "    if (polls < pollsBeforeDone)",
    "      return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'working',",
    "        statusMessage: 'poll ' + polls, createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'completed',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      result: { content: [{ type: 'text', text: 'sawTasksMeta:' + sawTasksMeta }] } } });",
    "  }",
    "});",
  ].join("\n");
}

test("a task that completes on the first poll returns the same result a sync call would", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(1)], tasks: true },
  });
  const out = await tools[0].execute({}, { workspace: "." });
  assert.equal(out, "sawTasksMeta:true");
});

test("a task needing multiple poll rounds still completes", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(4)], tasks: true },
  });
  const out = await tools[0].execute({}, { workspace: "." });
  assert.equal(out, "sawTasksMeta:true");
});

test("without tasks: true configured, a server returning a task is refused rather than polled", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(1)] },
  });
  // Without tasks:true, kritya never declares support (sawTasksMeta would be
  // false), and per spec the server shouldn't return a task at all — but this
  // fake server returns one regardless, to exercise the opt-in gate: kritya
  // must refuse to poll it rather than silently treating it as a normal
  // (empty) tool result.
  await assert.rejects(
    tools[0].execute({}, { workspace: "." }),
    /has not declared tasks support|refusing to poll/
  );
});

test("onProgress fires once on task creation and again after each poll", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(3)], tasks: true },
  });
  const progress: string[] = [];
  await tools[0].execute({}, { workspace: "." }, undefined, (text: string) => progress.push(text));
  assert.deepEqual(progress, ["started", "poll 1", "poll 2", "completed"]);
});

test("a task that ends failed throws with the server's error message", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'failer', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'failed',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, error: { message: 'build step failed' } } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    failer: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  await assert.rejects(tools[0].execute({}, { workspace: "." }), /build step failed/);
});

test("a task that ends cancelled (server-initiated) throws a clear error", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'canceler', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'cancelled',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    canceler: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  await assert.rejects(tools[0].execute({}, { workspace: "." }), /task was cancelled/);
});

test("a task with an unrecognized status doesn't loop forever — it throws naming the status", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'weirdo', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'zorped',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    weirdo: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  await assert.rejects(tools[0].execute({}, { workspace: "." }), /unrecognized status.*zorped/);
});

test("a task that never completes is bounded by its ttlMs, not left to hang forever", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'forever', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: 200, pollIntervalMs: 20 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'working',",
    "      statusMessage: 'still working', createdAt: 'now', lastUpdatedAt: 'now', ttlMs: 200, pollIntervalMs: 20 } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    forever: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  const started = Date.now();
  await assert.rejects(tools[0].execute({}, { workspace: "." }), /exceeded its ttlMs/);
  assert.ok(Date.now() - started < 5_000, "should give up around the ttlMs, not hang");
});

test("a server reporting a zero/negative pollIntervalMs doesn't busy-loop tasks/get", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "let polls = 0;",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'hammer', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 0 } });",
    "  if (m.method === 'tasks/get') {",
    "    polls++;",
    "    if (polls < 3)",
    "      return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'working',",
    "        createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: -5 } });",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'completed',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      result: { content: [{ type: 'text', text: 'done after ' + polls } ] } } });",
    "  }",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    hammer: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  const started = Date.now();
  const out = await tools[0].execute({}, { workspace: "." });
  const elapsed = Date.now() - started;
  assert.equal(out, "done after 3");
  // With a 250ms floor and 3 polls, this should take at least ~500ms — a
  // busy-poll bug (0/negative interval trusted verbatim) would finish near-instantly.
  assert.ok(elapsed >= 500, `expected clamped poll spacing, only took ${elapsed}ms`);
});

test("aborting mid-poll rejects promptly (not after the full poll interval) and tells the server to cancel the task", async () => {
  const workspace = await makeWorkspace();
  const marker = path.join(workspace, "cancel-marker");
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "const nodeFs = require('fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'slowtasker', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      statusMessage: 'started', createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 30000 } });",
    "  if (m.method === 'tasks/cancel') { nodeFs.writeFileSync(marker, 'cancelled'); return; }",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 30000 } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    slowtasker: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  const ctrl = new AbortController();
  const started = Date.now();
  const call = tools[0].execute({}, { workspace: "." }, ctrl.signal);
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(call, /cancelled by user/);
  // Not the 30s pollIntervalMs the server asked for.
  assert.ok(Date.now() - started < 5_000, "abort should not wait out the full poll interval");

  // Give the fire-and-forget tasks/cancel notification a moment to land.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await fs.readFile(marker, "utf8"), "cancelled");
});

test("a task whose input_required request isn't elicitation-shaped cancels the task and throws", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'inputter', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'input_required',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      inputRequests: { r1: { method: 'sampling/createMessage', params: {} } } } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    inputter: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  await assert.rejects(
    tools[0].execute({}, { workspace: "." }),
    /unsupported input method "sampling\/createMessage"/
  );
});

test("a task whose input_required schema is nested/unsupported cancels the task before throwing", async () => {
  const workspace = await makeWorkspace();
  const marker = path.join(workspace, "cancel-marker");
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "const nodeFs = require('fs');",
    `const marker = ${JSON.stringify(marker)};`,
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'nestedinput', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/cancel') { nodeFs.writeFileSync(marker, 'cancelled'); return; }",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'input_required',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      inputRequests: { nested: { method: 'elicitation/create', params: { message: 'Nested?',",
    "        requestedSchema: { properties: { nested: { type: 'object', properties: {} } } } } } } } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools(
    { nestedinput: { command: process.execPath, args: ["-e", script], tasks: true } },
    {
      tracer: NOOP_TRACER,
      onElicitation: async () => {
        throw new Error("onElicitation must not be called for an unsupported schema");
      },
    }
  );
  await assert.rejects(tools[0].execute({}, { workspace: "." }), /nested/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await fs.readFile(marker, "utf8"), "cancelled");
});

test("a task that goes to input_required, gets answered via elicitation, then completes", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "let asked = false;",
    "let updateResponses = null;",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'asker', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/update') {",
    "    updateResponses = m.params.inputResponses;",
    "    return send({ jsonrpc: '2.0', id: m.id, result: {} });",
    "  }",
    "  if (m.method === 'tasks/get') {",
    "    if (!asked) {",
    "      asked = true;",
    "      return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'input_required',",
    "        createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "        inputRequests: { proceed: { method: 'elicitation/create', params: { message: 'Proceed?',",
    "          requestedSchema: { properties: { ok: { type: 'boolean', title: 'OK' } } } } } } } });",
    "    }",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'completed',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      result: { content: [{ type: 'text', text: 'got:' + JSON.stringify(updateResponses) }] } } });",
    "  }",
    "});",
  ].join("\n");
  const elicitCalls: { message: string }[] = [];
  const tools = await loadMcpTools(
    { asker: { command: process.execPath, args: ["-e", script], tasks: true } },
    {
      tracer: NOOP_TRACER,
      onElicitation: async (_server, message) => {
        elicitCalls.push({ message });
        return { action: "accept" as const, content: { ok: true } };
      },
    }
  );
  const out = await tools[0].execute({}, { workspace: "." });
  assert.equal(elicitCalls.length, 1);
  assert.equal(elicitCalls[0].message, "Proceed?");
  assert.match(out, /"proceed":\{"action":"accept","content":\{"ok":true\}\}/);
});

// ---------- prompts and resources ----------

const FULL_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.id === undefined) return;",
  "  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });",
  "  if (m.method === 'initialize')",
  "    return reply({ protocolVersion: m.params.protocolVersion,",
  "      capabilities: { tools: {}, prompts: {}, resources: {} },",
  "      serverInfo: { name: 'full', version: '1' } });",
  "  if (m.method === 'tools/list') return reply({ tools: [] });",
  "  if (m.method === 'prompts/list')",
  "    return reply({ prompts: [{ name: 'triage', description: 'triage an issue',",
  "      arguments: [{ name: 'issue', required: true }] }] });",
  "  if (m.method === 'prompts/get')",
  "    return reply({ messages: [{ role: 'user',",
  "      content: { type: 'text', text: 'Triage: ' + m.params.arguments.issue } }] });",
  "  if (m.method === 'resources/list')",
  "    return reply({ resources: [{ uri: 'mem://handbook', name: 'handbook',",
  "      description: 'team handbook' }] });",
  "  if (m.method === 'resources/read')",
  "    return reply({ contents: [{ uri: m.params.uri, text: 'handbook body' }] });",
  "});",
].join("\n");

test("a server's prompts become slash commands and expand through prompts/get", async () => {
  await loadMcpTools({ linear: { command: process.execPath, args: ["-e", FULL_SERVER] } });

  const prompt = mcpPrompts().find((p) => p.command === "/linear-triage");
  assert.ok(prompt, `expected /linear-triage, got ${mcpPrompts().map((p) => p.command)}`);
  assert.equal(prompt.server, "linear");
  assert.deepEqual(
    prompt.args.map((a) => a.name),
    ["issue"]
  );
  // A single argument takes the whole line, as every other slash command does.
  assert.equal(await prompt.expand("login is broken"), "Triage: login is broken");

  assert.deepEqual(mcpStatus().find((s) => s.name === "linear")?.prompts, ["triage"]);
});

test("a server's resources become @-mentions and read through resources/read", async () => {
  await loadMcpTools({ docs: { command: process.execPath, args: ["-e", FULL_SERVER] } });

  const resource = mcpResources().find((r) => r.mention === "mcp:docs/handbook");
  assert.ok(resource, `expected mcp:docs/handbook, got ${mcpResources().map((r) => r.mention)}`);
  assert.equal(resource.uri, "mem://handbook");
  assert.equal(await resource.read(), "handbook body");

  assert.deepEqual(mcpStatus().find((s) => s.name === "docs")?.resources, ["handbook"]);
});

test("nothing is requested from a server that doesn't advertise prompts or resources", async () => {
  // STDIO_SERVER declares only tools; asking anyway would error or hang.
  await loadMcpTools({ plain: { command: process.execPath, args: ["-e", STDIO_SERVER] } });
  assert.deepEqual(
    mcpPrompts().filter((p) => p.server === "plain"),
    []
  );
  assert.deepEqual(
    mcpResources().filter((r) => r.server === "plain"),
    []
  );
});

test("a reconnect replaces a server's prompts instead of duplicating them", async () => {
  const cfg = { command: process.execPath, args: ["-e", FULL_SERVER] };
  await loadMcpTools({ again: cfg });
  await connectServer("again", cfg);
  assert.equal(mcpPrompts().filter((p) => p.server === "again").length, 1);
});
