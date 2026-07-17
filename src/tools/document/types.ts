/** A flowed content block used by docx and pdf writers. */
export interface DocBlock {
  type: "heading1" | "heading2" | "heading3" | "paragraph" | "bullet" | "numbered";
  text: string;
}

export interface XlsxSheet {
  name: string;
  rows: Array<Array<string | number | boolean | null>>;
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
