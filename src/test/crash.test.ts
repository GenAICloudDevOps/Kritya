import assert from "node:assert/strict";
import { test } from "node:test";
import { installCrashHandlers, resetCrashHandlersForTest } from "../crash.js";

class ExitSignal extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function stubExit(): { calls: number[]; restore: () => void } {
  const calls: number[] = [];
  const original = process.exit;
  process.exit = ((code?: number) => {
    calls.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  return {
    calls,
    restore: () => {
      process.exit = original;
    },
  };
}

function stubStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    writes,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

/** Installs handlers and returns just the listener installCrashHandlers added, without invoking any pre-existing ones. */
function installAndCapture(
  event: "uncaughtException" | "unhandledRejection",
  opts: Parameters<typeof installCrashHandlers>[0]
): (err: unknown) => void {
  const listenersFor = (e: string): unknown[] => process.listeners(e as NodeJS.Signals);
  const before = listenersFor(event);
  installCrashHandlers(opts);
  const added = listenersFor(event).filter((l) => !before.includes(l));
  assert.equal(added.length, 1, `installCrashHandlers should add exactly one ${event} listener`);
  return added[0] as (err: unknown) => void;
}

test("installCrashHandlers is idempotent: a second call adds no further listeners", () => {
  resetCrashHandlersForTest();
  const beforeExc = process.listeners("uncaughtException").length;
  const beforeRej = process.listeners("unhandledRejection").length;
  try {
    installCrashHandlers({ cleanup: () => {} });
    installCrashHandlers({ cleanup: () => {} });
    assert.equal(process.listeners("uncaughtException").length, beforeExc + 1);
    assert.equal(process.listeners("unhandledRejection").length, beforeRej + 1);
  } finally {
    const exc = process.listeners("uncaughtException");
    const rej = process.listeners("unhandledRejection");
    process.removeListener("uncaughtException", exc[exc.length - 1] as never);
    process.removeListener("unhandledRejection", rej[rej.length - 1] as never);
    resetCrashHandlersForTest();
  }
});

test("the crash handler runs unmountUi and cleanup, reports the error, and exits 1", () => {
  resetCrashHandlersForTest();
  const calls: string[] = [];
  const handler = installAndCapture("uncaughtException", {
    cleanup: () => calls.push("cleanup"),
    unmountUi: () => calls.push("unmountUi"),
    details: () => ["Transcript: /tmp/session.json"],
  });
  const exit = stubExit();
  const stderr = stubStderr();
  try {
    assert.throws(() => handler(new Error("boom")), ExitSignal);
    assert.deepEqual(calls, ["unmountUi", "cleanup"]);
    assert.deepEqual(exit.calls, [1]);
    const report = stderr.writes.join("");
    assert.match(report, /kritya crashed \(uncaught exception\)/);
    assert.match(report, /boom/);
    assert.match(report, /Transcript: \/tmp\/session\.json/);
    assert.match(report, /This is a bug in kritya/);
  } finally {
    exit.restore();
    stderr.restore();
    process.removeListener("uncaughtException", handler as never);
    resetCrashHandlersForTest();
  }
});

test("the crash handler still reports and exits even when cleanup/unmountUi/details all throw", () => {
  resetCrashHandlersForTest();
  const handler = installAndCapture("unhandledRejection", {
    cleanup: () => {
      throw new Error("cleanup blew up");
    },
    unmountUi: () => {
      throw new Error("unmount blew up");
    },
    details: () => {
      throw new Error("details blew up");
    },
  });
  const exit = stubExit();
  const stderr = stubStderr();
  try {
    assert.throws(() => handler("a rejected reason"), ExitSignal);
    assert.deepEqual(exit.calls, [1]);
    const report = stderr.writes.join("");
    assert.match(report, /kritya crashed \(unhandled rejection\)/);
    assert.match(report, /a rejected reason/);
  } finally {
    exit.restore();
    stderr.restore();
    process.removeListener("unhandledRejection", handler as never);
    resetCrashHandlersForTest();
  }
});

test("a crash raised while already handling one exits immediately without re-running cleanup", () => {
  resetCrashHandlersForTest();
  let cleanupCalls = 0;
  const handler: (err: unknown) => void = installAndCapture("uncaughtException", {
    cleanup: () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        // Simulate a second crash arriving while the first is still being handled.
        assert.throws(() => handler(new Error("nested crash")), ExitSignal);
      }
    },
  });
  const exit = stubExit();
  const stderr = stubStderr();
  try {
    assert.throws(() => handler(new Error("first crash")), ExitSignal);
    assert.equal(cleanupCalls, 1, "the nested crash must not re-enter cleanup");
    assert.deepEqual(exit.calls, [1, 1], "both the nested and outer crash call process.exit(1)");
  } finally {
    exit.restore();
    stderr.restore();
    process.removeListener("uncaughtException", handler as never);
    resetCrashHandlersForTest();
  }
});
