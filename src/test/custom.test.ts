import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expandCommand, loadCustomCommands } from "../commands/custom.js";
import type { DiscoveredPlugin } from "../plugins/discover.js";

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-custom-cmd-test-"));
  fs.mkdirSync(path.join(dir, ".kritya", "commands"), { recursive: true });
  return dir;
}

function writeCommand(ws: string, file: string, body: string): void {
  fs.writeFileSync(path.join(ws, ".kritya", "commands", file), body);
}

test("loadCustomCommands turns a workspace command file into a named command", () => {
  const ws = workspace();
  writeCommand(ws, "kritya-test-deploy.md", "Deploy the thing.\n");
  const commands = loadCustomCommands(ws, true);
  const cmd = commands.find((c) => c.name === "/kritya-test-deploy");
  assert.ok(cmd, "the .md filename becomes a leading-slash command name");
  assert.equal(
    cmd!.description,
    "custom command",
    "no description comment falls back to a default"
  );
  assert.equal(cmd!.body, "Deploy the thing.");
});

test("loadCustomCommands reads an optional description comment as the listing description", () => {
  const ws = workspace();
  writeCommand(
    ws,
    "kritya-test-release.md",
    "description: cut a release\n\nDo the release steps.\n"
  );
  const commands = loadCustomCommands(ws, true);
  const cmd = commands.find((c) => c.name === "/kritya-test-release");
  assert.equal(cmd!.description, "cut a release");
  assert.equal(cmd!.body, "Do the release steps.");
});

test("loadCustomCommands accepts the HTML-comment description form", () => {
  const ws = workspace();
  writeCommand(
    ws,
    "kritya-test-html.md",
    "<!-- description: html comment style -->\n\nBody here.\n"
  );
  const commands = loadCustomCommands(ws, true);
  const cmd = commands.find((c) => c.name === "/kritya-test-html");
  assert.equal(cmd!.description, "html comment style");
});

test("loadCustomCommands with trustWorkspace=false skips workspace-declared commands", () => {
  const ws = workspace();
  writeCommand(ws, "kritya-test-untrusted.md", "Should not load.\n");
  const commands = loadCustomCommands(ws, false);
  assert.equal(
    commands.find((c) => c.name === "/kritya-test-untrusted"),
    undefined
  );
});

test("loadCustomCommands returns [] for a workspace with no commands directory", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-custom-cmd-empty-"));
  // No assertion on global length (the real ~/.kritya/commands may have entries),
  // just that this workspace contributes nothing extra beyond whatever global has.
  const withWorkspace = loadCustomCommands(ws, true);
  const withoutWorkspace = loadCustomCommands(ws, false);
  assert.deepEqual(withWorkspace, withoutWorkspace);
});

function writePluginCommand(pluginDir: string, file: string, body: string): DiscoveredPlugin {
  const dir = path.join(pluginDir, "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
  return { name: path.basename(pluginDir), dir: pluginDir, manifest: {} };
}

test("loadCustomCommands includes a plugin's commands/ when the workspace is trusted, labeled with its plugin name", () => {
  const ws = workspace();
  const plugin = writePluginCommand(
    path.join(ws, "plugin-dir"),
    "kritya-test-plugin-cmd.md",
    "description: from a plugin\n\nDo the plugin thing.\n"
  );
  const commands = loadCustomCommands(ws, true, [plugin]);
  const cmd = commands.find((c) => c.name === "/kritya-test-plugin-cmd");
  assert.ok(cmd, "the plugin's command file is loaded");
  assert.equal(cmd!.description, "from a plugin");
  assert.equal(cmd!.pluginName, plugin.name);
});

test("loadCustomCommands skips plugin commands when the workspace is untrusted", () => {
  const ws = workspace();
  const plugin = writePluginCommand(
    path.join(ws, "plugin-dir"),
    "kritya-test-plugin-untrusted.md",
    "Should not load.\n"
  );
  const commands = loadCustomCommands(ws, false, [plugin]);
  assert.equal(
    commands.find((c) => c.name === "/kritya-test-plugin-untrusted"),
    undefined
  );
});

test("loadCustomCommands: a workspace-declared command overrides a same-named plugin command", () => {
  const ws = workspace();
  const plugin = writePluginCommand(
    path.join(ws, "plugin-dir"),
    "kritya-test-override.md",
    "From the plugin.\n"
  );
  writeCommand(ws, "kritya-test-override.md", "From the workspace.\n");
  const commands = loadCustomCommands(ws, true, [plugin]);
  const cmd = commands.find((c) => c.name === "/kritya-test-override");
  assert.equal(cmd!.body, "From the workspace.");
  assert.equal(cmd!.pluginName, undefined);
});

test("expandCommand substitutes $ARGUMENTS and {{args}} placeholders", () => {
  assert.equal(expandCommand("run: $ARGUMENTS", "lint"), "run: lint");
  assert.equal(expandCommand("run: {{args}} now", "lint"), "run: lint now");
});

test("expandCommand appends bare arguments when the body has no placeholder", () => {
  assert.equal(expandCommand("Do the thing.", "extra context"), "Do the thing.\n\nextra context");
  assert.equal(expandCommand("Do the thing.", ""), "Do the thing.");
});
