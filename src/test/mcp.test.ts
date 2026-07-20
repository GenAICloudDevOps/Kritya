import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadMcpTools, mcpStatus, shutdownMcp } from "../mcp/client.js";
import {
  expandVars,
  expandServerConfig,
  loadProjectMcpServers,
  mergeMcpServers,
} from "../mcp/servers.js";
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

function startHttpMcpServer(): Promise<{ url: string; seen: SeenRequest[]; close(): void }> {
  const seen: SeenRequest[] = [];
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
        close: () => server.close(),
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

test("http: an unreachable server is reported, not fatal", async () => {
  const tools = await loadMcpTools({
    down: { url: "http://127.0.0.1:1/mcp" },
  });
  assert.equal(tools.length, 0);
  const status = mcpStatus().find((s) => s.name === "down");
  assert.equal(status?.ok, false);
});
