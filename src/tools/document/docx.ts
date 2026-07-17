import mammoth from "mammoth";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { DocBlock } from "./types.js";

export async function readDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

const HEADING_LEVELS: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  heading1: HeadingLevel.HEADING_1,
  heading2: HeadingLevel.HEADING_2,
  heading3: HeadingLevel.HEADING_3,
};

export async function writeDocx(blocks: DocBlock[]): Promise<Buffer> {
  const children = blocks.map((block) => {
    if (block.type in HEADING_LEVELS) {
      return new Paragraph({
        heading: HEADING_LEVELS[block.type],
        children: [new TextRun(block.text)],
      });
    }
    if (block.type === "bullet") {
      return new Paragraph({ bullet: { level: 0 }, children: [new TextRun(block.text)] });
    }
    if (block.type === "numbered") {
      return new Paragraph({
        numbering: { reference: "doc-numbering", level: 0 },
        children: [new TextRun(block.text)],
      });
    }
    return new Paragraph({ children: [new TextRun(block.text)] });
  });

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "doc-numbering",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: "start" }],
        },
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
