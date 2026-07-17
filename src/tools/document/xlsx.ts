import ExcelJS from "exceljs";
import type { XlsxSheet } from "./types.js";

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
