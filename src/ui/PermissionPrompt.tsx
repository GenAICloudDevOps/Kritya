import { Box, Text, useInput } from "ink";
import type { PermissionDecision } from "../types.js";
import { SelectList } from "./SelectList.js";

const MAX_DIFF_LINES = 30;

export function PermissionPrompt({
  toolName,
  summary,
  diff,
  warning,
  onDecision,
}: {
  toolName: string;
  summary: string;
  diff?: string;
  warning?: string;
  onDecision(decision: PermissionDecision): void;
}) {
  useInput((input) => {
    const c = input.toLowerCase();
    if (c === "y") onDecision("yes");
    else if (c === "a" && !warning) onDecision("always");
    else if (c === "n") onDecision("no");
  });

  const diffLines = diff ? diff.split("\n") : [];
  const shown = diffLines.slice(0, MAX_DIFF_LINES);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={warning ? "red" : "yellow"}
      paddingX={1}
    >
      <Text bold color={warning ? "red" : "yellow"}>
        {warning ? "⚠ Dangerous command" : "Permission required"}: {toolName}
      </Text>
      {warning && <Text color="red">This looks like {warning}. Review carefully.</Text>}
      <Text>{summary}</Text>
      {shown.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((line, i) => (
            <Text
              key={i}
              color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined}
              dimColor={!line.startsWith("+") && !line.startsWith("-")}
            >
              {line || " "}
            </Text>
          ))}
          {diffLines.length > MAX_DIFF_LINES && (
            <Text dimColor>… ({diffLines.length - MAX_DIFF_LINES} more lines)</Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <SelectList
          items={
            warning
              ? [
                  { label: "Yes, run it once (y)", value: "yes" },
                  { label: "No (n)", value: "no" },
                ]
              : [
                  { label: "Yes (y)", value: "yes" },
                  { label: `Yes, always allow ${toolName} this session (a)`, value: "always" },
                  { label: "No (n)", value: "no" },
                ]
          }
          onSelect={(v) => onDecision(v as PermissionDecision)}
          onCancel={() => onDecision("no")}
        />
      </Box>
    </Box>
  );
}
