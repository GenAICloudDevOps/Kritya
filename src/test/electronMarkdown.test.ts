import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../electron/markdown.js";

test("renderMarkdown escapes raw HTML so model output can't inject markup", () => {
  const html = renderMarkdown("<img src=x onerror=alert(1)>");
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("renderMarkdown renders headings", () => {
  const html = renderMarkdown("# Title\n## Sub");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Sub<\/h2>/);
});

test("renderMarkdown renders bold, italic, and inline code", () => {
  const html = renderMarkdown("**bold** and *italic* and `code`");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("renderMarkdown renders a fenced code block without interpreting its contents", () => {
  const html = renderMarkdown("```\nlet x = 1;\n**not bold**\n```");
  assert.match(html, /<pre><code>/);
  assert.match(html, /let x = 1;/);
  assert.equal(html.includes("<strong>"), false);
});

test("renderMarkdown renders bullet lists", () => {
  const html = renderMarkdown("- one\n- two");
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
});

test("renderMarkdown renders numbered lists", () => {
  const html = renderMarkdown("1. one\n2. two");
  assert.match(html, /<ol>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ol>/);
});

test("renderMarkdown wraps plain paragraphs in <p>", () => {
  const html = renderMarkdown("hello world");
  assert.match(html, /<p>hello world<\/p>/);
});
