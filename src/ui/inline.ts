import stringWidth from "string-width";

export interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  dim?: boolean;
}

/**
 * Inline markdown: bold, italic, code spans, links. Shared by every block type
 * (headers, bullets, paragraphs, table cells) so emphasis markers never leak
 * through as literal asterisks, and so column widths can be measured against
 * what is actually shown rather than the source text.
 */
export function parseInline(s: string): InlineToken[] {
  const out: InlineToken[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push({ text: plain });
      plain = "";
    }
  };
  const push = (tokens: InlineToken[], style: Partial<InlineToken>) => {
    flush();
    for (const t of tokens) out.push({ ...t, ...style });
  };

  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);

    // Code spans win over everything else, so `**` inside one stays literal.
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ text: s.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    // An emphasis run can't open right after a word or another marker, and its
    // content must hold a word character — that keeps "2 * 3", "a*b", and glob
    // patterns like **/*.ts from turning into stray italics.
    if (!/[*_\w]/.test(s[i - 1] ?? "")) {
      const strong = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/);
      if (strong && /\w/.test(strong[2])) {
        push(parseInline(strong[2]), { bold: true });
        i += strong[0].length;
        continue;
      }

      const em = rest.match(/^\*(?=\S)([^*]*\S)\*/);
      if (em && /\w/.test(em[1])) {
        push(parseInline(em[1]), { italic: true });
        i += em[0].length;
        continue;
      }
    }

    // Links keep their URL, dimmed — a terminal can't hide it behind the text.
    const link = rest.match(/^\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/);
    if (link) {
      push(parseInline(link[1]), {});
      out.push({ text: ` (${link[2]})`, dim: true });
      i += link[0].length;
      continue;
    }

    plain += s[i];
    i++;
  }
  flush();
  return mergeTokens(out);
}

function mergeTokens(tokens: InlineToken[]): InlineToken[] {
  const merged: InlineToken[] = [];
  for (const t of tokens) {
    const last = merged[merged.length - 1];
    if (last && sameStyle(last, t)) last.text += t.text;
    else merged.push({ ...t });
  }
  return merged;
}

function sameStyle(a: InlineToken, b: InlineToken): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.code === !!b.code &&
    !!a.dim === !!b.dim
  );
}

export function tokensWidth(tokens: InlineToken[]): number {
  return tokens.reduce((n, t) => n + stringWidth(t.text), 0);
}

/** Display width of one line of markdown, ignoring the markup itself. */
export function inlineWidth(s: string): number {
  return Math.max(0, ...s.split("\n").map((line) => tokensWidth(parseInline(line))));
}

/**
 * Wrap to `width` display columns, honouring hard line breaks. Returns one
 * token list per output line, each guaranteed to fit — table cells wrap
 * themselves so the row never has to.
 */
export function wrapInline(s: string, width: number): InlineToken[][] {
  const limit = Math.max(1, width);
  const lines: InlineToken[][] = [];

  for (const segment of s.split("\n")) {
    let cur: InlineToken[] = [];
    let curWidth = 0;
    let pendingSpace = false;

    for (const word of toWords(parseInline(segment))) {
      if (/^\s+$/.test(word.text)) {
        if (curWidth) pendingSpace = true;
        continue;
      }
      const pieces = splitToWidth(word.text, limit);
      for (let k = 0; k < pieces.length; k++) {
        const pieceWidth = stringWidth(pieces[k]);
        if (curWidth && curWidth + (pendingSpace ? 1 : 0) + pieceWidth > limit) {
          lines.push(mergeTokens(cur));
          cur = [];
          curWidth = 0;
        } else if (pendingSpace) {
          // Carry the word's style onto the space so a run of styled words
          // merges back into a single token instead of fragmenting.
          cur.push({ ...word, text: " " });
          curWidth += 1;
        }
        pendingSpace = false;
        cur.push({ ...word, text: pieces[k] });
        curWidth += pieceWidth;
        if (k < pieces.length - 1) {
          lines.push(mergeTokens(cur));
          cur = [];
          curWidth = 0;
        }
      }
    }
    lines.push(mergeTokens(cur));
  }

  return lines;
}

function toWords(tokens: InlineToken[]): InlineToken[] {
  const words: InlineToken[] = [];
  for (const t of tokens) {
    for (const piece of t.text.split(/(\s+)/)) {
      if (piece) words.push({ ...t, text: piece });
    }
  }
  return words;
}

/** Hard-split a word too long to fit (a URL, a path) at a display-width boundary. */
function splitToWidth(text: string, width: number): string[] {
  if (stringWidth(text) <= width) return [text];
  const pieces: string[] = [];
  let cur = "";
  let curWidth = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (curWidth + w > width && cur) {
      pieces.push(cur);
      cur = "";
      curWidth = 0;
    }
    cur += ch;
    curWidth += w;
  }
  if (cur) pieces.push(cur);
  return pieces;
}
