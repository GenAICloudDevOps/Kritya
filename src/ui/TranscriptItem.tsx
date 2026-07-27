import { Box, Text } from "ink";
import type { Item } from "./useAgent.js";
import { Banner } from "./Banner.js";
import { Markdown } from "./Markdown.js";
import { toolOutputPreview } from "./toolOutputPreview.js";
import { terminalColumns } from "./viewport.js";

export interface TranscriptItemProps {
  item: Item;
  verbose: boolean;
  stdout: NodeJS.WriteStream | undefined;
}

/** Renders one line of the transcript — a user message, assistant reply, tool call, info line, or banner. */
export function TranscriptItem({ item, verbose, stdout }: TranscriptItemProps) {
  return (
    <Box marginBottom={item.kind === "tool" ? 0 : 1} flexDirection="column">
      {item.kind === "user" && (
        <Text>
          <Text bold color="green">
            ❯{" "}
          </Text>
          {item.text}
        </Text>
      )}
      {item.kind === "assistant" && <Markdown text={item.text} />}
      {item.kind === "tool" && (
        <Box flexDirection="column">
          <Text dimColor>
            {item.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>} {item.summary}
            {item.resultSummary && !verbose ? ` — ${item.resultSummary}` : ""}
          </Text>
          {item.output && item.output.trim() && (item.resultSummary === undefined || verbose) && (
            <Text dimColor>
              {toolOutputPreview(
                item.output,
                verbose,
                Math.max(20, terminalColumns(stdout) - 6),
                item.error
              )
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")}
            </Text>
          )}
        </Box>
      )}
      {item.kind === "info" && <Text dimColor>{item.text}</Text>}
      {item.kind === "banner" && <Banner subtitle={item.subtitle} />}
    </Box>
  );
}
