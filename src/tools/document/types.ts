export const BLOCK_TYPES = [
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bullet",
  "numbered",
] as const;

/** A flowed content block used by docx and pdf writers. */
export interface DocBlock {
  type: (typeof BLOCK_TYPES)[number];
  text: string;
}

/**
 * Check every block before any writer indexes a style table with `block.type`.
 * Models do stray outside the schema enum, and without this the docx writer
 * silently demotes the block to a plain paragraph while the pdf writer dies
 * with an unrelated "cannot read properties of undefined".
 */
export function validateBlocks(blocks: DocBlock[]): DocBlock[] {
  return blocks.map((block, i) => {
    if (!block || typeof block !== "object") {
      throw new Error(`write_document: block ${i + 1} is not an object`);
    }
    if (!(BLOCK_TYPES as readonly string[]).includes(block.type)) {
      throw new Error(
        `write_document: block ${i + 1} has unknown type "${block.type}". ` +
          `Valid types: ${BLOCK_TYPES.join(", ")}`
      );
    }
    return { type: block.type, text: block.text == null ? "" : String(block.text) };
  });
}

export interface XlsxSheet {
  name: string;
  rows: Array<Array<string | number | boolean | null>>;
}

/** One requested cell change for edit_spreadsheet. */
export interface CellEdit {
  /** Sheet name; defaults to the first worksheet when omitted. */
  sheet?: string;
  /** Cell in A1 notation, e.g. "B7". */
  cell: string;
  /** New value; a string beginning with "=" is stored as a formula. */
  value: string | number | boolean | null;
}

/** Record of one applied cell change, for the preview and result message. */
export interface AppliedCellEdit {
  sheet: string;
  cell: string;
  oldValue: string;
  newValue: string;
}

export interface PptxSlide {
  title?: string;
  bullets?: string[];
  notes?: string;
}

/** One structural page operation for edit_pdf. Page numbers are 1-based. */
export type PdfEdit =
  | { op: "delete_pages"; pages: number[] }
  | { op: "rotate_page"; page: number; degrees: number }
  | { op: "reorder_pages"; order: number[] }
  | { op: "extract_pages"; pages: number[] };

/** Payload for write_document; only the field matching the target extension is used. */
export interface DocumentContent {
  blocks?: DocBlock[];
  sheets?: XlsxSheet[];
  slides?: PptxSlide[];
}
