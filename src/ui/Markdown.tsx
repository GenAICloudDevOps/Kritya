import React from "react";
import { Box, Text } from "ink";

/**
 * Minimal terminal markdown: fenced code blocks, headers, bullets, inline code.
 * Deliberately lightweight — not a full markdown implementation.
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
        <Box key={key++} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="cyan">{codeLines.join("\n")}</Text>
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
      blocks.push(
        <Text key={key++}>{line.replace(/^(\s*)[-*]\s/, "$1• ")}</Text>
      );
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
