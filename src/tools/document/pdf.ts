import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import type { DocBlock } from "./types.js";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";

// Points pdfjs at its own bundled standard-font metrics so it doesn't warn
// about missing font data when a PDF references one of the base 14 fonts.
const STANDARD_FONT_DATA_URL = fileURLToPath(
  new URL("../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)
);

export async function readPdf(buf: Buffer): Promise<string> {
  const doc = await getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? (item as TextItem).str : ""))
      .join(" ");
    pageTexts.push(text);
  }
  await doc.destroy();
  return pageTexts.join("\n\n");
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const LINE_GAP = 4;

const BLOCK_STYLE: Record<DocBlock["type"], { size: number; bold: boolean; prefix: string }> = {
  heading1: { size: 22, bold: true, prefix: "" },
  heading2: { size: 17, bold: true, prefix: "" },
  heading3: { size: 14, bold: true, prefix: "" },
  paragraph: { size: 11, bold: false, prefix: "" },
  bullet: { size: 11, bold: false, prefix: "• " },
  numbered: { size: 11, bold: false, prefix: "" },
};

export async function writePdf(blocks: DocBlock[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  const maxWidth = PAGE_WIDTH - MARGIN * 2;

  let numberedIndex = 0;
  for (const block of blocks) {
    const style = BLOCK_STYLE[block.type];
    const font = style.bold ? bold : regular;
    numberedIndex = block.type === "numbered" ? numberedIndex + 1 : 0;
    const prefix = block.type === "numbered" ? `${numberedIndex}. ` : style.prefix;
    const lines = wrapText(prefix + block.text, font, style.size, maxWidth);

    for (const line of lines) {
      if (y - style.size < MARGIN) {
        page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      page.drawText(line, { x: MARGIN, y: y - style.size, size: style.size, font });
      y -= style.size + LINE_GAP;
    }
    y -= LINE_GAP; // extra space between blocks
  }

  // pdf-lib defaults to compressed object streams (PDF 1.5+), which the
  // bundled pdfjs in pdf-parse (an old release) fails to parse. Plain
  // xref tables keep round-trip reading working.
  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
