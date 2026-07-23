import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  isServerTrusted,
  loadMcpAllowlist,
  partitionByTrust,
  revokeFingerprint,
  revokeServer,
  serverFingerprint,
  trustServer,
} from "../trust/mcpTrust.js";

async function makeStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-mcp-trust-test-"));
  return path.join(dir, "mcp-trusted.json");
}

test("serverFingerprint is stable for identical config and ignores env/header values", () => {
  const a = serverFingerprint({ command: "node", args: ["a.js"], env: { KEY: "one" } });
  const b = serverFingerprint({ command: "node", args: ["a.js"], env: { KEY: "two" } });
  assert.equal(a, b, "fingerprint should not depend on env/header values, only their key names");
});

test("serverFingerprint changes with command, args, url, or key names", () => {
  const base = serverFingerprint({ command: "node", args: ["a.js"] });
  assert.notEqual(base, serverFingerprint({ command: "node", args: ["b.js"] }));
  assert.notEqual(base, serverFingerprint({ command: "python", args: ["a.js"] }));
  assert.notEqual(base, serverFingerprint({ url: "https://example.com/mcp" }));
  assert.notEqual(
    serverFingerprint({ command: "node", env: { A: "1" } }),
    serverFingerprint({ command: "node", env: { A: "1", B: "2" } })
  );
});

test("isServerTrusted/trustServer round-trip via the manifest file", async () => {
  const storeFile = await makeStoreFile();
  const fp = serverFingerprint({ command: "node", args: ["server.js"] });

  assert.equal(isServerTrusted(fp, storeFile), false);
  trustServer("myserver", fp, storeFile);
  assert.equal(isServerTrusted(fp, storeFile), true);

  const entries = loadMcpAllowlist(storeFile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "myserver");
  assert.equal(entries[0].fingerprint, fp);
  assert.ok(entries[0].trustedAt);
});

test("trustServer replaces a prior entry for the same fingerprint rather than duplicating it", async () => {
  const storeFile = await makeStoreFile();
  const fp = serverFingerprint({ command: "node", args: ["server.js"] });
  trustServer("old-name", fp, storeFile);
  trustServer("renamed", fp, storeFile);
  const entries = loadMcpAllowlist(storeFile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "renamed");
});

test("partitionByTrust splits already-trusted servers from ones needing first-use approval", async () => {
  const storeFile = await makeStoreFile();
  const known = { command: "node", args: ["known.js"] };
  trustServer("known", serverFingerprint(known), storeFile);

  const { trusted, pending } = partitionByTrust(
    {
      known,
      newOne: { command: "node", args: ["new.js"] },
    },
    storeFile
  );
  assert.deepEqual(Object.keys(trusted), ["known"]);
  assert.deepEqual(Object.keys(pending), ["newOne"]);
});

test("isServerTrusted tolerates a missing manifest file", async () => {
  const storeFile = path.join(os.tmpdir(), "kritya-mcp-trust-does-not-exist", "mcp-trusted.json");
  assert.equal(isServerTrusted(serverFingerprint({ command: "node" }), storeFile), false);
});

test("serverFingerprint changes with cwd, so widening a server's scope re-prompts", () => {
  const base = { command: "npx", args: ["-y", "server-filesystem", "."] };
  const docs = serverFingerprint({ ...base, cwd: "./docs" });
  const root = serverFingerprint({ ...base, cwd: "/" });
  assert.notEqual(docs, root, "a cwd change must not inherit the earlier approval");
  assert.notEqual(serverFingerprint(base), docs);
});

test("serverFingerprint changes when a tool allow/deny list is relaxed", () => {
  const base = { url: "https://mcp.example.com/mcp" };
  const narrow = serverFingerprint({ ...base, tools: { allow: ["search"] } });
  const wide = serverFingerprint({ ...base, tools: { allow: ["*"] } });
  assert.notEqual(narrow, wide, "widening the exposed tool set must re-prompt");
});

test("revokeServer drops every entry for a name and reports what it removed", async () => {
  const store = await makeStoreFile();
  trustServer("linear", "fp-one", store);
  trustServer("linear", "fp-two", store);
  trustServer("github", "fp-three", store);

  const removed = revokeServer("linear", store);
  assert.equal(removed.length, 2);
  assert.deepEqual(removed.map((e) => e.fingerprint).sort(), ["fp-one", "fp-two"]);
  assert.equal(isServerTrusted("fp-one", store), false);
  assert.equal(isServerTrusted("fp-two", store), false);
  // Untouched servers survive.
  assert.equal(isServerTrusted("fp-three", store), true);
});

test("revokeServer on an unknown name is a no-op, not an error", async () => {
  const store = await makeStoreFile();
  trustServer("linear", "fp-one", store);
  assert.deepEqual(revokeServer("nope", store), []);
  assert.equal(loadMcpAllowlist(store).length, 1);
});

test("revokeFingerprint removes one exact config and leaves siblings alone", async () => {
  const store = await makeStoreFile();
  trustServer("files", "fp-docs", store);
  trustServer("files", "fp-root", store);

  assert.equal(revokeFingerprint("fp-docs", store), true);
  assert.equal(isServerTrusted("fp-docs", store), false);
  assert.equal(isServerTrusted("fp-root", store), true);
  // Second call finds nothing left to remove.
  assert.equal(revokeFingerprint("fp-docs", store), false);
});

test("a revoked server is pending again, not silently re-approved", async () => {
  const store = await makeStoreFile();
  const cfg = { command: "node", args: ["server.js"] };
  trustServer("srv", serverFingerprint(cfg), store);
  assert.deepEqual(Object.keys(partitionByTrust({ srv: cfg }, store).pending), []);

  revokeServer("srv", store);
  // The point of revocation: the same config in any workspace asks again.
  assert.deepEqual(Object.keys(partitionByTrust({ srv: cfg }, store).pending), ["srv"]);
});
