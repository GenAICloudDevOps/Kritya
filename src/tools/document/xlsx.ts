import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { XlsxSheet, CellEdit, AppliedCellEdit } from "./types.js";

const CELL_REF_RE = /^[A-Za-z]{1,3}[1-9][0-9]*$/;

// exceljs's xlsx loader decompresses every entry of the .xlsx zip with no
// size limit (CVE-2026-78206, unpatched upstream as of this writing) — a
// small file whose declared uncompressed size is huge can exhaust memory
// before exceljs itself ever runs. JSZip.loadAsync only reads the central
// directory (cheap, no inflation), so summing each entry's *declared*
// uncompressed size here rejects a bomb before handing the buffer to exceljs.
const MAX_XLSX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

async function assertSafeXlsxSize(buf: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buf);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    // `_data` is JSZip's internal CompressedObject; there is no public API
    // for a zip entry's declared (pre-inflation) uncompressed size.
    total +=
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (total > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new Error(
        `This .xlsx file's declared uncompressed size exceeds ` +
          `${MAX_XLSX_UNCOMPRESSED_BYTES / (1024 * 1024)}MB and was refused ` +
          `as a likely decompression bomb rather than risk exhausting memory.`
      );
    }
  }
}

export async function readXlsx(buf: Buffer): Promise<string> {
  await assertSafeXlsxSize(buf);
  const workbook = new ExcelJS.Workbook();
  // exceljs's bundled types pin an older @types/node Buffer shape; the
  // runtime accepts any Node Buffer.
  await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    parts.push(`## ${sheet.name}`);
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1).map((v) => cellToString(v));
      parts.push(cells.join("\t"));
    });
    parts.push("");
  });
  return parts.join("\n");
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "text" in (v as Record<string, unknown>)) {
    return String((v as { text: unknown }).text);
  }
  if (typeof v === "object" && "result" in (v as Record<string, unknown>)) {
    return String((v as { result: unknown }).result);
  }
  return String(v);
}

/** Display an existing or new cell value as a short string, including formulas. */
function describeValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "formula" in (v as Record<string, unknown>)) {
    return "=" + String((v as { formula: unknown }).formula);
  }
  return cellToString(v);
}

/** Convert a model-supplied value into what exceljs expects; a leading "=" becomes a formula. */
function toCellValue(value: string | number | boolean | null): ExcelJS.CellValue {
  if (typeof value === "string" && value.startsWith("=")) {
    return { formula: value.slice(1), date1904: false } as ExcelJS.CellFormulaValue;
  }
  return value;
}

// If CSV export via exceljs's `workbook.csv.write()`/`writeBuffer()`/
// `writeFile()` is ever added, string values starting with =, +, -, @, tab,
// or CR must be prefixed with a leading `'` before export (CVE-2026-78209) —
// exceljs does not do this itself, and cell content here can come from
// LLM-generated or user-supplied text, not just trusted input.

/**
 * Change specific cells of an existing workbook in place, preserving every
 * other cell, formula, and sheet. Returns the new file bytes and a record of
 * what changed (old -> new) for the permission preview and result message.
 */
export async function editXlsx(
  buf: Buffer,
  edits: CellEdit[]
): Promise<{ buf: Buffer; applied: AppliedCellEdit[] }> {
  await assertSafeXlsxSize(buf);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const applied: AppliedCellEdit[] = [];
  for (const edit of edits) {
    if (!CELL_REF_RE.test(edit.cell)) {
      throw new Error(`Invalid cell reference "${edit.cell}" (expected A1 notation like "B7")`);
    }
    const ws = edit.sheet ? workbook.getWorksheet(edit.sheet) : workbook.worksheets[0];
    if (!ws) {
      const names = workbook.worksheets.map((w) => w.name).join(", ");
      throw new Error(`Worksheet "${edit.sheet}" not found. Sheets: ${names}`);
    }
    const cell = ws.getCell(edit.cell.toUpperCase());
    const oldValue = describeValue(cell.value);
    cell.value = toCellValue(edit.value);
    applied.push({
      sheet: ws.name,
      cell: edit.cell.toUpperCase(),
      oldValue,
      newValue: describeValue(cell.value),
    });
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return { buf: Buffer.from(arrayBuffer), applied };
}

// If image embedding is ever added here via exceljs's `Workbook.addImage()`,
// never pass a model/user-supplied path straight into `addImage({filename})`
// — resolve it first and verify it stays inside the workspace, the same way
// `resolveSafe` guards file-write paths elsewhere. An unchecked filename lets
// addImage() read and embed an arbitrary file the process can see
// (CVE-2026-78208).
export async function writeXlsx(sheets: XlsxSheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      ws.addRow(row);
    }
  }
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
