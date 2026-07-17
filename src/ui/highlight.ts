export type TokenKind = "keyword" | "string" | "comment" | "number" | "plain";

export interface Token {
  text: string;
  kind: TokenKind;
}

// Shared keyword set across the languages an agent CLI shows most:
// TS/JS, Python, Go, Rust, Java, shell.
const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "def",
  "class",
  "if",
  "else",
  "elif",
  "for",
  "while",
  "return",
  "import",
  "from",
  "export",
  "async",
  "await",
  "try",
  "catch",
  "except",
  "finally",
  "new",
  "type",
  "interface",
  "enum",
  "struct",
  "impl",
  "fn",
  "pub",
  "match",
  "switch",
  "case",
  "break",
  "continue",
  "true",
  "false",
  "null",
  "None",
  "nil",
  "undefined",
  "this",
  "self",
  "static",
  "void",
  "public",
  "private",
  "extends",
  "implements",
  "lambda",
  "yield",
  "in",
  "of",
  "not",
  "and",
  "or",
  "package",
  "func",
  "go",
  "chan",
  "defer",
  "then",
  "fi",
  "do",
  "done",
  "echo",
]);

const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER_RE = /\d[\d_]*(\.\d+)?([eE][+-]?\d+)?[a-zA-Z]*/y;

/**
 * Language-agnostic single-line tokenizer for terminal syntax highlighting.
 * Strings win over comments (a "//" inside quotes is not a comment); block
 * comments are approximated as line comments.
 */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      tokens.push({ text: plain, kind: "plain" });
      plain = "";
    }
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (ch === '"' || ch === "'" || ch === "`") {
      flush();
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, line.length);
      tokens.push({ text: line.slice(i, j), kind: "string" });
      i = j;
      continue;
    }

    if ((ch === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) || ch === "#") {
      flush();
      tokens.push({ text: line.slice(i), kind: "comment" });
      break;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      WORD_RE.lastIndex = i;
      const m = WORD_RE.exec(line)!;
      flush();
      tokens.push({ text: m[0], kind: KEYWORDS.has(m[0]) ? "keyword" : "plain" });
      i += m[0].length;
      continue;
    }

    if (/\d/.test(ch)) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(line)!;
      flush();
      tokens.push({ text: m[0], kind: "number" });
      i += m[0].length;
      continue;
    }

    plain += ch;
    i++;
  }
  flush();

  // Merge adjacent plain tokens (word followed by punctuation, etc.).
  const merged: Token[] = [];
  for (const t of tokens) {
    const last = merged[merged.length - 1];
    if (last && last.kind === "plain" && t.kind === "plain") last.text += t.text;
    else merged.push({ ...t });
  }
  return merged;
}
