import { createRequire } from "node:module";
import JSZip from "jszip";
import type { PptxSlide } from "./types.js";

interface PptxGenSlide {
  addText(
    text: string | Array<{ text: string; options?: Record<string, unknown> }>,
    opts: Record<string, unknown>
  ): void;
  addNotes(notes: string): void;
}

interface PptxGen {
  addSlide(): PptxGenSlide;
  write(props: { outputType: "nodebuffer" }): Promise<Buffer>;
}

// pptxgenjs is CommonJS-only and its bundled types don't resolve cleanly
// under NodeNext + esModuleInterop (the default import type-checks as the
// module namespace, not the constructor). Load it via require and type the
// handful of methods this module actually calls.
const require = createRequire(import.meta.url);
const PptxGenJS = require("pptxgenjs") as new () => PptxGen;

// Matches text runs inside slide XML, e.g. <a:t>Hello</a:t>.
const TEXT_RUN_RE = /<a:t>([^<]*)<\/a:t>/g;

export async function readPptx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const parts: string[] = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async("text");
    const texts = [...xml.matchAll(TEXT_RUN_RE)].map((m) => decodeXmlEntities(m[1]));
    parts.push(`## Slide ${slideNumber(name)}`);
    parts.push(texts.join("\n"));
    parts.push("");
  }
  return parts.join("\n");
}

function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function writePptx(slides: PptxSlide[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  for (const slide of slides) {
    const s = pptx.addSlide();
    let y = 0.4;
    if (slide.title) {
      s.addText(slide.title, { x: 0.5, y, w: "90%", fontSize: 28, bold: true });
      y += 1.0;
    }
    if (slide.bullets?.length) {
      s.addText(
        slide.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y, w: "90%", h: "60%", fontSize: 18 }
      );
    }
    if (slide.notes) {
      s.addNotes(slide.notes);
    }
  }
  const data = await pptx.write({ outputType: "nodebuffer" });
  return data as Buffer;
}
