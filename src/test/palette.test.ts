import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPaletteItems, fuzzyMatch } from "../ui/palette.js";

test("fuzzyMatch matches subsequences, case-insensitively", () => {
  assert.ok(fuzzyMatch("/rewind", "rwd"));
  assert.ok(fuzzyMatch("/export", "EXPT"));
  assert.ok(fuzzyMatch("/rename", ""));
  assert.ok(fuzzyMatch("rename this session", "rnm"));
  assert.ok(!fuzzyMatch("/rename", "mre"), "order matters");
  assert.ok(!fuzzyMatch("/clear", "z"));
});

test("buildPaletteItems lists commands first, then checkpoints, filtered fuzzily", () => {
  const commands = [
    { name: "/rename", description: "rename this session" },
    { name: "/rewind", description: "rewind to a checkpoint" },
    { name: "/clear", description: "start a fresh conversation" },
  ];
  const checkpoints = [
    { name: "before-refactor", historyLength: 10, undoTurn: 2, createdAt: 1000 },
    { name: "green-tests", historyLength: 20, undoTurn: 4, createdAt: 2000 },
  ];

  const all = buildPaletteItems(commands, checkpoints, "");
  assert.deepEqual(
    all.map((i) => i.value),
    [
      "cmd:/rename",
      "cmd:/rewind",
      "cmd:/clear",
      "checkpoint:before-refactor",
      "checkpoint:green-tests",
    ]
  );

  const filtered = buildPaletteItems(commands, checkpoints, "rwd");
  assert.deepEqual(
    filtered.map((i) => i.value),
    ["cmd:/rewind"],
    "only the fuzzy-matching command survives"
  );

  const cps = buildPaletteItems(commands, checkpoints, "grn");
  assert.deepEqual(
    cps.map((i) => i.value),
    ["checkpoint:green-tests"],
    "checkpoints are searchable by name"
  );

  const none = buildPaletteItems(commands, checkpoints, "zzz-no-match");
  assert.deepEqual(none, []);
});
