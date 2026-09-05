import { createRequire } from "node:module";
import type { PptxSlide } from "./types.js";
import { loadSafeZip } from "./zipSafety.js";

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
  // .pptx is a zip container; same decompression-bomb exposure as .xlsx/.docx
  // (see zipSafety.ts) — validate declared uncompressed size before reading
  // any entry's content.
  const zip = await loadSafeZip(buf);
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

// Inches, matching pptxgenjs's default 16:9 layout (10 x 5.625).
const SLIDE_WIDTH = 10;
const SLIDE_HEIGHT = 5.625;
const MARGIN_X = 0.5;
const MARGIN_TOP = 0.4;
const MARGIN_BOTTOM = 0.4;
const TITLE_HEIGHT = 0.9;
const BODY_WIDTH = SLIDE_WIDTH - MARGIN_X * 2;

/**
 * Field names models reach for when they mean `bullets`. Anything not listed
 * here used to be dropped without a word, which is how a deck ends up with a
 * title on every slide and nothing else.
 */
const BULLET_ALIASES = ["bullets", "content", "points", "body", "items", "lines", "text"] as const;
const TITLE_ALIASES = ["title", "heading", "header", "name"] as const;

/** Coerce one model-supplied bullet into display text, or null if there's nothing to show. */
function toBulletText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    // Bullets sometimes arrive as {text: "..."} / {label: "..."} run objects.
    for (const key of ["text", "label", "title", "value"]) {
      const inner = (value as Record<string, unknown>)[key];
      if (typeof inner === "string" && inner.trim()) return inner.trim();
    }
  }
  return null;
}

/** Pull a slide's title and bullets out of whatever shape the model sent. */
function normalizeSlide(slide: PptxSlide, index: number): { title?: string; bullets: string[] } {
  const raw = (slide ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object") {
    throw new Error(`write_document: slide ${index + 1} is not an object`);
  }

  let title: string | undefined;
  for (const key of TITLE_ALIASES) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) {
      title = v.trim();
      break;
    }
  }

  const bullets: string[] = [];
  for (const key of BULLET_ALIASES) {
    if (!(key in raw)) continue;
    const v = raw[key];
    // `title` may also be the source of `text`; don't repeat it as a bullet.
    const entries = Array.isArray(v) ? v.flat() : [v];
    for (const entry of entries) {
      const text = toBulletText(entry);
      if (text && text !== title) bullets.push(text);
    }
    if (bullets.length) break;
  }

  if (!title && bullets.length === 0) {
    const keys = Object.keys(raw);
    throw new Error(
      `write_document: slide ${index + 1} has no title or bullets` +
        (keys.length ? ` (got keys: ${keys.join(", ")})` : "") +
        `. Each slide needs "title" and/or "bullets" (an array of strings).`
    );
  }
  return { title, bullets };
}

export async function writePptx(slides: PptxSlide[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  for (const [index, slide] of slides.entries()) {
    const { title, bullets } = normalizeSlide(slide, index);
    const s = pptx.addSlide();

    let y = MARGIN_TOP;
    if (title) {
      // An explicit height matters: with none, pptxgenjs emits cy="0" and
      // renderers other than PowerPoint clip the title away entirely.
      s.addText(title, {
        x: MARGIN_X,
        y,
        w: BODY_WIDTH,
        h: TITLE_HEIGHT,
        valign: "top",
        fontSize: 28,
        bold: true,
        shrinkText: true,
      });
      y += TITLE_HEIGHT + 0.1;
    }

    if (bullets.length) {
      // Claim the rest of the slide rather than a fixed 60% of its height, and
      // let PowerPoint shrink the text so a long list stays on the slide.
      s.addText(
        bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        {
          x: MARGIN_X,
          y,
          w: BODY_WIDTH,
          h: SLIDE_HEIGHT - y - MARGIN_BOTTOM,
          valign: "top",
          fontSize: 18,
          shrinkText: true,
        }
      );
    }

    const notes = (slide as Record<string, unknown>)?.notes;
    if (typeof notes === "string" && notes.trim()) {
      s.addNotes(notes);
    }
  }
  const data = await pptx.write({ outputType: "nodebuffer" });
  return data as Buffer;
}
