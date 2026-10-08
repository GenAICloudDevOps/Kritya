import assert from "node:assert/strict";
import { test } from "node:test";
import { searchHistory } from "../ui/historySearch.js";

// Callers pass history newest-first (the App reverses its append-order array),
// which is what makes index 0 the entry just typed. This fixture is already in
// that order: the top line was the most recent prompt.
const HISTORY = [
  "npm run build",
  "docker compose ps",
  "git log --oneline",
  "docker compose up -d",
  "git status",
];

test("searchHistory: an empty query returns everything, newest first", () => {
  const matches = searchHistory(HISTORY, "");
  assert.deepEqual(
    matches.map((m) => m.text),
    HISTORY,
    "the whole history, order preserved"
  );
});

test("searchHistory: a fragment filters fuzzily and keeps recency order", () => {
  const matches = searchHistory(HISTORY, "dckr");
  assert.deepEqual(
    matches.map((m) => m.text),
    ["docker compose ps", "docker compose up -d"],
    "the more recent docker command comes first"
  );
});

test("searchHistory: the index points back at the original array position", () => {
  const matches = searchHistory(HISTORY, "compose");
  assert.deepEqual(
    matches.map((m) => m.index),
    [1, 3],
    "index 1 is 'docker compose ps', index 3 is 'docker compose up -d'"
  );
  for (const m of matches) assert.equal(HISTORY[m.index], m.text, "index and text must agree");
});

test("searchHistory: duplicate prompts are collapsed, keeping the newest", () => {
  const matches = searchHistory(["npm test", "git status", "npm test"], "test");
  assert.deepEqual(
    matches.map((m) => m.text),
    ["npm test"],
    "the same prompt typed twice must offer one row"
  );
  assert.equal(matches[0].index, 0, "the newest occurrence wins");
});

test("searchHistory: no match is an empty list, not everything", () => {
  assert.deepEqual(searchHistory(HISTORY, "zzzz-nope"), []);
});

test("searchHistory: matches subsequences, not just substrings", () => {
  // The Ctrl+R prompt is a fuzzy finder like the palette, so "gcf" reaches
  // "git commit --fixup" without the user retyping the whole thing.
  const matches = searchHistory(["git commit --fixup", "git status"], "gcf");
  assert.deepEqual(
    matches.map((m) => m.text),
    ["git commit --fixup"]
  );
});
