import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readDocumentTool, writeDocumentTool } from "../tools/document.js";
import { writePptx } from "../tools/document/pptx.js";
import { UndoStack } from "../undo/undo.js";
import JSZip from "jszip";

/** Geometry and text of every shape on every slide of a .pptx buffer, in EMU. */
async function slideShapes(
  buf: Buffer
): Promise<Array<Array<{ y: number; h: number; texts: string[] }>>> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort();
  const slides = [];
  for (const name of names) {
    const xml = await zip.files[name].async("text");
    slides.push(
      [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => {
        const sp = m[0];
        const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
        const ext = sp.match(/<a:ext cx="(-?\d+)" cy="(-?\d+)"\/>/);
        return {
          y: Number(off?.[2] ?? 0),
          h: Number(ext?.[2] ?? 0),
          texts: [...sp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]),
        };
      })
    );
  }
  return slides;
}

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-cli-test-"));
}

const blocks = [
  { type: "heading1", text: "Report" },
  { type: "paragraph", text: "A test paragraph." },
  { type: "bullet", text: "First point" },
  { type: "numbered", text: "Step one" },
];

test("write_document + read_document round-trip a .docx", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeDocumentTool.execute({ path: "report.docx", content: { blocks } }, ctx);
  const text = await readDocumentTool.execute({ path: "report.docx" }, ctx);
  assert.match(text, /Report/);
  assert.match(text, /A test paragraph\./);
  assert.match(text, /First point/);
});

test("write_document + read_document round-trip an .xlsx", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  const sheets = [
    {
      name: "Sheet1",
      rows: [
        ["a", "b"],
        [1, 2],
      ],
    },
  ];
  await writeDocumentTool.execute({ path: "data.xlsx", content: { sheets } }, ctx);
  const text = await readDocumentTool.execute({ path: "data.xlsx" }, ctx);
  assert.match(text, /Sheet1/);
  assert.match(text, /a\tb/);
  assert.match(text, /1\t2/);
});

test("write_document + read_document round-trip a .pptx", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  const slides = [{ title: "Slide One", bullets: ["point a", "point b"] }];
  await writeDocumentTool.execute({ path: "deck.pptx", content: { slides } }, ctx);
  const text = await readDocumentTool.execute({ path: "deck.pptx" }, ctx);
  assert.match(text, /Slide One/);
  assert.match(text, /point a/);
  assert.match(text, /point b/);
});

test("write_document + read_document round-trip a .pdf", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeDocumentTool.execute({ path: "report.pdf", content: { blocks } }, ctx);
  const text = await readDocumentTool.execute({ path: "report.pdf" }, ctx);
  assert.match(text, /Report/);
  assert.match(text, /A test paragraph\./);
});

test("write_document rejects an unsupported extension", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await assert.rejects(() =>
    writeDocumentTool.execute({ path: "notes.txt", content: { blocks } }, ctx)
  );
});

test("write_document rejects a missing required field for the target extension", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await assert.rejects(() =>
    writeDocumentTool.execute({ path: "data.xlsx", content: { blocks } }, ctx)
  );
});

test("read_document rejects an unsupported extension", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "notes.txt"), "hello");
  const ctx = { workspace: ws };
  await assert.rejects(() => readDocumentTool.execute({ path: "notes.txt" }, ctx));
});

const SLIDE_HEIGHT_EMU = 5143500;

test("pptx text boxes all have a real height", async () => {
  // A box written with no height lands as cy="0"; PowerPoint tolerates that but
  // LibreOffice and Google Slides clip it, so the title reads as missing.
  const slides = await slideShapes(
    await writePptx([{ title: "Q3 Review", bullets: ["a", "b"] }, { title: "Title only" }])
  );
  assert.equal(slides.length, 2);
  for (const shapes of slides) {
    assert.ok(shapes.length > 0, "slide has no shapes");
    for (const shape of shapes) assert.ok(shape.h > 0, `shape height was ${shape.h}`);
  }
});

test("pptx bullet box stays inside the slide, with and without a title", async () => {
  const bullets = Array.from({ length: 12 }, (_, i) => `bullet ${i + 1}`);
  const slides = await slideShapes(
    await writePptx([{ title: "With title", bullets }, { bullets }])
  );
  for (const shapes of slides) {
    for (const shape of shapes) {
      assert.ok(
        shape.y + shape.h <= SLIDE_HEIGHT_EMU,
        `box runs off the slide: y=${shape.y} h=${shape.h}`
      );
    }
  }
});

test("pptx shrinks text to fit rather than overflowing a long bullet list", async () => {
  const buf = await writePptx([
    { title: "Many", bullets: Array.from({ length: 16 }, (_, i) => `bullet number ${i + 1}`) },
  ]);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.files["ppt/slides/slide1.xml"].async("text");
  assert.match(xml, /normAutofit/);
});

test("pptx keeps slide content sent under a common alias for bullets", async () => {
  // Models routinely emit `content`/`points`/`body` instead of `bullets`;
  // dropping those silently is what produced title-only decks.
  for (const key of ["content", "points", "body", "items", "text"]) {
    const slides = await slideShapes(
      await writePptx([{ title: "Agenda", [key]: ["one", "two"] } as never])
    );
    const texts = slides[0].flatMap((s) => s.texts);
    assert.deepEqual(texts, ["Agenda", "one", "two"], `alias "${key}" was dropped`);
  }
});

test("pptx accepts non-string bullet entries instead of crashing", async () => {
  const slides = await slideShapes(
    await writePptx([{ title: "T", bullets: ["plain", { text: "object" }, 42] as never }])
  );
  assert.deepEqual(
    slides[0].flatMap((s) => s.texts),
    ["T", "plain", "object", "42"]
  );
});

test("pptx accepts a lone string of bullets instead of crashing", async () => {
  const slides = await slideShapes(await writePptx([{ title: "T", bullets: "one line" as never }]));
  assert.deepEqual(
    slides[0].flatMap((s) => s.texts),
    ["T", "one line"]
  );
});

test("write_document accepts payloads flattened to the top level", async () => {
  // Models often drop the `content` wrapper and send {path, slides: [...]}.
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["flat.pptx", { slides: [{ title: "Flat", bullets: ["a", "b"] }] }],
    ["flat.docx", { blocks }],
    ["flat.pdf", { blocks }],
    ["flat.xlsx", { sheets: [{ name: "S", rows: [["x", 1]] }] }],
  ];
  for (const [target, payload] of cases) {
    await writeDocumentTool.execute({ path: target, ...payload }, ctx);
    const text = await readDocumentTool.execute({ path: target }, ctx);
    assert.ok(text.trim().length > 0, `${target} came out empty`);
  }
  assert.match(await readDocumentTool.execute({ path: "flat.pptx" }, ctx), /Flat/);
});

test("write_document accepts content sent as a JSON string", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeDocumentTool.execute(
    {
      path: "str.pptx",
      content: JSON.stringify({ slides: [{ title: "Stringified", bullets: ["one"] }] }),
    },
    ctx
  );
  assert.match(await readDocumentTool.execute({ path: "str.pptx" }, ctx), /Stringified/);
});

test("write_document previews a flattened payload", async () => {
  const preview = await writeDocumentTool.preview?.(
    { path: "d.pptx", slides: [{ title: "a" }, { title: "b" }] },
    { workspace: "/tmp" }
  );
  assert.equal(preview, "2 slide(s)");
});

test("write_document names the field it needs when content is for another format", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  // blocks sent to a .pptx: say what arrived and where it belongs.
  await assert.rejects(
    () => writeDocumentTool.execute({ path: "d.pptx", content: { blocks } }, ctx),
    (err: Error) => {
      assert.match(err.message, /"slides"/);
      assert.match(err.message, /Received "blocks"/);
      assert.match(err.message, /docx/);
      return true;
    }
  );
});

test("write_document rejects a slide with no usable content", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await assert.rejects(
    () => writeDocumentTool.execute({ path: "d.pptx", content: { slides: [{}] } }, ctx),
    /slide 1/i
  );
  await assert.rejects(
    () =>
      writeDocumentTool.execute(
        // Speaker notes alone put nothing on the slide itself.
        { path: "d.pptx", content: { slides: [{ title: "ok" }, { notes: "just notes" }] } },
        ctx
      ),
    /slide 2/i
  );
});

test("write_document reports an unknown block type instead of crashing", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  for (const target of ["out.pdf", "out.docx"]) {
    await assert.rejects(
      () =>
        writeDocumentTool.execute(
          { path: target, content: { blocks: [{ type: "quote", text: "hi" }] } },
          ctx
        ),
      /quote/,
      `${target} accepted an unknown block type`
    );
  }
});

test("pdf writes text outside WinAnsi without crashing", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeDocumentTool.execute(
    {
      path: "uni.pdf",
      content: {
        blocks: [
          { type: "heading1", text: "Launch 🚀" },
          { type: "paragraph", text: "日本語 and café — done" },
        ],
      },
    },
    ctx
  );
  const text = await readDocumentTool.execute({ path: "uni.pdf" }, ctx);
  assert.match(text, /Launch/);
  assert.match(text, /café/);
});

test("undo restores a binary document without corrupting it", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const ctx = { workspace: ws, undo };

  // First write establishes a baseline (undo target: file absent).
  await writeDocumentTool.execute({ path: "report.docx", content: { blocks } }, ctx);
  const original = await fs.readFile(path.join(ws, "report.docx"));

  // Second write overwrites it with different content.
  undo.beginTurn();
  await writeDocumentTool.execute(
    { path: "report.docx", content: { blocks: [{ type: "paragraph", text: "Changed." }] } },
    ctx
  );
  const changed = await readDocumentTool.execute({ path: "report.docx" }, ctx);
  assert.match(changed, /Changed\./);

  undo.undo();
  const restored = await fs.readFile(path.join(ws, "report.docx"));
  assert.deepEqual(restored, original);
});
