import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLastCodeBlock } from "../ui/codeBlock.js";

test("extractLastCodeBlock: returns the only block with its language", () => {
  const md = "Here you go:\n\n```ts\nconst x = 1;\n```\n\nThat's it.";
  assert.deepEqual(extractLastCodeBlock(md), { code: "const x = 1;", lang: "ts" });
});

test("extractLastCodeBlock: the last block wins when there are several", () => {
  const md = "```js\nfirst();\n```\n\ntext between\n\n```bash\necho second\n```\n";
  assert.deepEqual(
    extractLastCodeBlock(md),
    { code: "echo second", lang: "bash" },
    "Ctrl+B copies 'that', meaning the most recent block"
  );
});

test("extractLastCodeBlock: a plain fence has an empty language", () => {
  const md = "```\nplain text\n```";
  assert.deepEqual(extractLastCodeBlock(md), { code: "plain text", lang: "" });
});

test("extractLastCodeBlock: an unterminated fence is not returned partially", () => {
  // Mid-stream output: the opening fence has arrived, the body is still
  // coming. Returning it would copy a half-written snippet, so the previous
  // complete block is what comes back — and if there is none, null.
  assert.equal(extractLastCodeBlock("```ts\nconst x ="), null);
  const withEarlier = "```sh\ncomplete\n```\n\n```ts\nstill writ";
  assert.deepEqual(
    extractLastCodeBlock(withEarlier),
    { code: "complete", lang: "sh" },
    "the last *complete* block, not the dangling opener"
  );
});

test("extractLastCodeBlock: preserves internal blank lines and indentation", () => {
  const code = "function f() {\n  const a = 1;\n\n  return a;\n}";
  const md = "```ts\n" + code + "\n```";
  assert.equal(extractLastCodeBlock(md)!.code, code, "the body is copied verbatim");
});

test("extractLastCodeBlock: handles an indented fence, matching Markdown.tsx", () => {
  // The renderer treats a fence anywhere after leading whitespace as a fence
  // (line.trimStart().startsWith), so the extractor must agree or it would
  // copy different text than the user sees.
  const md = "  ```py\nprint(1)\n  ```";
  assert.deepEqual(extractLastCodeBlock(md), { code: "print(1)", lang: "py" });
});

test("extractLastCodeBlock: no fences is null", () => {
  assert.equal(extractLastCodeBlock("just prose, no code here"), null);
  assert.equal(extractLastCodeBlock(""), null);
});

test("extractLastCodeBlock: an empty block is still a block", () => {
  assert.deepEqual(extractLastCodeBlock("```\n```"), { code: "", lang: "" });
});
