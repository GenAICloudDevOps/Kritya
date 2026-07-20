import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readDocumentTool, writeDocumentTool, editSpreadsheetTool } from "../tools/document.js";
import { UndoStack } from "../undo/undo.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-cli-test-"));
}

/** Build a two-sheet workbook to edit. */
async function seedWorkbook(ws: string): Promise<void> {
  const ctx = { workspace: ws };
  const sheets = [
    {
      name: "Budget",
      rows: [
        ["Item", "Q2", "Q3"],
        ["Sales", 100, 200],
        ["Costs", 50, 75],
      ],
    },
    { name: "Notes", rows: [["keep", "me"]] },
  ];
  await writeDocumentTool.execute({ path: "book.xlsx", content: { sheets } }, ctx);
}

test("edit_spreadsheet changes one cell and leaves the rest intact", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await seedWorkbook(ws);

  const result = await editSpreadsheetTool.execute(
    { path: "book.xlsx", edits: [{ sheet: "Budget", cell: "B2", value: 999 }] },
    ctx
  );
  assert.match(result, /Budget!B2=999/);

  const text = await readDocumentTool.execute({ path: "book.xlsx" }, ctx);
  assert.match(text, /999/); // changed cell
  assert.match(text, /Costs\t50\t75/); // untouched row survives
  assert.match(text, /keep\tme/); // untouched second sheet survives
});

test("edit_spreadsheet applies multiple edits in one call", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await seedWorkbook(ws);

  await editSpreadsheetTool.execute(
    {
      path: "book.xlsx",
      edits: [
        { sheet: "Budget", cell: "B2", value: 111 },
        { sheet: "Budget", cell: "C2", value: 222 },
      ],
    },
    ctx
  );

  const text = await readDocumentTool.execute({ path: "book.xlsx" }, ctx);
  assert.match(text, /111\t222/);
});

test("edit_spreadsheet defaults to the first sheet when none is given", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await seedWorkbook(ws);

  await editSpreadsheetTool.execute(
    { path: "book.xlsx", edits: [{ cell: "A1", value: "Changed" }] },
    ctx
  );

  const text = await readDocumentTool.execute({ path: "book.xlsx" }, ctx);
  assert.match(text, /Changed/);
});

test("edit_spreadsheet stores a leading-= value as a formula", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await seedWorkbook(ws);

  await editSpreadsheetTool.execute(
    { path: "book.xlsx", edits: [{ sheet: "Budget", cell: "B4", value: "=B2+B3" }] },
    ctx
  );

  // Re-read via exceljs to confirm the cell holds a formula, not a literal string.
  const buf = await fs.readFile(path.join(ws, "book.xlsx"));
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const cell = wb.getWorksheet("Budget")!.getCell("B4");
  assert.equal((cell.value as { formula: string }).formula, "B2+B3");
});

test("edit_spreadsheet preview shows old -> new for each cell", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await seedWorkbook(ws);

  const preview = await editSpreadsheetTool.preview!(
    { path: "book.xlsx", edits: [{ sheet: "Budget", cell: "B2", value: 999 }] },
    ctx
  );
  assert.match(String(preview), /Budget!B2:\s+100\s+→\s+999/);
});

test("edit_spreadsheet rejects an invalid cell reference", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await seedWorkbook(ws);
  await assert.rejects(() =>
    editSpreadsheetTool.execute(
      { path: "book.xlsx", edits: [{ cell: "not-a-cell", value: 1 }] },
      ctx
    )
  );
});

test("edit_spreadsheet rejects an unknown sheet name", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await seedWorkbook(ws);
  await assert.rejects(() =>
    editSpreadsheetTool.execute(
      { path: "book.xlsx", edits: [{ sheet: "Nope", cell: "A1", value: 1 }] },
      ctx
    )
  );
});

test("edit_spreadsheet rejects a non-.xlsx file", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await fs.writeFile(path.join(ws, "data.csv"), "a,b\n1,2\n");
  await assert.rejects(() =>
    editSpreadsheetTool.execute({ path: "data.csv", edits: [{ cell: "A1", value: 1 }] }, ctx)
  );
});

test("undo restores a spreadsheet after an edit", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const ctx = { workspace: ws, undo };
  await seedWorkbook(ws);
  const original = await fs.readFile(path.join(ws, "book.xlsx"));

  undo.beginTurn();
  await editSpreadsheetTool.execute(
    { path: "book.xlsx", edits: [{ sheet: "Budget", cell: "B2", value: 999 }] },
    ctx
  );
  const changed = await readDocumentTool.execute({ path: "book.xlsx" }, ctx);
  assert.match(changed, /999/);

  undo.undo();
  const restored = await fs.readFile(path.join(ws, "book.xlsx"));
  assert.deepEqual(restored, original);
});
