import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import JSZip from "jszip";
import { readDocx } from "../tools/document/docx.js";
import { readPptx } from "../tools/document/pptx.js";

function bombZip(): Promise<Buffer> {
  const zip = new JSZip();
  // All-zero data compresses to almost nothing but still declares its real
  // (huge) uncompressed size in the zip's central directory — same trick as
  // xlsxZipBomb.test.ts, without needing an actually huge file on disk.
  zip.file("bomb.bin", Buffer.alloc(210 * 1024 * 1024));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }).then(Buffer.from);
}

test("readDocx refuses a .docx whose declared uncompressed size is a decompression bomb", async () => {
  const buf = await bombZip();
  await assert.rejects(readDocx(buf), /decompression bomb/);
});

test("readPptx refuses a .pptx whose declared uncompressed size is a decompression bomb", async () => {
  const buf = await bombZip();
  await assert.rejects(readPptx(buf), /decompression bomb/);
});

async function makeSparseFile(bytes: number, ext: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-doclimit-"));
  const file = path.join(dir, `big${ext}`);
  const handle = await fs.open(file, "w");
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
  return file;
}

test("read_document refuses a file over its size limit before parsing it", async () => {
  const { readDocumentTool } = await import("../tools/document.js");
  const file = await makeSparseFile(201 * 1024 * 1024, ".docx");
  const ws = path.dirname(file);
  await assert.rejects(
    readDocumentTool.execute({ path: path.basename(file) }, { workspace: ws }),
    /over the 200MB limit/
  );
});

test("read_notebook refuses a .ipynb file over its size limit before parsing it", async () => {
  const { readNotebookTool } = await import("../tools/notebook.js");
  const file = await makeSparseFile(51 * 1024 * 1024, ".ipynb");
  const ws = path.dirname(file);
  await assert.rejects(
    readNotebookTool.execute({ path: path.basename(file) }, { workspace: ws }),
    /over the 50MB limit/
  );
});
