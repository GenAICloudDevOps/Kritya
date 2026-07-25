import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, degrees, type PDFFont } from "pdf-lib";
import { validateBlocks, type DocBlock, type PdfEdit } from "./types.js";
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

// The base-14 fonts are WinAnsi-encoded, so pdf-lib throws on anything outside
// it (emoji, CJK, Greek, box drawing). Fold the characters that have an obvious
// ASCII equivalent and mark the rest, rather than failing the whole document.
const CHAR_FOLDS: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[‐‑‒–]/g, "-"],
  [/[—―]/g, "—"],
  [/[•‣◦●▪]/g, "•"],
  [/…/g, "..."],
  [/[→⇒]/g, "->"],
  [/[←⇐]/g, "<-"],
  [/[\u00A0\u2002\u2003\u2007\u2009\u202F]/g, " "], // non-breaking and typographic spaces
  // Alternation, not a character class: ZWJ in a class trips no-misleading-character-class.
  [/\u00AD|\u200B|\u200C|\u200D|\uFEFF/g, ""], // soft hyphen and zero-width marks
  [/\t/g, "    "],
];

// WinAnsi: printable Latin-1 plus the named characters in the 0x80-0x9F block.
const WINANSI_OK =
  /[\u0020-\u007E\u00A1-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/;

/** Make one block of text safe for a WinAnsi-encoded standard font. */
function toWinAnsi(text: string): string {
  let out = text.normalize("NFC");
  for (const [pattern, replacement] of CHAR_FOLDS) out = out.replace(pattern, replacement);
  return [...out].map((ch) => (WINANSI_OK.test(ch) ? ch : "?")).join("");
}

export async function writePdf(input: DocBlock[]): Promise<Buffer> {
  const blocks = validateBlocks(input);
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
    const lines = wrapText(toWinAnsi(prefix + block.text), font, style.size, maxWidth);

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

/** Ensure every entry of `pages` (1-based) is a real page in a `count`-page doc. */
function assertPagesInRange(pages: number[], count: number): void {
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 1 || p > count) {
      throw new Error(`Page ${p} is out of range (document has ${count} page(s))`);
    }
  }
}

/**
 * Apply one structural page operation to an existing PDF, preserving its
 * content. PDF text is positioned glyphs with no reflow, so there is no
 * reliable text find/replace — these operations act on whole pages instead.
 * Returns the resulting file bytes and a short human-readable summary.
 */
export async function editPdf(
  buf: Buffer,
  edit: PdfEdit
): Promise<{ buf: Buffer; summary: string }> {
  const doc = await PDFDocument.load(new Uint8Array(buf));
  const count = doc.getPageCount();
  let summary: string;
  let result = doc;

  switch (edit.op) {
    case "delete_pages": {
      assertPagesInRange(edit.pages, count);
      // Remove from the end so earlier indexes stay valid as we go.
      const toRemove = [...new Set(edit.pages)].sort((a, b) => b - a);
      if (toRemove.length >= count) {
        throw new Error("Cannot delete every page — a PDF must keep at least one page");
      }
      for (const p of toRemove) doc.removePage(p - 1);
      summary = `${count} page(s) → ${count - toRemove.length} page(s)`;
      break;
    }
    case "rotate_page": {
      assertPagesInRange([edit.page], count);
      if (edit.degrees % 90 !== 0) {
        throw new Error(`Rotation must be a multiple of 90°, got ${edit.degrees}`);
      }
      const page = doc.getPage(edit.page - 1);
      const next = (((page.getRotation().angle + edit.degrees) % 360) + 360) % 360;
      page.setRotation(degrees(next));
      summary = `Rotated page ${edit.page} to ${next}°`;
      break;
    }
    case "reorder_pages": {
      assertPagesInRange(edit.order, count);
      const unique = new Set(edit.order);
      if (edit.order.length !== count || unique.size !== count) {
        throw new Error(
          `reorder_pages requires each page 1..${count} exactly once, got [${edit.order.join(", ")}]`
        );
      }
      result = await PDFDocument.create();
      const copied = await result.copyPages(
        doc,
        edit.order.map((p) => p - 1)
      );
      for (const page of copied) result.addPage(page);
      summary = `Reordered ${count} pages`;
      break;
    }
    case "extract_pages": {
      assertPagesInRange(edit.pages, count);
      if (edit.pages.length === 0) throw new Error("extract_pages requires at least one page");
      result = await PDFDocument.create();
      const copied = await result.copyPages(
        doc,
        edit.pages.map((p) => p - 1)
      );
      for (const page of copied) result.addPage(page);
      summary = `Extracted ${edit.pages.length} page(s)`;
      break;
    }
    default:
      throw new Error(`Unknown PDF op "${(edit as { op: string }).op}"`);
  }

  // Match writePdf: plain xref tables keep the bundled reader able to re-read the file.
  const bytes = await result.save({ useObjectStreams: false });
  return { buf: Buffer.from(bytes), summary };
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
