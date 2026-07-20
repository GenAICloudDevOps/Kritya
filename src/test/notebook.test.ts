import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readNotebookTool, editNotebookTool } from "../tools/notebook.js";
import { UndoStack } from "../undo/undo.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-cli-test-"));
}

/** A small notebook: a markdown cell and two code cells, the second with an output. */
function sampleNotebook() {
  return {
    cells: [
      { cell_type: "markdown", source: ["# My Analysis"], metadata: {} },
      { cell_type: "code", source: ["x = 1 + 1"], outputs: [], execution_count: 1, metadata: {} },
      {
        cell_type: "code",
        source: ["print(x)"],
        outputs: [{ output_type: "stream", name: "stdout", text: ["2\n"] }],
        execution_count: 2,
        metadata: {},
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
}

async function writeNb(ws: string, name: string, nb: unknown): Promise<void> {
  await fs.writeFile(path.join(ws, name), JSON.stringify(nb, null, 1) + "\n");
}

async function readNb(ws: string, name: string): Promise<ReturnType<typeof sampleNotebook>> {
  return JSON.parse(await fs.readFile(path.join(ws, name), "utf8"));
}

test("read_notebook shows each cell's index, type, source, and output", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeNb(ws, "nb.ipynb", sampleNotebook());

  const text = await readNotebookTool.execute({ path: "nb.ipynb" }, ctx);
  assert.match(text, /\[0\] markdown/);
  assert.match(text, /# My Analysis/);
  assert.match(text, /\[1\] code \(exec 1\)/);
  assert.match(text, /x = 1 \+ 1/);
  assert.match(text, /\[2\] code \(exec 2\)/);
  assert.match(text, /--- output ---/);
  assert.match(text, /2/);
});

test("read_notebook collapses image outputs to a placeholder", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  const nb = sampleNotebook();
  nb.cells[2].outputs = [
    { output_type: "display_data", data: { "image/png": "iVBORw0KGgoAAAA==" } },
  ] as never;
  await writeNb(ws, "nb.ipynb", nb);

  const text = await readNotebookTool.execute({ path: "nb.ipynb" }, ctx);
  assert.match(text, /\[image\/png output\]/);
  assert.doesNotMatch(text, /iVBORw0KGgo/);
});

test("edit_notebook replace changes source and clears that cell's stale output", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeNb(ws, "nb.ipynb", sampleNotebook());

  await editNotebookTool.execute(
    { path: "nb.ipynb", op: "replace", index: 1, source: "x = 5 + 5" },
    ctx
  );

  const nb = await readNb(ws, "nb.ipynb");
  assert.deepEqual(nb.cells[1].source, ["x = 5 + 5"]);
  assert.deepEqual(nb.cells[1].outputs, []);
  assert.equal(nb.cells[1].execution_count, null);
  // Untouched cells keep their content and outputs.
  assert.deepEqual(nb.cells[0].source, ["# My Analysis"]);
  assert.equal(nb.cells[2].execution_count, 2);
  assert.equal((nb.cells[2].outputs as unknown[]).length, 1);
});

test("edit_notebook insert adds a cell and shifts the rest down", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeNb(ws, "nb.ipynb", sampleNotebook());

  await editNotebookTool.execute(
    { path: "nb.ipynb", op: "insert", index: 2, source: "y = x * 2" },
    ctx
  );

  const nb = await readNb(ws, "nb.ipynb");
  assert.equal(nb.cells.length, 4);
  assert.deepEqual(nb.cells[2].source, ["y = x * 2"]);
  assert.equal(nb.cells[2].cell_type, "code");
  // The former cell 2 is now at index 3, outputs intact.
  assert.deepEqual(nb.cells[3].source, ["print(x)"]);
  assert.equal(nb.cells[3].execution_count, 2);
});

test("edit_notebook insert can append at the end using the cell count", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeNb(ws, "nb.ipynb", sampleNotebook());

  await editNotebookTool.execute(
    { path: "nb.ipynb", op: "insert", index: 3, source: "## End", cell_type: "markdown" },
    ctx
  );

  const nb = await readNb(ws, "nb.ipynb");
  assert.equal(nb.cells.length, 4);
  assert.equal(nb.cells[3].cell_type, "markdown");
});

test("edit_notebook delete removes the cell at the index", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeNb(ws, "nb.ipynb", sampleNotebook());

  await editNotebookTool.execute({ path: "nb.ipynb", op: "delete", index: 0 }, ctx);

  const nb = await readNb(ws, "nb.ipynb");
  assert.equal(nb.cells.length, 2);
  assert.deepEqual(nb.cells[0].source, ["x = 1 + 1"]);
});

test("edit_notebook rejects an out-of-range index", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeNb(ws, "nb.ipynb", sampleNotebook());
  await assert.rejects(() =>
    editNotebookTool.execute({ path: "nb.ipynb", op: "replace", index: 9, source: "z = 0" }, ctx)
  );
});

test("read_notebook rejects a file that isn't valid JSON", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await fs.writeFile(path.join(ws, "bad.ipynb"), "not json");
  await assert.rejects(() => readNotebookTool.execute({ path: "bad.ipynb" }, ctx));
});

test("undo restores a notebook after an edit", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const ctx = { workspace: ws, undo };
  await writeNb(ws, "nb.ipynb", sampleNotebook());
  const original = await fs.readFile(path.join(ws, "nb.ipynb"), "utf8");

  undo.beginTurn();
  await editNotebookTool.execute({ path: "nb.ipynb", op: "delete", index: 0 }, ctx);
  assert.equal((await readNb(ws, "nb.ipynb")).cells.length, 2);

  undo.undo();
  const restored = await fs.readFile(path.join(ws, "nb.ipynb"), "utf8");
  assert.equal(restored, original);
});
