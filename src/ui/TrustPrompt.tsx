import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";

const MAX_PREVIEW_LINES = 40;

export function TrustPrompt({
  workspace,
  preview,
  onDecision,
}: {
  workspace: string;
  /** Rendering of ALL trust-gated content (settings, .env, custom commands), for review. */
  preview: string;
  onDecision(trust: boolean): void;
}) {
  const lines = preview.split("\n");
  const shown = lines.slice(0, MAX_PREVIEW_LINES);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Untrusted workspace settings
      </Text>
      <Text>
        {workspace} ships content that would take effect automatically: settings `allow` rules or
        `hooks`, a `.env` file, and/or custom slash commands. Everything you would be approving is
        shown below — review it before trusting this workspace.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((line, i) => (
          <Text key={i} dimColor>
            {line || " "}
          </Text>
        ))}
        {lines.length > MAX_PREVIEW_LINES && (
          <Text dimColor>… ({lines.length - MAX_PREVIEW_LINES} more lines)</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <SelectList
          items={[
            { label: "Trust this workspace", value: "trust" },
            { label: "Don't trust (just this session)", value: "no" },
          ]}
          onSelect={(v) => onDecision(v === "trust")}
          onCancel={() => onDecision(false)}
        />
      </Box>
    </Box>
  );
}
