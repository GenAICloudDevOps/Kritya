/**
 * Minimal markdown -> HTML renderer for the Electron renderer process, which
 * has no React/Ink available (that's a terminal-only rendering path — see
 * src/ui/Markdown.tsx). Assistant output is untrusted, so every line is
 * HTML-escaped before any markup is introduced; the only tags this function
 * ever emits are the ones listed below.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      const li = items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join("");
      html.push(`<ul>${li}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      const li = items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join("");
      html.push(`<ol>${li}</ol>`);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    html.push(`<p>${renderInline(escapeHtml(line))}</p>`);
    i++;
  }

  return html.join("\n");
}
