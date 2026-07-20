import ExcelJS from "exceljs";
import type { XlsxSheet, CellEdit, AppliedCellEdit } from "./types.js";

const CELL_REF_RE = /^[A-Za-z]{1,3}[1-9][0-9]*$/;

export async function readXlsx(buf: Buffer): Promise<string> {
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

/**
 * Change specific cells of an existing workbook in place, preserving every
 * other cell, formula, and sheet. Returns the new file bytes and a record of
 * what changed (old -> new) for the permission preview and result message.
 */
export async function editXlsx(
  buf: Buffer,
  edits: CellEdit[]
): Promise<{ buf: Buffer; applied: AppliedCellEdit[] }> {
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
