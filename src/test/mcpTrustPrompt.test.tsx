import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { McpTrustPrompt } from "../ui/McpTrustPrompt.js";
import type { McpServerConfig } from "../config/config.js";

async function renderReady(el: ReactElement) {
  const instance = render(el);
  await new Promise((r) => setImmediate(r));
  return instance;
}

async function press(stdin: { write(data: string): void }, key: string) {
  stdin.write(key);
  await new Promise((r) => setImmediate(r));
}

/** Whether Ink colors its output depends on the real terminal, not this test's mocked stdout. */
function plain(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes, not an accident
  return (frame ?? "").replace(/\x1B\[[0-9;]*m/g, "");
}

const remote: McpServerConfig = { url: "https://example.invalid/mcp" };
const local: McpServerConfig = { command: "node", args: ["server.js"], cwd: "/proj" };

test("a remote server shows its URL and the 'leaves this machine' warning", async () => {
  const { lastFrame } = await renderReady(
    <McpTrustPrompt servers={{ web: remote }} onComplete={() => {}} />
  );
  const frame = plain(lastFrame());
  assert.match(frame, /New MCP server/);
  assert.match(frame, /https:\/\/example\.invalid\/mcp/);
  assert.match(frame, /leave this machine/);
});

test("a local (stdio) server shows its command and cwd, with no remote warning", async () => {
  const { lastFrame } = await renderReady(
    <McpTrustPrompt servers={{ fs: local }} onComplete={() => {}} />
  );
  const frame = plain(lastFrame());
  assert.match(frame, /node server\.js/);
  assert.match(frame, /runs in: \/proj/);
  assert.doesNotMatch(frame, /leave this machine/);
});

test("with a single server, trusting it completes with that name in the approved list", async () => {
  let approved: string[] | undefined;
  const { stdin } = await renderReady(
    <McpTrustPrompt
      servers={{ web: remote }}
      onComplete={(a) => {
        approved = a;
      }}
    />
  );
  await press(stdin, "\r");
  assert.deepEqual(approved, ["web"]);
});

test("with multiple servers, each is reviewed one at a time and only approved ones are collected", async () => {
  let approved: string[] | undefined;
  const { stdin, lastFrame } = await renderReady(
    <McpTrustPrompt
      servers={{ a: remote, b: local }}
      onComplete={(a) => {
        approved = a;
      }}
    />
  );
  assert.match(plain(lastFrame()), /\(1 of 2\)/);
  // Decline the first server.
  await press(stdin, "\x1B[B");
  await press(stdin, "\r");
  assert.match(plain(lastFrame()), /\(2 of 2\)/);
  assert.equal(approved, undefined, "onComplete only fires after the last server");
  // Trust the second.
  await press(stdin, "\r");
  assert.deepEqual(approved, ["b"]);
});

test("cancelling partway through completes with only what was already approved", async () => {
  let approved: string[] | undefined;
  const { stdin } = await renderReady(
    <McpTrustPrompt
      servers={{ a: remote, b: local }}
      onComplete={(a) => {
        approved = a;
      }}
    />
  );
  await press(stdin, "\r"); // trust "a"
  await press(stdin, "\x1B"); // cancel on "b"
  assert.deepEqual(approved, ["a"]);
});
