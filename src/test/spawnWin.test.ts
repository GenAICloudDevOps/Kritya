import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planSpawn, resolveWindowsCommand } from "../mcp/spawnWin.js";

async function tempBin(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-spawnwin-"));
}

/** Saves PATH/PATHEXT, runs `fn`, and restores them — resolveWindowsCommand reads both. */
async function withPathEnv(dir: string, exts: string | undefined, fn: () => Promise<void> | void) {
  const savedPath = process.env.PATH;
  const savedExt = process.env.PATHEXT;
  process.env.PATH = dir;
  if (exts === undefined) delete process.env.PATHEXT;
  else process.env.PATHEXT = exts;
  try {
    await fn();
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = savedExt;
  }
}

test("resolveWindowsCommand finds a bare command by trying each PATHEXT extension on PATH", async () => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.cmd"), "@echo off\n");
  await withPathEnv(dir, ".com;.exe;.bat;.cmd", async () => {
    assert.equal(resolveWindowsCommand("tool"), path.join(dir, "tool.cmd"));
  });
});

test("resolveWindowsCommand returns undefined when nothing on PATH matches", async () => {
  const dir = await tempBin();
  await withPathEnv(dir, undefined, async () => {
    assert.equal(resolveWindowsCommand("nonexistent-tool-xyz"), undefined);
  });
});

test("resolveWindowsCommand tries extensions in PATHEXT order and picks the first match", async () => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.exe"), "");
  await fs.writeFile(path.join(dir, "tool.cmd"), "");
  await withPathEnv(dir, ".exe;.cmd", async () => {
    assert.equal(resolveWindowsCommand("tool"), path.join(dir, "tool.exe"));
  });
});

test("an explicit path with an explicit extension resolves only if that exact file exists", async () => {
  const dir = await tempBin();
  const exe = path.join(dir, "tool.exe");
  await fs.writeFile(exe, "");
  assert.equal(resolveWindowsCommand(exe), exe);
  assert.equal(resolveWindowsCommand(path.join(dir, "missing.exe")), undefined);
});

test("a bare command with an explicit extension is looked up directly on each PATH dir", async () => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.cmd"), "");
  await withPathEnv(dir, undefined, async () => {
    assert.equal(resolveWindowsCommand("tool.cmd"), path.join(dir, "tool.cmd"));
    assert.equal(resolveWindowsCommand("missing.cmd"), undefined);
  });
});

test("planSpawn is a passthrough on non-Windows platforms regardless of the command", async (t) => {
  t.mock.method(os, "platform", () => "linux");
  assert.deepEqual(planSpawn("npx", ["-y", "some-server"]), {
    command: "npx",
    args: ["-y", "some-server"],
  });
});

test("planSpawn on Windows is a passthrough when the command can't be resolved", async (t) => {
  const dir = await tempBin();
  await withPathEnv(dir, undefined, async () => {
    t.mock.method(os, "platform", () => "win32");
    assert.deepEqual(planSpawn("nonexistent-tool-xyz", ["a"]), {
      command: "nonexistent-tool-xyz",
      args: ["a"],
    });
  });
});

test("planSpawn on Windows resolves a plain .exe without the cmd.exe detour", async (t) => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.exe"), "");
  await withPathEnv(dir, ".exe", async () => {
    t.mock.method(os, "platform", () => "win32");
    const plan = planSpawn("tool", ["--flag"]);
    assert.equal(plan.command, path.join(dir, "tool.exe"));
    assert.deepEqual(plan.args, ["--flag"]);
    assert.equal(plan.windowsVerbatimArguments, undefined);
  });
});

test("planSpawn on Windows routes a .cmd file through cmd.exe with verbatim args", async (t) => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.cmd"), "");
  const savedComSpec = process.env.ComSpec;
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
  try {
    await withPathEnv(dir, ".cmd", async () => {
      t.mock.method(os, "platform", () => "win32");
      const plan = planSpawn("tool", ["hello"]);
      assert.equal(plan.command, "C:\\Windows\\System32\\cmd.exe");
      assert.equal(plan.windowsVerbatimArguments, true);
      assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.equal(plan.args.length, 4);
    });
  } finally {
    if (savedComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = savedComSpec;
  }
});

test("a .bat file gets the same cmd.exe treatment as .cmd", async (t) => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.bat"), "");
  await withPathEnv(dir, ".bat", async () => {
    t.mock.method(os, "platform", () => "win32");
    const plan = planSpawn("tool", []);
    assert.equal(plan.windowsVerbatimArguments, true);
  });
});

test("an argument that tries to break out with '&' is caret-escaped, not passed through raw", async (t) => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.cmd"), "");
  await withPathEnv(dir, ".cmd", async () => {
    t.mock.method(os, "platform", () => "win32");
    const plan = planSpawn("tool", ["x & calc"]);
    const line = plan.args[3];
    // Every '&' in the built command line must be immediately preceded by a
    // caret — an unescaped one would let cmd.exe run `calc` as a second command.
    assert.doesNotMatch(line, /(?<!\^)&/);
    assert.match(line, /\^&/);
  });
});

test("pipe, redirection, and quote characters in an argument are all caret-escaped", async (t) => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.cmd"), "");
  await withPathEnv(dir, ".cmd", async () => {
    t.mock.method(os, "platform", () => "win32");
    const plan = planSpawn("tool", ['a | b > c < d "e"']);
    const line = plan.args[3];
    for (const ch of ["|", ">", "<"]) {
      const re = new RegExp(`(?<!\\^)\\${ch}`);
      assert.doesNotMatch(line, re, `unescaped ${ch} found in: ${line}`);
    }
  });
});

test("multiple args are joined into one escaped command line, in order", async (t) => {
  const dir = await tempBin();
  await fs.writeFile(path.join(dir, "tool.cmd"), "");
  await withPathEnv(dir, ".cmd", async () => {
    t.mock.method(os, "platform", () => "win32");
    const plan = planSpawn("tool", ["first", "second"]);
    const line = plan.args[3];
    assert.ok(line.indexOf("first") < line.indexOf("second"));
  });
});
