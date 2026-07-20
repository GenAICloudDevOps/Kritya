import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { readDocumentTool, editPdfTool } from "../tools/document.js";
import { UndoStack } from "../undo/undo.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-cli-test-"));
}

/** Write a PDF with `n` pages, each printing "Page k" so order is checkable. */
async function makePdf(ws: string, name: string, n: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`Page ${i}`, { x: 20, y: 100, size: 20, font });
  }
  const bytes = await doc.save({ useObjectStreams: false });
  await fs.writeFile(path.join(ws, name), bytes);
}

async function pageCount(ws: string, name: string): Promise<number> {
  const buf = await fs.readFile(path.join(ws, name));
  const doc = await PDFDocument.load(new Uint8Array(buf));
  return doc.getPageCount();
}

test("edit_pdf delete_pages removes the given page", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await makePdf(ws, "doc.pdf", 3);

  const result = await editPdfTool.execute(
    { path: "doc.pdf", op: "delete_pages", pages: [2] },
    ctx
  );
  assert.match(result, /3 page\(s\) → 2 page\(s\)/);
  assert.equal(await pageCount(ws, "doc.pdf"), 2);

  const text = await readDocumentTool.execute({ path: "doc.pdf" }, ctx);
  assert.match(text, /Page 1/);
  assert.match(text, /Page 3/);
  assert.doesNotMatch(text, /Page 2/);
});

test("edit_pdf reorder_pages rearranges pages", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await makePdf(ws, "doc.pdf", 3);

  await editPdfTool.execute({ path: "doc.pdf", op: "reorder_pages", order: [3, 1, 2] }, ctx);
  assert.equal(await pageCount(ws, "doc.pdf"), 3);

  const text = await readDocumentTool.execute({ path: "doc.pdf" }, ctx);
  // First page of the reordered file should now be the old page 3.
  assert.ok(text.indexOf("Page 3") < text.indexOf("Page 1"));
});

test("edit_pdf rotate_page sets the page angle", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await makePdf(ws, "doc.pdf", 2);

  await editPdfTool.execute({ path: "doc.pdf", op: "rotate_page", page: 1, degrees: 90 }, ctx);

  const buf = await fs.readFile(path.join(ws, "doc.pdf"));
  const doc = await PDFDocument.load(new Uint8Array(buf));
  assert.equal(doc.getPage(0).getRotation().angle, 90);
  assert.equal(doc.getPage(1).getRotation().angle, 0);
});

test("edit_pdf extract_pages writes a new file and leaves the source unchanged", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await makePdf(ws, "doc.pdf", 4);

  const result = await editPdfTool.execute(
    { path: "doc.pdf", op: "extract_pages", pages: [1, 3], out_path: "subset.pdf" },
    ctx
  );
  assert.match(result, /subset\.pdf/);
  assert.equal(await pageCount(ws, "subset.pdf"), 2);
  assert.equal(await pageCount(ws, "doc.pdf"), 4); // source untouched

  const text = await readDocumentTool.execute({ path: "subset.pdf" }, ctx);
  assert.match(text, /Page 1/);
  assert.match(text, /Page 3/);
  assert.doesNotMatch(text, /Page 2/);
});

test("edit_pdf rejects an out-of-range page", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await makePdf(ws, "doc.pdf", 2);
  await assert.rejects(() =>
    editPdfTool.execute({ path: "doc.pdf", op: "delete_pages", pages: [9] }, ctx)
  );
});

test("edit_pdf refuses to delete every page", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await makePdf(ws, "doc.pdf", 2);
  await assert.rejects(() =>
    editPdfTool.execute({ path: "doc.pdf", op: "delete_pages", pages: [1, 2] }, ctx)
  );
});

test("edit_pdf reorder_pages rejects an incomplete permutation", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await makePdf(ws, "doc.pdf", 3);
  await assert.rejects(() =>
    editPdfTool.execute({ path: "doc.pdf", op: "reorder_pages", order: [1, 2] }, ctx)
  );
});

test("edit_pdf rejects a non-.pdf file", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await fs.writeFile(path.join(ws, "notes.txt"), "hi");
  await assert.rejects(() =>
    editPdfTool.execute({ path: "notes.txt", op: "delete_pages", pages: [1] }, ctx)
  );
});

test("undo restores a PDF after a delete", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const ctx = { workspace: ws, undo };
  await makePdf(ws, "doc.pdf", 3);
  const original = await fs.readFile(path.join(ws, "doc.pdf"));

  undo.beginTurn();
  await editPdfTool.execute({ path: "doc.pdf", op: "delete_pages", pages: [2] }, ctx);
  assert.equal(await pageCount(ws, "doc.pdf"), 2);

  undo.undo();
  const restored = await fs.readFile(path.join(ws, "doc.pdf"));
  assert.deepEqual(restored, original);
});
