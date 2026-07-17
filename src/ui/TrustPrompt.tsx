import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";

const MAX_PREVIEW_LINES = 30;

export function TrustPrompt({
  workspace,
  preview,
  onDecision,
}: {
  workspace: string;
  /** Raw contents of the workspace's .kritya/settings.json, for review. */
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
        {workspace} has a .kritya/settings.json with `allow` rules and/or `hooks` that would run
        automatically. Review it below before trusting this workspace.
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
