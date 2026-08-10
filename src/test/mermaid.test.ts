import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMermaidTree, renderMermaidTree } from "../ui/mermaid.js";

test("parses a simple labeled chain into a tree", () => {
  const tree = parseMermaidTree([
    "graph TD",
    "Cosmos[Cosmos (Universe)] --> SolarSystem[Solar System]",
    "SolarSystem --> Earth[Earth]",
    "Earth --> India[India]",
  ]);
  assert.ok(tree);
  assert.deepEqual(renderMermaidTree(tree!), [
    "Cosmos (Universe)",
    "└─ Solar System",
    "   └─ Earth",
    "      └─ India",
  ]);
});

test("renders branches with box-drawing characters", () => {
  const tree = parseMermaidTree(["graph TD", "A[Solar System] --> B[Earth]", "A --> C[Mars]"]);
  assert.ok(tree);
  assert.deepEqual(renderMermaidTree(tree!), ["Solar System", "├─ Earth", "└─ Mars"]);
});

test("returns null without a graph/flowchart header", () => {
  assert.equal(parseMermaidTree(["A --> B"]), null);
});

test("returns null for a node with multiple parents", () => {
  const tree = parseMermaidTree(["graph TD", "A --> C", "B --> C"]);
  assert.equal(tree, null);
});

test("returns null for a cycle", () => {
  const tree = parseMermaidTree(["graph TD", "A --> B", "B --> A"]);
  assert.equal(tree, null);
});

test("returns null for lines outside the supported edge-list subset", () => {
  const tree = parseMermaidTree(["graph TD", "A --> B", "subgraph X", "end"]);
  assert.equal(tree, null);
});

test("returns null for an empty body", () => {
  assert.equal(parseMermaidTree([]), null);
});
