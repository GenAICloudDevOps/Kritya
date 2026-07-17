import React from "react";
import { Box, Text } from "ink";
import { tokenizeLine, type TokenKind } from "./highlight.js";

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

/**
 * Minimal terminal markdown: fenced code blocks (syntax-highlighted), headers,
 * bullets, inline code. Deliberately lightweight — not a full implementation.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let key = 0;

  const flushCode = () => {
    if (codeLines.length) {
      blocks.push(
        <Box key={key++} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {codeLines.map((l, i) => (
            <CodeLine key={i} line={l} />
          ))}
        </Box>
      );
      codeLines = [];
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(
        <Text key={key++} bold color="magenta">
          {line.replace(/^#{1,6}\s/, "")}
        </Text>
      );
    } else if (/^\s*[-*]\s/.test(line)) {
      blocks.push(<Text key={key++}>{line.replace(/^(\s*)[-*]\s/, "$1• ")}</Text>);
    } else {
      blocks.push(<InlineLine key={key++} line={line} />);
    }
  }
  if (inCode) flushCode();

  return <Box flexDirection="column">{blocks}</Box>;
}

function InlineLine({ line }: { line: string }) {
  if (!line.includes("`")) return <Text>{line || " "}</Text>;
  const parts = line.split("`");
  return (
    <Text>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} color="yellow">
            {part}
          </Text>
        ) : (
          <Text key={i}>{part}</Text>
        )
      )}
    </Text>
  );
}
