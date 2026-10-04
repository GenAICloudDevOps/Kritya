import { Box, Text } from "ink";
import type { Item } from "./useAgent.js";
import { Banner } from "./Banner.js";
import { Markdown } from "./Markdown.js";
import { toolOutputPreview } from "./toolOutputPreview.js";

export interface TranscriptItemProps {
  item: Item;
  verbose: boolean;
  /** Real width of the transcript column, in cells — measured, not the
   *  terminal's width, so indented output is clipped to what actually fits. */
  contentWidth: number;
}

/** Indent tool output is printed under (see the `    ` prefix below). */
const TOOL_INDENT = 4;

/** Renders one line of the transcript — a user message, assistant reply, tool call, info line, or banner. */
export function TranscriptItem({ item, verbose, contentWidth }: TranscriptItemProps) {
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
      {item.kind === "assistant" && <Markdown text={item.text} width={contentWidth} />}
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
                Math.max(20, contentWidth - TOOL_INDENT),
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
      {item.kind === "banner" && <Banner subtitle={item.subtitle} compact={item.compact} />}
      {item.kind === "summary" && (
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
          <Text bold color="green">
            ✓ Completed
          </Text>
          {item.files.length > 0 ? (
            <Box flexDirection="column">
              <Text dimColor>Changed:</Text>
              {item.files.map((f) => (
                <Text key={f}> {f}</Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>No files changed.</Text>
          )}
          <Text dimColor>Next: {item.nextStep}</Text>
        </Box>
      )}
    </Box>
  );
}
