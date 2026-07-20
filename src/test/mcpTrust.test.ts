import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  isServerTrusted,
  loadMcpAllowlist,
  partitionByTrust,
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
