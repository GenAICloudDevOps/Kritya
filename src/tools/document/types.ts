/** A flowed content block used by docx and pdf writers. */
export interface DocBlock {
  type: "heading1" | "heading2" | "heading3" | "paragraph" | "bullet" | "numbered";
  text: string;
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

/** Payload for write_document; only the field matching the target extension is used. */
export interface DocumentContent {
  blocks?: DocBlock[];
  sheets?: XlsxSheet[];
  slides?: PptxSlide[];
}
