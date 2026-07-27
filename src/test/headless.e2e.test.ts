import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { startFakeProvider, startHangingProvider, type ScriptedTurn } from "./e2eFakeProvider.js";

const execFileAsync = promisify(execFile);
const distIndex = path.join(process.cwd(), "dist", "index.js");

/**
 * These are the only tests in the suite that spawn the actual built CLI as a
 * real subprocess (`node dist/index.js`), the way a user or a CI pipeline
 * would invoke it -- everything else in src/test exercises source modules
 * in-process. A fake local HTTP server stands in for the LLM provider so
 * nothing here ever makes a real network call; each test points kritya at it
 * via a scratch $HOME with its own ~/.kritya/config.json.
 */
async function freshHome(providerUrl: string): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-e2e-home-"));
  await fs.mkdir(path.join(home, ".kritya"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".kritya", "config.json"),
    JSON.stringify({
      provider: "e2e",
      model: "fake-model",
      providers: { e2e: { baseUrl: providerUrl, apiKey: "test-key" } },
    })
  );
  return home;
}

async function freshWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-e2e-ws-"));
}

async function writeSkillFixture(
  workspace: string,
  name: string,
  opts: { description?: string; body?: string } = {}
): Promise<string> {
  const dir = path.join(workspace, ".kritya", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.description ?? "a skill"}\n---\n\n${opts.body ?? "Do the thing."}\n`
  );
  return dir;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runKritya(home: string, workspace: string, extraArgs: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [distIndex, workspace, "--output", "json", ...extraArgs],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000 }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("a plain prompt with a text-only reply succeeds end to end", async () => {
  const script: ScriptedTurn[] = [{ type: "text", text: "the answer is 42" }];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "what is the answer?"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "the answer is 42");
    assert.equal(parsed.toolCalls.length, 0);
    assert.equal(provider.requestCount(), 1);
  } finally {
    await provider.close();
  }
});

test("a prompt that triggers a real tool call actually reads the real file", async () => {
  const workspace = await freshWorkspace();
  await fs.writeFile(path.join(workspace, "notes.txt"), "hello from disk\n");
  const script: ScriptedTurn[] = [
    { type: "toolCall", name: "read_file", argsJson: JSON.stringify({ path: "notes.txt" }) },
    { type: "text", text: "the file says hello from disk" },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "what's in notes.txt?"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "the file says hello from disk");
    assert.equal(parsed.toolCalls.length, 1);
    assert.equal(parsed.toolCalls[0].name, "read_file");
    assert.equal(parsed.toolCalls[0].error, false);
    // Two round-trips: one that produced the tool call, one with the follow-up answer.
    assert.equal(provider.requestCount(), 2);
  } finally {
    await provider.close();
  }
});

test("missing API key fails fast with a clear error and exit code 1, no network call", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-e2e-home-"));
  await fs.mkdir(path.join(home, ".kritya"), { recursive: true });
  // No config.json at all, and none of the builtin providers' env vars set.
  const workspace = await freshWorkspace();
  const cleanEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  for (const key of [
    "NVIDIA_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "TOGETHER_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
  ]) {
    delete cleanEnv[key];
  }
  try {
    await execFileAsync(
      process.execPath,
      [distIndex, workspace, "--output", "json", "--prompt", "hi"],
      { env: cleanEnv, timeout: 20_000 }
    );
    assert.fail("expected a non-zero exit code");
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    assert.equal(e.code, 1);
    const parsed = JSON.parse(e.stdout ?? "{}");
    assert.equal(parsed.success, false);
    assert.match(parsed.error, /No API key found/);
  }
});

test("a provider that always errors is retried and then reported as retry-exhausted", async () => {
  // ProviderClient retries up to MAX_ATTEMPTS (4) times before giving up.
  const script: ScriptedTurn[] = [
    { type: "error", status: 500 },
    { type: "error", status: 500 },
    { type: "error", status: 500 },
    { type: "error", status: 500 },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "hi"]);
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, false);
    assert.match(parsed.error, /failed after 4 attempt/i);
    assert.equal(provider.requestCount(), 4);
    // ollama's builtin apiKey ("ollama") is hardcoded and always "available",
    // so it's always the suggested fallback -- there's no real other provider
    // configured in this scratch $HOME.
    assert.match(parsed.error, /Retry with --provider ollama/);
  } finally {
    await provider.close();
  }
});

test("--timeout aborts a hung provider and reports a timeout error", async () => {
  const provider = await startHangingProvider();
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "hi", "--timeout", "1"]);
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, false);
    assert.match(parsed.error, /Timed out after 1s/);
  } finally {
    await provider.close();
  }
});

test("--output text prints the plain result instead of a JSON object", async () => {
  const script: ScriptedTurn[] = [{ type: "text", text: "plain text reply" }];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    const { stdout } = await execFileAsync(
      process.execPath,
      [distIndex, workspace, "--prompt", "hi"],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000 }
    );
    assert.equal(stdout.trim(), "plain text reply");
  } finally {
    await provider.close();
  }
});

test("load_skill happy path: skill is loaded and reflected in the result", async () => {
  const script: ScriptedTurn[] = [
    { type: "toolCall", name: "load_skill", argsJson: JSON.stringify({ name: "ratio-analysis" }) },
    { type: "text", text: "Applied the ratio-analysis skill." },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    await writeSkillFixture(workspace, "ratio-analysis", {
      body: "current ratio = assets / liabilities",
    });
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "analyze the ratios"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "Applied the ratio-analysis skill.");
    assert.deepEqual(
      parsed.toolCalls.map((t: { name: string; error: boolean }) => ({
        name: t.name,
        error: t.error,
      })),
      [{ name: "load_skill", error: false }]
    );
  } finally {
    await provider.close();
  }
});

test("load_skill with an unknown name reports a failed tool call but still completes", async () => {
  const script: ScriptedTurn[] = [
    { type: "toolCall", name: "load_skill", argsJson: JSON.stringify({ name: "does-not-exist" }) },
    { type: "text", text: "That skill isn't available." },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    await writeSkillFixture(workspace, "ratio-analysis");
    const { code, stdout } = await runKritya(home, workspace, [
      "--prompt",
      "use the fictional skill",
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "That skill isn't available.");
    assert.deepEqual(
      parsed.toolCalls.map((t: { name: string; error: boolean }) => ({
        name: t.name,
        error: t.error,
      })),
      [{ name: "load_skill", error: true }]
    );
  } finally {
    await provider.close();
  }
});

test("a workspace with no skills directory is unaffected by the feature", async () => {
  const script: ScriptedTurn[] = [{ type: "text", text: "the answer is 42" }];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace(); // no .kritya/skills at all
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "what is the answer?"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "the answer is 42");
    assert.equal(parsed.toolCalls.length, 0);
  } finally {
    await provider.close();
  }
});

test("load_skill followed by reading a bundled reference file works end to end", async () => {
  const script: ScriptedTurn[] = [
    { type: "toolCall", name: "load_skill", argsJson: JSON.stringify({ name: "ratio-analysis" }) },
    {
      type: "toolCall",
      name: "read_file",
      argsJson: JSON.stringify({ path: ".kritya/skills/ratio-analysis/references/formulas.md" }),
    },
    { type: "text", text: "Used the referenced formula." },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    const dir = await writeSkillFixture(workspace, "ratio-analysis");
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "references", "formulas.md"),
      "current_ratio = assets / liabilities"
    );
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "compute the ratio"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "Used the referenced formula.");
    assert.deepEqual(
      parsed.toolCalls.map((t: { name: string; error: boolean }) => t.name),
      ["load_skill", "read_file"]
    );
  } finally {
    await provider.close();
  }
});
