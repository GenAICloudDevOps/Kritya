import React from "react";
import { Box, Text, useStdout } from "ink";
import stringWidth from "string-width";
import { tokenizeLine, type TokenKind } from "./highlight.js";
import { parseInline, tokensWidth, wrapInline, type InlineToken } from "./inline.js";
import { parseMermaidTree, renderMermaidTree } from "./mermaid.js";
import { terminalColumns } from "./viewport.js";
import {
  COLUMN_GAP,
  columnWidths,
  detectTable,
  dropPartialTrailingTable,
  isTableRow,
  shouldStack,
  type Align,
  type Table as MdTable,
} from "./table.js";

const TOKEN_COLORS: Record<TokenKind, string | undefined> = {
  keyword: "magenta",
  string: "green",
  comment: "gray",
  number: "cyan",
  plain: undefined,
};

function CodeLine({ line }: { line: string }) {
  if (!line) return <Text> </Text>;
  return (
    <Text>
      {tokenizeLine(line).map((t, i) => (
        <Text key={i} color={TOKEN_COLORS[t.kind]} bold={t.kind === "keyword"}>
          {t.text}
        </Text>
      ))}
    </Text>
  );
}

function Inline({ tokens }: { tokens: InlineToken[] }) {
  if (!tokens.length) return <> </>;
  return (
    <>
      {tokens.map((t, i) => (
        <Text
          key={i}
          bold={t.bold}
          italic={t.italic}
          dimColor={t.dim}
          color={t.code ? "yellow" : undefined}
        >
          {t.text}
        </Text>
      ))}
    </>
  );
}

function InlineText({ text, ...style }: { text: string } & React.ComponentProps<typeof Text>) {
  return (
    <Text {...style}>
      <Inline tokens={parseInline(text)} />
    </Text>
  );
}

/** Wrapped text with a marker on the first line and a hanging indent under it. */
function Marked({
  text,
  width,
  marker,
  indent,
  ...style
}: { text: string; width: number; marker: string; indent: string } & React.ComponentProps<
  typeof Text
>) {
  const lines = wrapInline(text, width - stringWidth(marker));
  return (
    <Box flexDirection="column">
      {lines.map((tokens, i) => (
        <Text key={i} {...style}>
          {i === 0 ? marker : indent}
          <Inline tokens={tokens} />
        </Text>
      ))}
    </Box>
  );
}

/**
 * Minimal terminal markdown: fenced code blocks (syntax-highlighted), headers,
 * bullets, quotes, rules, tables, and inline emphasis. Deliberately
 * lightweight — not a full implementation.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const { stdout } = useStdout();
  const width = Math.max(20, terminalColumns(stdout) - 2);
  const blocks = React.useMemo(
    () => renderBlocks(text, width, streaming),
    [text, width, streaming]
  );
  return <Box flexDirection="column">{blocks}</Box>;
}

function renderBlocks(text: string, width: number, streaming: boolean): React.ReactNode[] {
  let lines = text.split("\n");
  if (streaming && !hasOpenFence(lines)) lines = dropPartialTrailingTable(lines);

  const blocks: React.ReactNode[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let key = 0;

  const flushCode = () => {
    if (!codeLines.length) return;

    if (codeLang === "mermaid") {
      const tree = parseMermaidTree(codeLines);
      if (tree) {
        const treeLines = renderMermaidTree(tree);
        blocks.push(
          <Box key={key++} flexDirection="column">
            {treeLines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
          </Box>
        );
        codeLines = [];
        return;
      }
    }

    // Size the frame to the code, not to the terminal — a two-line snippet
    // in a wide terminal was drawing a box the full width of the screen.
    const longest = Math.max(...codeLines.map((l) => stringWidth(l)));
    blocks.push(
      <Box
        key={key++}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        width={Math.min(width, longest + 4)}
      >
        {codeLines.map((l, i) => (
          <CodeLine key={i} line={l} />
        ))}
      </Box>
    );
    codeLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        flushCode();
      } else {
        codeLang = line.trim().slice(3).trim().toLowerCase();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (isTableRow(line)) {
      const found = detectTable(lines, i);
      if (found) {
        blocks.push(<TableBlock key={key++} table={found.table} width={width} />);
        i = found.next - 1;
        continue;
      }
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(
        <Text key={key++} dimColor>
          {"─".repeat(width)}
        </Text>
      );
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(
        <InlineText key={key++} text={line.replace(/^#{1,6}\s/, "")} bold color="magenta" />
      );
    } else if (/^\s*>\s?/.test(line)) {
      blocks.push(
        <Marked
          key={key++}
          text={line.replace(/^\s*>\s?/, "")}
          width={width}
          marker="│ "
          indent="│ "
          dimColor
        />
      );
    } else if (/^\s*[-*]\s/.test(line)) {
      const [, pad, rest] = /^(\s*)[-*]\s+([\s\S]*)$/.exec(line)!;
      blocks.push(
        <Marked key={key++} text={rest} width={width} marker={`${pad}• `} indent={`${pad}  `} />
      );
    } else if (/^\s*\d{1,3}[.)]\s/.test(line)) {
      const [, pad, number, rest] = /^(\s*)(\d{1,3}[.)])\s+([\s\S]*)$/.exec(line)!;
      blocks.push(
        <Marked
          key={key++}
          text={rest}
          width={width}
          marker={`${pad}${number} `}
          indent={`${pad}${" ".repeat(number.length + 1)}`}
        />
      );
    } else {
      // Paragraphs wrap through the same path as everything else: Ink's own
      // wrapping carries the break's space onto the next line, which shows up
      // as a stray leading space at column zero.
      const [, pad, rest] = /^(\s*)([\s\S]*)$/.exec(line)!;
      blocks.push(
        <Marked key={key++} text={rest || " "} width={width} marker={pad} indent={pad} />
      );
    }
  }
  if (inCode) flushCode();

  return blocks;
}

function hasOpenFence(lines: string[]): boolean {
  return lines.filter((l) => l.trimStart().startsWith("```")).length % 2 === 1;
}

function TableBlock({ table, width }: { table: MdTable; width: number }) {
  if (shouldStack(table, width)) return <StackedTable table={table} width={width} />;

  const widths = columnWidths(table, width);
  return (
    <Box flexDirection="column">
      <Row cells={table.header} widths={widths} align={table.align} bold />
      <Text dimColor>{widths.map((w) => "─".repeat(w)).join(" ".repeat(COLUMN_GAP))}</Text>
      {table.rows.map((cells, i) => (
        <Row key={i} cells={cells} widths={widths} align={table.align} />
      ))}
    </Box>
  );
}

function Row({
  cells,
  widths,
  align,
  bold,
}: {
  cells: string[];
  widths: number[];
  align: Align[];
  bold?: boolean;
}) {
  const wrapped = widths.map((w, i) => wrapInline(cells[i] ?? "", w));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));

  return (
    <Box flexDirection="row">
      {wrapped.map((lines, col) => (
        <Box
          key={col}
          flexDirection="column"
          width={widths[col]}
          marginRight={col < widths.length - 1 ? COLUMN_GAP : 0}
        >
          {Array.from({ length: height }, (_, r) => {
            const tokens = lines[r] ?? [];
            const pad = Math.max(0, widths[col] - tokensWidth(tokens));
            const lead =
              align[col] === "right" ? pad : align[col] === "center" ? Math.floor(pad / 2) : 0;
            return (
              // truncate is a backstop: a row must never grow a second line of
              // its own, whatever the width arithmetic does with odd glyphs.
              <Text key={r} bold={bold} wrap="truncate">
                {lead ? " ".repeat(lead) : ""}
                {tokens.length ? <Inline tokens={tokens} /> : " "}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

/** Too narrow (or too many columns) for a grid: one labelled block per row. */
function StackedTable({ table, width }: { table: MdTable; width: number }) {
  return (
    <Box flexDirection="column">
      {table.rows.map((cells, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {cells.map((cell, col) =>
            cell ? (
              <Box key={col} flexDirection="column">
                {table.header[col] ? <InlineText text={table.header[col]} bold /> : null}
                {wrapInline(cell, Math.max(1, width - 2)).map((tokens, r) => (
                  <Text key={r}>
                    {"  "}
                    <Inline tokens={tokens} />
                  </Text>
                ))}
              </Box>
            ) : null
          )}
        </Box>
      ))}
    </Box>
  );
}
