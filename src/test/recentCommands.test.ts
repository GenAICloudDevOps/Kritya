import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCommandRecency, recordCommandUse } from "../ui/recentCommands.js";
import { buildPaletteItems } from "../ui/palette.js";

/** A scratch store path; the module's `storeFile` parameter is the test seam. */
function scratchStore(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "kritya-recent-")),
    "recent-commands.json"
  );
}

test("recordCommandUse remembers when a command last ran", () => {
  const store = scratchStore();
  recordCommandUse("/clear", store, 1000);
  recordCommandUse("/rename", store, 2000);
  assert.deepEqual(loadCommandRecency(store), { "/clear": 1000, "/rename": 2000 });
});

test("recordCommandUse moves a command to the top when it is used again", () => {
  const store = scratchStore();
  recordCommandUse("/clear", store, 1000);
  recordCommandUse("/rename", store, 2000);
  recordCommandUse("/clear", store, 3000); // used again, now the most recent
  const recency = loadCommandRecency(store);
  assert.equal(recency["/clear"], 3000);
  assert.equal(recency["/rename"], 2000);
});

test("loadCommandRecency tolerates a missing or malformed store", () => {
  const missing = scratchStore();
  assert.deepEqual(loadCommandRecency(missing), {}, "a missing file means nothing recorded yet");

  const malformed = scratchStore();
  fs.mkdirSync(path.dirname(malformed), { recursive: true });
  fs.writeFileSync(malformed, "{ not json");
  assert.deepEqual(loadCommandRecency(malformed), {});

  // Values that are not finite numbers are dropped rather than poisoning a sort.
  const junk = scratchStore();
  fs.writeFileSync(junk, JSON.stringify({ "/clear": "yesterday", "/rename": 5, "/x": null }));
  assert.deepEqual(loadCommandRecency(junk), { "/rename": 5 });
});

test("recordCommandUse is bounded, keeping only the most recent entries", () => {
  const store = scratchStore();
  for (let i = 0; i < 60; i++) recordCommandUse(`/cmd-${i}`, store, i);
  const recency = loadCommandRecency(store);
  assert.equal(Object.keys(recency).length, 40, "the store must not grow without bound");
  // The 40 most recent (i = 20..59) survive; the oldest 20 are dropped.
  assert.equal(recency["/cmd-59"], 59);
  assert.equal(recency["/cmd-20"], 20);
  assert.equal(recency["/cmd-19"], undefined, "the oldest entries must be evicted");
});

test("recordCommandUse degrades silently when the store cannot be written", () => {
  // A recency hint must never fail a command: a path that cannot be created
  // (a file where the directory should be) is swallowed, not thrown.
  const blocker = scratchStore();
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, "not a directory");
  const unwritable = path.join(blocker, "recent-commands.json");
  assert.doesNotThrow(() => recordCommandUse("/clear", unwritable));
});

test("buildPaletteItems floats recently used commands to the top", () => {
  const commands = [
    { name: "/rename", description: "rename this session" },
    { name: "/rewind", description: "rewind to a checkpoint" },
    { name: "/clear", description: "start a fresh conversation" },
  ];
  // No recency: declaration order, which is what a fresh install shows.
  assert.deepEqual(
    buildPaletteItems(commands, [], "").map((i) => i.value),
    ["cmd:/rename", "cmd:/rewind", "cmd:/clear"]
  );

  // /clear was used most recently, so it leads; /rewind next; /rename last.
  const ordered = buildPaletteItems(commands, [], "", {
    "/clear": 3000,
    "/rewind": 2000,
  });
  assert.deepEqual(
    ordered.map((i) => i.value),
    ["cmd:/clear", "cmd:/rewind", "cmd:/rename"],
    "most-recently-used first, never-used last"
  );
});

test("buildPaletteItems keeps declaration order as the tiebreak", () => {
  const commands = [
    { name: "/a", description: "a" },
    { name: "/b", description: "b" },
    { name: "/c", description: "c" },
  ];
  // /a and /c share a timestamp; a stable sort leaves them in declaration
  // order (/a before /c) rather than flipping them arbitrarily.
  const ordered = buildPaletteItems(commands, [], "", { "/a": 5, "/c": 5 });
  assert.deepEqual(
    ordered.map((i) => i.value),
    ["cmd:/a", "cmd:/c", "cmd:/b"]
  );
});

test("buildPaletteItems does not reorder while the user is filtering", () => {
  const commands = [
    { name: "/rename", description: "rename this session" },
    { name: "/rewind", description: "rewind to a checkpoint" },
    { name: "/clear", description: "start a fresh conversation" },
  ];
  // Once a fragment is typed the user is hunting that fragment; reordering
  // under the cursor as matches arrive would be actively unhelpful, so the
  // recency sort is skipped entirely while a filter is present. "rn" is a
  // subsequence of all three (r…n), so this asserts order, not matching.
  const ordered = buildPaletteItems(commands, [], "rn", { "/clear": 9999 });
  assert.deepEqual(
    ordered.map((i) => i.value),
    ["cmd:/rename", "cmd:/rewind", "cmd:/clear"],
    "declaration order is preserved while filtering, even with recency present"
  );
});
