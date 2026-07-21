import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { LspClient } from "../lsp/client.js";
import { serverForFile, languageIdForFile } from "../lsp/registry.js";
import { lspDiagnosticsTool } from "../tools/lsp.js";

test("serverForFile maps extensions to the right server", () => {
  assert.equal(serverForFile("src/app.ts")?.id, "typescript");
  assert.equal(serverForFile("src/App.tsx")?.id, "typescript");
  assert.equal(serverForFile("main.py")?.id, "python");
  assert.equal(serverForFile("cmd/main.go")?.id, "go");
  assert.equal(serverForFile("lib.rs")?.id, "rust");
  assert.equal(serverForFile("core.cpp")?.id, "clangd");
  assert.equal(serverForFile("README.md"), null);
  assert.equal(serverForFile("Makefile"), null);
});

test("languageIdForFile distinguishes dialects", () => {
  const ts = serverForFile("a.ts")!;
  assert.equal(languageIdForFile(ts, "a.ts"), "typescript");
  assert.equal(languageIdForFile(ts, "a.tsx"), "typescriptreact");
  assert.equal(languageIdForFile(ts, "a.jsx"), "javascriptreact");
});

test("lsp tools reject files with no known server", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-test-"));
  await fs.writeFile(path.join(ws, "notes.txt"), "hello");
  await assert.rejects(
    () => lspDiagnosticsTool.execute({ path: "notes.txt" }, { workspace: ws }),
    /No language server configured/
  );
});

test("lsp tools reject missing server binaries with an install hint", async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-test-"));
  await fs.writeFile(path.join(ws, "main.rs"), "fn main() {}");
  const config = {
    ...serverForFile("main.rs")!,
    command: "definitely-not-a-real-lsp-binary",
  };
  const client = new LspClient(config, ws);
  await assert.rejects(() => client.start(), /not installed.*rustup/);
});

/**
 * A minimal stdio language server written to a temp file, used to exercise
 * the real JSON-RPC framing, the initialize handshake, LocationLink
 * normalization, and the publishDiagnostics wait — with no external binary.
 */
const FAKE_SERVER_JS = String.raw`
let buffer = Buffer.alloc(0);
function send(msg) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
  process.stdout.write("Content-Length: " + body.length + "\r\n\r\n");
  process.stdout.write(body);
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
    buffer = buffer.subarray(headerEnd + 4 + length);
    onMessage(msg);
  }
});
function onMessage(msg) {
  switch (msg.method) {
    case "initialize":
      send({ id: msg.id, result: { capabilities: {} } });
      break;
    case "textDocument/didOpen":
    case "textDocument/didChange": {
      const doc = msg.params.textDocument;
      send({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: doc.uri,
          diagnostics: doc.version >= 2
            ? []
            : [{
                range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
                severity: 1,
                message: "fake error",
                source: "fake",
                code: 42,
              }],
        },
      });
      break;
    }
    case "textDocument/definition":
      // LocationLink form, which the client must normalize to a Location.
      send({
        id: msg.id,
        result: [{
          targetUri: msg.params.textDocument.uri,
          targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          targetSelectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        }],
      });
      break;
    case "textDocument/references":
      send({ id: msg.id, result: [
        { uri: msg.params.textDocument.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } },
      ]});
      break;
    case "textDocument/hover":
      send({ id: msg.id, result: { contents: { kind: "markdown", value: "const x: 1" } } });
      break;
    case "textDocument/rename":
      // WorkspaceEdit renaming the identifier at chars 6-7 to msg.params.newName.
      send({ id: msg.id, result: { changes: {
        [msg.params.textDocument.uri]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: msg.params.newName },
        ],
      }}});
      break;
    case "shutdown":
      send({ id: msg.id, result: null });
      break;
    case "exit":
      process.exit(0);
  }
}
`;

async function startFakeClient(): Promise<{ ws: string; file: string; client: LspClient }> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-fake-"));
  const serverPath = path.join(ws, "fake-server.cjs");
  await fs.writeFile(serverPath, FAKE_SERVER_JS);
  const file = path.join(ws, "main.ts");
  await fs.writeFile(file, "const x = 1;\n");
  const client = new LspClient(
    {
      id: "fake",
      command: process.execPath,
      args: [serverPath],
      installHint: "n/a",
      languageIds: { ts: "typescript" },
    },
    ws
  );
  await client.start();
  return { ws, file, client };
}

test("LspClient talks to a stdio server: definition, references, diagnostics", async () => {
  const { file, client } = await startFakeClient();
  try {
    const defs = await client.definition(file, { line: 0, character: 6 });
    assert.equal(defs.length, 1);
    assert.equal(defs[0].uri, pathToFileURL(file).href);
    assert.equal(defs[0].range.start.character, 6); // targetSelectionRange, not targetRange

    const refs = await client.references(file, { line: 0, character: 6 });
    assert.equal(refs.length, 1);

    const diags = await client.diagnosticsFor(file);
    assert.equal(diags.length, 1);
    assert.equal(diags[0].message, "fake error");
  } finally {
    client.dispose();
  }
});

test("LspClient hover returns the server's rendered contents", async () => {
  const { file, client } = await startFakeClient();
  try {
    assert.equal(await client.hover(file, { line: 0, character: 6 }), "const x: 1");
  } finally {
    client.dispose();
  }
});

test("LspClient rename normalizes a WorkspaceEdit to per-file edits", async () => {
  const { file, client } = await startFakeClient();
  try {
    const edits = await client.rename(file, { line: 0, character: 6 }, "y");
    assert.equal(edits.length, 1);
    assert.equal(edits[0].uri, pathToFileURL(file).href);
    assert.equal(edits[0].edits.length, 1);
    assert.equal(edits[0].edits[0].newText, "y");
    assert.equal(edits[0].edits[0].range.start.character, 6);
  } finally {
    client.dispose();
  }
});

test("LspClient re-syncs a changed file and picks up new diagnostics", async () => {
  const { file, client } = await startFakeClient();
  try {
    assert.equal((await client.diagnosticsFor(file)).length, 1);
    // The fake server publishes a clean set for version >= 2 (i.e. after didChange).
    await fs.writeFile(file, "const x = 2;\n");
    assert.equal((await client.diagnosticsFor(file)).length, 0);
  } finally {
    client.dispose();
  }
});

test("LspClient surfaces server death instead of hanging", async () => {
  const { file, client } = await startFakeClient();
  client.dispose();
  await assert.rejects(() => client.definition(file, { line: 0, character: 0 }));
  assert.equal(client.dead, true);
});
