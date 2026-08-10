/**
 * Minimal mermaid flowchart parser, scoped to what an LLM typically emits for
 * a hierarchy explanation: `graph TD` / `graph LR` / `flowchart TD` with
 * `id --> id2` or `id[Label] --> id2[Label2]` edges. Anything that isn't a
 * single-rooted tree (multiple parents, cycles, unparsable lines) returns
 * null so the caller can fall back to rendering the raw code block.
 */

export interface MermaidTreeNode {
  id: string;
  label: string;
  children: MermaidTreeNode[];
}

const HEADER_RE = /^\s*(graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*$/i;
// id, or id[Label] / id(Label) / id{Label} / id((Label)) — brackets are
// stripped, not matched by shape, since we only render text. Each bracket
// type is matched separately (rather than a shared character class) so a
// label containing the other kind of bracket, e.g. `[Cosmos (Universe)]`,
// isn't cut short at its first inner paren.
const NODE_RE = /^([A-Za-z0-9_-]+)(?:\[(.*)\]|\((.*)\)|\{(.*)\})?$/;
const EDGE_RE = /^(.+?)\s*(?:-->|---|-\.->|==>)\s*(.+)$/;

function parseNode(raw: string): { id: string; label: string } | null {
  const m = NODE_RE.exec(raw.trim());
  if (!m) return null;
  const label = m[2] ?? m[3] ?? m[4];
  return { id: m[1], label: label ?? m[1] };
}

/**
 * Parses the body of a ```mermaid fence. Returns a tree if the graph has
 * exactly one root and every node has at most one parent; otherwise null.
 */
export function parseMermaidTree(lines: string[]): MermaidTreeNode | null {
  const body = lines.map((l) => l.trim()).filter(Boolean);
  if (!body.length) return null;

  if (!HEADER_RE.test(body[0])) return null; // require an explicit graph/flowchart header to opt in
  const start = 1;

  const nodes = new Map<string, MermaidTreeNode>();
  const parentOf = new Map<string, string>();
  const order: string[] = [];

  const ensure = (id: string, label: string): MermaidTreeNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, label, children: [] };
      nodes.set(id, n);
      order.push(id);
    } else if (label !== id) {
      n.label = label;
    }
    return n;
  };

  for (let i = start; i < body.length; i++) {
    const line = body[i];
    const edge = EDGE_RE.exec(line);
    if (!edge) return null; // not the simple edge-list subset we support

    const from = parseNode(edge[1]);
    const to = parseNode(edge[2]);
    if (!from || !to) return null;

    const parent = ensure(from.id, from.label);
    const child = ensure(to.id, to.label);

    if (parentOf.has(child.id) && parentOf.get(child.id) !== parent.id) return null; // multiple parents
    if (child.id === parent.id) return null; // self-loop
    parentOf.set(child.id, parent.id);
    if (!parent.children.includes(child)) parent.children.push(child);
  }

  const roots = order.filter((id) => !parentOf.has(id));
  if (roots.length !== 1) return null;

  // Cycle check: walking from the root must reach every node exactly once.
  const root = nodes.get(roots[0])!;
  const visited = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (visited.has(n.id)) return null;
    visited.add(n.id);
    stack.push(...n.children);
  }
  if (visited.size !== nodes.size) return null;

  return root;
}

/** Renders a tree as `tree`-style box-drawing lines. */
export function renderMermaidTree(root: MermaidTreeNode): string[] {
  const lines: string[] = [root.label];
  const walk = (node: MermaidTreeNode, prefix: string) => {
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      lines.push(`${prefix}${last ? "└─ " : "├─ "}${child.label}`);
      walk(child, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  walk(root, "");
  return lines;
}
