import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readDocumentTool, writeDocumentTool } from "../tools/document.js";
import { UndoStack } from "../undo/undo.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-cli-test-"));
}

const blocks = [
  { type: "heading1", text: "Report" },
  { type: "paragraph", text: "A test paragraph." },
  { type: "bullet", text: "First point" },
  { type: "numbered", text: "Step one" },
];

test("write_document + read_document round-trip a .docx", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeDocumentTool.execute({ path: "report.docx", content: { blocks } }, ctx);
  const text = await readDocumentTool.execute({ path: "report.docx" }, ctx);
  assert.match(text, /Report/);
  assert.match(text, /A test paragraph\./);
  assert.match(text, /First point/);
});

test("write_document + read_document round-trip an .xlsx", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  const sheets = [
    {
      name: "Sheet1",
      rows: [
        ["a", "b"],
        [1, 2],
      ],
    },
  ];
  await writeDocumentTool.execute({ path: "data.xlsx", content: { sheets } }, ctx);
  const text = await readDocumentTool.execute({ path: "data.xlsx" }, ctx);
  assert.match(text, /Sheet1/);
  assert.match(text, /a\tb/);
  assert.match(text, /1\t2/);
});

test("write_document + read_document round-trip a .pptx", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  const slides = [{ title: "Slide One", bullets: ["point a", "point b"] }];
  await writeDocumentTool.execute({ path: "deck.pptx", content: { slides } }, ctx);
  const text = await readDocumentTool.execute({ path: "deck.pptx" }, ctx);
  assert.match(text, /Slide One/);
  assert.match(text, /point a/);
  assert.match(text, /point b/);
});

test("write_document + read_document round-trip a .pdf", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeDocumentTool.execute({ path: "report.pdf", content: { blocks } }, ctx);
  const text = await readDocumentTool.execute({ path: "report.pdf" }, ctx);
  assert.match(text, /Report/);
  assert.match(text, /A test paragraph\./);
});

test("write_document rejects an unsupported extension", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await assert.rejects(() =>
    writeDocumentTool.execute({ path: "notes.txt", content: { blocks } }, ctx)
  );
});

test("write_document rejects a missing required field for the target extension", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await assert.rejects(() =>
    writeDocumentTool.execute({ path: "data.xlsx", content: { blocks } }, ctx)
  );
});

test("read_document rejects an unsupported extension", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "notes.txt"), "hello");
  const ctx = { workspace: ws };
  await assert.rejects(() => readDocumentTool.execute({ path: "notes.txt" }, ctx));
});

test("undo restores a binary document without corrupting it", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const ctx = { workspace: ws, undo };

  // First write establishes a baseline (undo target: file absent).
  await writeDocumentTool.execute({ path: "report.docx", content: { blocks } }, ctx);
  const original = await fs.readFile(path.join(ws, "report.docx"));

  // Second write overwrites it with different content.
  undo.beginTurn();
  await writeDocumentTool.execute(
    { path: "report.docx", content: { blocks: [{ type: "paragraph", text: "Changed." }] } },
    ctx
  );
  const changed = await readDocumentTool.execute({ path: "report.docx" }, ctx);
  assert.match(changed, /Changed\./);

  undo.undo();
  const restored = await fs.readFile(path.join(ws, "report.docx"));
  assert.deepEqual(restored, original);
});
