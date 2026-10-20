import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSandboxedCommand,
  sandboxAvailable,
  sandboxNetworkMode,
  sandboxReadDenyPaths,
  setHeadlessSandboxRestrictions,
  type SandboxedCommand,
} from "../shell/sandbox.js";

/**
 * Tests that the walls hold, not that the room is comfortable.
 *
 * Every other sandbox test asks "can a legitimate command still do its job".
 * That is the wrong direction for a containment claim: a sandbox that silently
 * stops denying passes all of them. These assert the refusals instead, and each
 * refusal that can be checked against a live backend is paired with a positive
 * control, so a probe that never ran cannot read as a probe that was blocked.
 */

/** The three credentials the default posture deliberately leaves readable. */
const WORKFLOW_CREDENTIALS = [
  ".npmrc",
  path.join(".config", "gh", "hosts.yml"),
  ".git-credentials",
];

test("default posture keeps the three workflow credentials readable", () => {
  // The counterpart to the strict test below. Both halves are asserted so the
  // switch cannot quietly become the default in either direction.
  const home = os.homedir();
  const denied = sandboxReadDenyPaths({});
  for (const kept of WORKFLOW_CREDENTIALS) {
    assert.ok(
      !denied.includes(path.join(home, kept)),
      `${kept} must stay readable without sandboxReadDenyStrict`
    );
  }
});

test("sandboxReadDenyStrict masks the three workflow credentials", () => {
  const home = os.homedir();
  const denied = sandboxReadDenyPaths({ sandboxReadDenyStrict: true });
  for (const hidden of WORKFLOW_CREDENTIALS) {
    assert.ok(
      denied.includes(path.join(home, hidden)),
      `${hidden} carries a live token and must be masked under sandboxReadDenyStrict`
    );
  }
});

test("sandboxReadDenyStrict keeps the rest of the default list intact", () => {
  const home = os.homedir();
  const denied = sandboxReadDenyPaths({ sandboxReadDenyStrict: true });
  for (const stillDenied of [".aws", ".kube", ".netrc"]) {
    assert.ok(denied.includes(path.join(home, stillDenied)));
  }
});

test("sandboxReadAllow still carves one path back out under sandboxReadDenyStrict", () => {
  const home = os.homedir();
  const denied = sandboxReadDenyPaths({
    sandboxReadDenyStrict: true,
    sandboxReadAllow: ["~/.npmrc"],
  });
  assert.ok(!denied.includes(path.join(home, ".npmrc")), "an explicit allow must win");
  assert.ok(
    denied.includes(path.join(home, ".git-credentials")),
    "allowing one path must not release the others"
  );
});

test("headless: no egress, strict reads, and no honouring sandboxReadDeny=false", () => {
  setHeadlessSandboxRestrictions(true);
  try {
    assert.equal(
      sandboxNetworkMode({ sandboxNetwork: "open" }),
      "none",
      "a headless run has nobody to decide that the network is safe here"
    );

    const denied = sandboxReadDenyPaths({ sandboxReadDeny: false });
    assert.ok(
      denied.length > 0,
      "read denial must survive a config that turned it off for an interactive session"
    );
    for (const hidden of WORKFLOW_CREDENTIALS) {
      assert.ok(denied.includes(path.join(os.homedir(), hidden)));
    }
  } finally {
    setHeadlessSandboxRestrictions(false);
  }
});

test("headless: the posture does not leak into an interactive session", () => {
  setHeadlessSandboxRestrictions(false);
  assert.equal(sandboxNetworkMode({ sandboxNetwork: "open" }), "open");
  assert.deepEqual(sandboxReadDenyPaths({ sandboxReadDeny: false }), []);
  assert.equal(
    sandboxNetworkMode({}),
    "open",
    "the default posture stays permissive for a session with a human in it"
  );
});

test("headless: the posture reaches the bwrap args", (t) => {
  if (os.platform() !== "linux" || !sandboxAvailable()) {
    t.skip("bwrap only");
    return;
  }
  setHeadlessSandboxRestrictions(true);
  try {
    const wrapped = buildSandboxedCommand("true", os.tmpdir(), { sandboxNetwork: "open" });
    assert.ok(wrapped, "a backend is available, so a wrapper must be produced");
    assert.ok(
      wrapped.args.includes("--unshare-net"),
      "the headless posture must unshare the network even when the config says open"
    );
  } finally {
    setHeadlessSandboxRestrictions(false);
  }
});

/** Runs a built wrapper to completion, returning its exit code and output. */
function runWrapped(
  wrapped: SandboxedCommand,
  cwd: string
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // `cwd` is not optional: bwrap's wrapper carries its own --chdir, but
    // sandbox-exec does not, so a command naming a relative file only resolves
    // on macOS if the caller sets the working directory the way the real
    // tool executor does.
    const child = spawn(wrapped.cmd, wrapped.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("close", (code) => {
      wrapped.cleanup?.();
      resolve({ code, out });
    });
  });
}

test("network none: a sandboxed command cannot open a TCP connection", async (t) => {
  // Windows/MXC is excluded rather than skipped silently: its policy can express
  // an egress deny, but the loopback probe below is not meaningful inside an
  // AppContainer, and that path is covered by the mxcPolicyJson tests.
  if (os.platform() === "win32" || !sandboxAvailable()) {
    t.skip("no POSIX sandbox backend on this machine");
    return;
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-netprobe-"));
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0, "the control server must be listening before the probe runs");

  try {
    // The probe talks to a listener in this very process, so nothing leaves the
    // machine and no external host can make this test flaky.
    const probe = path.join(workspace, "probe.cjs");
    fs.writeFileSync(
      probe,
      [
        `const s = require("node:net").connect(${port}, "127.0.0.1");`,
        `s.on("connect", () => { console.log("CONNECTED"); process.exit(0); });`,
        `s.on("error", (e) => { console.log("BLOCKED " + e.code); process.exit(1); });`,
        `setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 2000);`,
      ].join("\n")
    );

    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify("probe.cjs")}`;

    // Positive control first: without it, a broken probe (node missing inside
    // the sandbox, say) would make the blocked case below pass for the wrong
    // reason.
    const open = buildSandboxedCommand(command, workspace, { sandboxNetwork: "open" });
    assert.ok(open, "a backend is available, so a wrapper must be produced");
    const openResult = await runWrapped(open, workspace);
    assert.equal(
      openResult.code,
      0,
      `control failed, so the probe proves nothing: ${openResult.out}`
    );
    assert.match(openResult.out, /CONNECTED/);

    const closed = buildSandboxedCommand(command, workspace, { sandboxNetwork: "none" });
    assert.ok(closed);
    const closedResult = await runWrapped(closed, workspace);
    assert.notEqual(closedResult.code, 0, "a connection succeeded inside a no-network sandbox");
    assert.match(
      closedResult.out,
      /BLOCKED|TIMEOUT/,
      `expected the connect to fail, got: ${closedResult.out}`
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("strict reads: a masked credential is unreadable inside the sandbox", async (t) => {
  if (os.platform() === "win32" || !sandboxAvailable()) {
    t.skip("no POSIX sandbox backend on this machine");
    return;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-strict-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-strict-ws-"));
  const credential = path.join(home, ".git-credentials");
  fs.writeFileSync(credential, "https://user:token@example.invalid\n");

  try {
    t.mock.method(os, "homedir", () => home);
    const command = `cat ${JSON.stringify(credential)}`;
    const wrapped = buildSandboxedCommand(command, workspace, { sandboxReadDenyStrict: true });
    assert.ok(wrapped);
    const result = await runWrapped(wrapped, workspace);
    assert.notEqual(result.code, 0, "a masked credential must not be readable");
    assert.doesNotMatch(result.out, /token@example\.invalid/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
