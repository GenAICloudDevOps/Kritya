import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UndoStack } from "../undo/undo.js";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-undo-test-"));
}

test("undo restores the state the turn started from, not an intermediate one", () => {
  // A turn that edits the same file twice (an edit, then a fix-up) is ordinary.
  // Both writes are snapshotted, so the turn holds two entries for one file:
  // only the first records what the turn started from.
  const ws = workspace();
  const file = path.join(ws, "math.js");
  fs.writeFileSync(file, "ORIGINAL\n");

  const undo = new UndoStack();
  undo.beginTurn();
  undo.snapshot(file, "math.js");
  fs.writeFileSync(file, "FIRST\n");
  undo.snapshot(file, "math.js");
  fs.writeFileSync(file, "SECOND\n");

  undo.undo();
  assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL\n");
  undo.closeAll();
});

test("redo reapplies the turn's final state, not an intermediate one", () => {
  // Redoing used to walk the same file twice and finish on whichever entry
  // came last, silently discarding the turn's real result.
  const ws = workspace();
  const file = path.join(ws, "math.js");
  fs.writeFileSync(file, "ORIGINAL\n");

  const undo = new UndoStack();
  undo.beginTurn();
  undo.snapshot(file, "math.js");
  fs.writeFileSync(file, "FIRST\n");
  undo.snapshot(file, "math.js");
  fs.writeFileSync(file, "SECOND\n");

  undo.undo();
  undo.redo();
  assert.equal(fs.readFileSync(file, "utf8"), "SECOND\n");
  undo.closeAll();
});

test("undo counts each file once however many times the turn wrote it", () => {
  const ws = workspace();
  const file = path.join(ws, "math.js");
  fs.writeFileSync(file, "ORIGINAL\n");

  const undo = new UndoStack();
  undo.beginTurn();
  undo.snapshot(file, "math.js");
  fs.writeFileSync(file, "FIRST\n");
  undo.snapshot(file, "math.js");
  fs.writeFileSync(file, "SECOND\n");

  // One file changed, so the summary is the single-file form — not "2 files".
  assert.equal(undo.undo(), "Restored math.js");
  undo.closeAll();
});

test("a file created and then rewritten in one turn is removed by undo", () => {
  const ws = workspace();
  const file = path.join(ws, "new.js");

  const undo = new UndoStack();
  undo.beginTurn();
  undo.snapshot(file, "new.js"); // file does not exist yet
  fs.writeFileSync(file, "v1\n");
  undo.snapshot(file, "new.js");
  fs.writeFileSync(file, "v2\n");

  undo.undo();
  assert.equal(fs.existsSync(file), false, "undo should remove a file the turn created");
  undo.redo();
  assert.equal(fs.readFileSync(file, "utf8"), "v2\n");
  undo.closeAll();
});

test("a turn touching several files still restores and reapplies all of them", () => {
  const ws = workspace();
  const a = path.join(ws, "a.js");
  const b = path.join(ws, "b.js");
  fs.writeFileSync(a, "a0\n");
  fs.writeFileSync(b, "b0\n");

  const undo = new UndoStack();
  undo.beginTurn();
  undo.snapshot(a, "a.js");
  fs.writeFileSync(a, "a1\n");
  undo.snapshot(b, "b.js");
  fs.writeFileSync(b, "b1\n");
  undo.snapshot(a, "a.js");
  fs.writeFileSync(a, "a2\n");

  const summary = undo.undo();
  assert.match(String(summary), /2 files/);
  assert.equal(fs.readFileSync(a, "utf8"), "a0\n");
  assert.equal(fs.readFileSync(b, "utf8"), "b0\n");

  undo.redo();
  assert.equal(fs.readFileSync(a, "utf8"), "a2\n");
  assert.equal(fs.readFileSync(b, "utf8"), "b1\n");
  undo.closeAll();
});

test("rewind rolls every turn back to the checkpoint", () => {
  const ws = workspace();
  const file = path.join(ws, "m.js");
  fs.writeFileSync(file, "v0\n");

  const undo = new UndoStack();
  undo.beginTurn();
  const mark = undo.currentTurn();
  undo.snapshot(file, "m.js");
  fs.writeFileSync(file, "v1\n");
  undo.beginTurn();
  undo.snapshot(file, "m.js");
  fs.writeFileSync(file, "v2\n");

  undo.rewindTo(mark);
  assert.equal(fs.readFileSync(file, "utf8"), "v1\n");
  undo.closeAll();
});
