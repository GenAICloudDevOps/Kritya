import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { extractSymbols } from "../repomap/symbols.js";
import { buildRepoMap } from "../repomap/repoMap.js";
import { repoMapTool } from "../tools/repoMap.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-repomap-"));
}

test("extractSymbols finds TS classes, functions, arrows, types, and methods", () => {
  const src = [
    "export class Agent {",
    "  async runTurn(text: string): Promise<void> {",
    "    if (text) {",
    "      doThing();",
    "    }",
    "  }",
    "  private helper() {",
    "  }",
    "}",
    "export function fenceExternal(output: string): string {",
    "  return output;",
    "}",
    "export const build = (x: number) => x + 1;",
    "export type Options = { a: number };",
    "export interface Thing {}",
  ].join("\n");
  const syms = extractSymbols(src, "ts", 40).map((s) => s.text);
  assert.ok(syms.includes("export class Agent"));
  assert.ok(syms.some((s) => s.startsWith("async runTurn")));
  assert.ok(syms.includes("private helper()"));
  assert.ok(syms.some((s) => s.startsWith("export function fenceExternal")));
  assert.ok(syms.some((s) => s.startsWith("export const build")));
  assert.ok(syms.some((s) => s.startsWith("export type Options")));
  assert.ok(syms.includes("export interface Thing"));
  // Control-flow lines and plain calls must NOT be picked up as definitions.
  assert.ok(!syms.some((s) => s.startsWith("if")));
  assert.ok(!syms.some((s) => s.includes("doThing")));
});

test("extractSymbols handles Python, Go, and Rust", () => {
  const py = extractSymbols("class Foo:\n    def bar(self):\n        pass\n", "py", 40).map(
    (s) => s.text
  );
  assert.deepEqual(py, ["class Foo", "def bar(self)"]);

  const go = extractSymbols("type Server struct {}\nfunc (s *Server) Run() {}\n", "go", 40).map(
    (s) => s.text
  );
  assert.ok(go.includes("type Server struct"));
  assert.ok(go.some((s) => s.startsWith("func (s *Server) Run")));

  const rs = extractSymbols("pub struct Client;\npub async fn fetch() {}\n", "rs", 40).map(
    (s) => s.text
  );
  assert.ok(rs.includes("pub struct Client"));
  assert.ok(rs.some((s) => s.startsWith("pub async fn fetch")));
});

test("extractSymbols returns nothing for unsupported extensions", () => {
  assert.deepEqual(extractSymbols("hello: world\n", "yaml", 40), []);
  assert.deepEqual(extractSymbols("# Title\n\ntext", "md", 40), []);
});

test("extractSymbols respects the per-file symbol cap", () => {
  const src = Array.from({ length: 10 }, (_, i) => `function f${i}() {}`).join("\n");
  assert.equal(extractSymbols(src, "js", 3).length, 3);
});

test("buildRepoMap renders a ranked skeleton across files", async () => {
  const ws = await makeWorkspace();
  await fs.mkdir(path.join(ws, "src"), { recursive: true });
  await fs.mkdir(path.join(ws, "test"), { recursive: true });
  await fs.writeFile(
    path.join(ws, "src", "index.ts"),
    "export function main() {}\nexport class App {}\n"
  );
  await fs.writeFile(path.join(ws, "test", "app.test.ts"), "export function runAppTests() {}\n");
  await fs.writeFile(path.join(ws, "notes.txt"), "not code");

  const map = await buildRepoMap(ws);
  assert.match(map, /src\/index\.ts/);
  assert.match(map, /export function main/);
  assert.match(map, /export class App/);
  // A non-source file is excluded entirely.
  assert.doesNotMatch(map, /notes\.txt/);
  // The promoted src/ entry point ranks above the demoted test file.
  assert.ok(map.indexOf("src/index.ts") < map.indexOf("test/app.test.ts"));
});

test("buildRepoMap scopes to a subdirectory", async () => {
  const ws = await makeWorkspace();
  await fs.mkdir(path.join(ws, "a"), { recursive: true });
  await fs.mkdir(path.join(ws, "b"), { recursive: true });
  await fs.writeFile(path.join(ws, "a", "one.ts"), "export function one() {}\n");
  await fs.writeFile(path.join(ws, "b", "two.ts"), "export function two() {}\n");

  const map = await buildRepoMap(ws, "a");
  assert.match(map, /one\.ts/);
  assert.doesNotMatch(map, /two\.ts/);
});

test("buildRepoMap honors .krityaignore", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, ".krityaignore"), "ignored/\n");
  await fs.mkdir(path.join(ws, "ignored"), { recursive: true });
  await fs.writeFile(path.join(ws, "keep.ts"), "export function keep() {}\n");
  await fs.writeFile(path.join(ws, "ignored", "skip.ts"), "export function skip() {}\n");

  const map = await buildRepoMap(ws);
  assert.match(map, /keep\.ts/);
  assert.doesNotMatch(map, /skip\.ts/);
});

test("buildRepoMap reports gracefully when there is no mappable code", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "README.md"), "# hi");
  const map = await buildRepoMap(ws);
  assert.match(map, /no source files found|no definitions were extracted/);
});

test("repo_map tool is read-only and delegates to buildRepoMap", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "x.ts"), "export const y = () => 1;\n");
  assert.equal(repoMapTool.requiresPermission, false);
  const out = await repoMapTool.execute({}, { workspace: ws });
  assert.match(out, /x\.ts/);
  assert.match(out, /export const y/);
});
