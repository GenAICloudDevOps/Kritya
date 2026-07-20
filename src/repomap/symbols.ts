/**
 * Language-aware symbol extraction for the repo map. Deliberately regex/
 * heuristic-based rather than AST- or LSP-based: it must run over a whole
 * repository in one pass, on any machine, with no language server to spawn and
 * no native parser dependency. The result is a ctags-style skeleton — top-level
 * (and lightly-nested) definitions with their signatures — not a precise parse.
 * It is intended as a cheap map to orient the model, so the tradeoff favors
 * breadth and speed over completeness: an occasional missed or spurious symbol
 * is acceptable, a hung or crashed scan is not.
 */

export interface CodeSymbol {
  /** Leading-whitespace width in the source (tab = 2), used to indent nested definitions. */
  indent: number;
  /** The cleaned, single-line signature. */
  text: string;
}

type Family = "js" | "python" | "go" | "rust" | "ruby" | "php" | "clike";

/**
 * File extension → language family. Covers the mainstream languages; a file
 * whose extension isn't here is simply skipped by the map (graceful: no crash,
 * no noise), rather than run through a generic pattern that produces junk.
 */
const EXT_FAMILY: Record<string, Family> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  java: "clike",
  kt: "clike",
  kts: "clike",
  cs: "clike",
  scala: "clike",
  swift: "clike",
  c: "clike",
  h: "clike",
  cpp: "clike",
  cc: "clike",
  cxx: "clike",
  hpp: "clike",
  hh: "clike",
  hxx: "clike",
  m: "clike",
  mm: "clike",
};

/** Source extensions the map will scan (the keys of EXT_FAMILY). */
export const CODE_EXTENSIONS = new Set(Object.keys(EXT_FAMILY));

export function familyForExt(ext: string): Family | null {
  return EXT_FAMILY[ext] ?? null;
}

/**
 * Control-flow keywords that can precede `(...)` and otherwise look like a
 * method definition (`if (x) {`, `for (…) {`). Used to reject false positives
 * in the brace-language method heuristic.
 */
const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "do",
  "else",
  "case",
  "with",
  "await",
  "when",
  "elif",
  "except",
  "finally",
  "match",
  "using",
  "lock",
  "synchronized",
]);

/** Keyword-led definition patterns, matched against the trimmed line. */
const PATTERNS: Record<Family, RegExp[]> = {
  js: [
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+[\w$]/,
    /^(?:export\s+)?(?:declare\s+)?interface\s+[\w$]/,
    /^(?:export\s+)?(?:declare\s+)?enum\s+[\w$]/,
    /^(?:export\s+)?(?:declare\s+)?type\s+[\w$][^=]*=/,
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*[\w$]/,
    // arrow-function assigned to a binding: `export const foo = (…) => …`
    /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
  ],
  python: [/^(?:async\s+)?def\s+[\w]/, /^class\s+[\w]/],
  go: [/^func\s+(?:\([^)]*\)\s*)?[\w]/, /^type\s+[\w]/],
  rust: [
    /^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+[\w]/,
    /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|mod|type)\s+[\w]/,
    /^impl(?:\s|<)/,
    /^macro_rules!\s+[\w]/,
  ],
  ruby: [/^(?:def|class|module)\s+[\w]/],
  php: [
    /^(?:abstract\s+|final\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*function\s+[\w]/,
    /^(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+[\w]/,
  ],
  clike: [
    /^(?:(?:public|private|protected|internal|static|final|sealed|abstract|export|open|data)\s+)*(?:class|struct|enum|interface|namespace|record|union|protocol|object|module)\s+[\w]/,
    // Kotlin `fun` / Swift `func`
    /^(?:(?:public|private|protected|internal|static|final|open|override|suspend|operator|inline|external)\s+)*(?:fun|func)\s+[\w]/,
  ],
};

/** Families whose class methods are detected by the brace heuristic below. */
const BRACE_METHOD_FAMILIES: ReadonlySet<Family> = new Set<Family>(["js", "clike"]);

/**
 * Heuristic for a class/struct method written on a single line that opens its
 * body with `{` — e.g. `async runTurn(text): Promise<void> {` or
 * `public void foo(int x) {`. Requires the brace so a bare call (`foo();`) or a
 * multi-line signature isn't mistaken for a definition, and rejects
 * control-flow keywords (`if (x) {`).
 */
function isBraceMethod(trimmed: string): boolean {
  if (!trimmed.endsWith("{")) return false;
  if (trimmed.startsWith("}") || trimmed.startsWith("@")) return false;
  // A closing paren, an optional return type, then the opening brace.
  if (!/\)\s*(?::\s*[^{]+|->\s*[^{]+)?\{$/.test(trimmed)) return false;
  // The identifier immediately before the parameter list is the method name.
  const m = trimmed.match(/([\w$~]+)\s*(?:<[^>]*>)?\s*\(/);
  if (!m) return false;
  if (CONTROL_KEYWORDS.has(m[1])) return false;
  return true;
}

/** Strip the trailing body-opener (`{`, `{}`) or colon, collapse whitespace, and cap length. */
function cleanSignature(trimmed: string): string {
  let s = trimmed
    .replace(/\s*\{\s*\}?\s*$/, "")
    .replace(/\s*[:;]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 120) s = s.slice(0, 119) + "…";
  return s;
}

function leadingIndent(line: string): number {
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent++;
    else if (ch === "\t") indent += 2;
    else break;
  }
  return indent;
}

/**
 * Extract up to `maxSymbols` definition signatures from a file's contents.
 * Returns an empty array for files with no recognizable definitions (or an
 * unsupported extension), which the caller drops from the map entirely.
 */
export function extractSymbols(content: string, ext: string, maxSymbols: number): CodeSymbol[] {
  const family = familyForExt(ext);
  if (!family) return [];
  const patterns = PATTERNS[family];
  const braceMethods = BRACE_METHOD_FAMILIES.has(family);
  const out: CodeSymbol[] = [];

  for (const raw of content.split("\n")) {
    if (out.length >= maxSymbols) break;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Skip obvious comment lines (also guards `*` block-comment continuations).
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("#")
    ) {
      continue;
    }

    let matched = patterns.some((re) => re.test(trimmed));
    if (!matched && braceMethods) matched = isBraceMethod(trimmed);
    if (!matched) continue;

    out.push({ indent: leadingIndent(raw), text: cleanSignature(trimmed) });
  }

  return out;
}
