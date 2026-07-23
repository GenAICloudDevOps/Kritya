import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadMcpTools, mcpStatus, shutdownMcp, toolAllowed } from "../mcp/client.js";
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

after(() => shutdownMcp());

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
    const afterInit = srv.seen.filter((r) => r.method !== "initialize");
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
