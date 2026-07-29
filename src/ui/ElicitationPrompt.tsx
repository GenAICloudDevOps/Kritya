import { useState } from "react";
import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";
import type { ElicitationField, ElicitationResult } from "../types.js";

/**
 * One field at a time, same reasoning as McpTrustPrompt's one-server-at-a-time
 * flow: a multi-field form rendered all at once in a terminal is hard to
 * navigate and easy to fat-finger past a field the user meant to change.
 */
export function ElicitationPrompt({
  message,
  fields,
  onDecision,
}: {
  message: string;
  fields: ElicitationField[];
  onDecision(result: ElicitationResult): void;
}) {
  const [index, setIndex] = useState(0);
  const [content, setContent] = useState<Record<string, string | boolean>>({});

  const finish = (finalContent: Record<string, string | boolean>) =>
    onDecision({ action: "accept", content: finalContent });

  const answer = (value: string | boolean) => {
    const field = fields[index];
    const next = { ...content, [field.name]: value };
    if (index + 1 < fields.length) {
      setContent(next);
      setIndex(index + 1);
    } else {
      finish(next);
    }
  };

  const field = fields[index];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Server request{fields.length > 1 ? ` (${index + 1} of ${fields.length})` : ""}
      </Text>
      <Text>{message}</Text>
      {field ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{field.label}</Text>
          {field.kind === "boolean" ? (
            <SelectList
              key={field.name}
              items={[
                { label: "Yes", value: "yes" },
                { label: "No", value: "no" },
              ]}
              onSelect={(v) => answer(v === "yes")}
              onCancel={() => onDecision({ action: "cancel" })}
            />
          ) : field.kind === "enum" ? (
            <SelectList
              key={field.name}
              items={field.options.map((o) => ({ label: o, value: o }))}
              onSelect={(v) => answer(v)}
              onCancel={() => onDecision({ action: "cancel" })}
            />
          ) : (
            <SelectList
              key={field.name}
              items={[{ label: "(text input not yet supported — declining)", value: "decline" }]}
              onSelect={() => onDecision({ action: "decline" })}
              onCancel={() => onDecision({ action: "cancel" })}
            />
          )}
        </Box>
      ) : (
        <Box marginTop={1}>
          <SelectList
            items={[
              { label: "Accept (no fields to fill)", value: "accept" },
              { label: "Decline", value: "decline" },
            ]}
            onSelect={(v) => (v === "accept" ? finish({}) : onDecision({ action: "decline" }))}
            onCancel={() => onDecision({ action: "cancel" })}
          />
        </Box>
      )}
    </Box>
  );
}
