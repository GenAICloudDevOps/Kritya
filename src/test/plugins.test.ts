import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  scanPluginsDetailed,
  pluginsDir,
  userPluginsDir,
  _setWarnSink,
} from "../plugins/discover.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-plugins-"));
}

function writePlugin(
  root: string,
  folderName: string,
  manifest: Record<string, unknown> | string | undefined
): string {
  const dir = path.join(root, folderName);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    const raw = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
    fs.writeFileSync(path.join(dir, "plugin.json"), raw);
  }
  return dir;
}

test("scanPluginsDetailed loads a valid plugin manifest", () => {
  const root = tmpWorkspace();
  writePlugin(root, "finance-tools", { name: "finance-tools", version: "1.0.0" });

  const { loaded, skipped } = scanPluginsDetailed([root]);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "finance-tools");
  assert.equal(loaded[0].manifest.version, "1.0.0");
  assert.equal(loaded[0].dir, path.join(root, "finance-tools"));
  assert.equal(skipped.length, 0);
});

test("scanPluginsDetailed ignores a folder with no plugin.json", () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, "not-a-plugin"), { recursive: true });

  const { loaded, skipped } = scanPluginsDetailed([root]);

  assert.equal(loaded.length, 0);
  assert.equal(skipped.length, 0);
});

test("scanPluginsDetailed skips a plugin.json with invalid JSON", () => {
  const root = tmpWorkspace();
  writePlugin(root, "broken", "{ not valid json");

  const { loaded, skipped } = scanPluginsDetailed([root]);

  assert.equal(loaded.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, "broken");
  assert.match(skipped[0].reason, /invalid json/i);
});

test("scanPluginsDetailed skips a manifest missing required fields", () => {
  const root = tmpWorkspace();
  writePlugin(root, "no-version", { name: "no-version" });

  const { loaded, skipped } = scanPluginsDetailed([root]);

  assert.equal(loaded.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /name.*version|version.*name/i);
});

test("scanPluginsDetailed skips a manifest whose name does not match its folder", () => {
  const root = tmpWorkspace();
  writePlugin(root, "folder-name", { name: "different-name", version: "1.0.0" });

  const { loaded, skipped } = scanPluginsDetailed([root]);

  assert.equal(loaded.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /does not match/i);
});

test("scanPluginsDetailed dedupes by name across roots, first root wins", () => {
  const rootA = tmpWorkspace();
  const rootB = tmpWorkspace();
  writePlugin(rootA, "shared", { name: "shared", version: "1.0.0" });
  writePlugin(rootB, "shared", { name: "shared", version: "2.0.0" });

  const { loaded, skipped } = scanPluginsDetailed([rootA, rootB]);

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].manifest.version, "1.0.0");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /duplicate/i);
});

test("pluginsDir returns <workspace>/.kritya/plugins", () => {
  assert.equal(pluginsDir("/tmp/ws"), path.join("/tmp/ws", ".kritya", "plugins"));
});

test("userPluginsDir returns ~/.kritya/plugins", () => {
  assert.equal(userPluginsDir(), path.join(os.homedir(), ".kritya", "plugins"));
});

void _setWarnSink;
