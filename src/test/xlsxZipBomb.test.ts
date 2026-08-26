import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { readXlsx } from "../tools/document/xlsx.js";

test("readXlsx refuses a .xlsx whose declared uncompressed size is a decompression bomb", async () => {
  const zip = new JSZip();
  // All-zero data compresses to almost nothing but still declares its real
  // (huge) uncompressed size in the zip's central directory — the same shape
  // as a real decompression bomb, without needing an actually huge file.
  zip.file("bomb.bin", Buffer.alloc(210 * 1024 * 1024));
  const buf = Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

  await assert.rejects(readXlsx(buf), /decompression bomb/);
});
