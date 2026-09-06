import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

/**
 * Shown once, only when the active provider has no API key resolved, on the
 * interactive TTY path (never from headless — see runHeadless in
 * src/headless.ts, which never imports this component). Lets a first-time
 * user paste a key instead of hunting through env-var/dotfile instructions.
 */
export function ApiKeySetupPrompt({
  providerName,
  envVarName,
  onDecision,
}: {
  providerName: string;
  envVarName: string;
  onDecision(result: { action: "save"; key: string } | { action: "skip" }): void;
}) {
  const [value, setValue] = useState("");

  useInput((_input, key) => {
    if (key.escape) onDecision({ action: "skip" });
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        No API key found for provider "{providerName}"
      </Text>
      <Text>
        Paste your {envVarName} value below to save it to ~/.kritya/.env and continue — or press Esc
        to skip and set it up yourself.
      </Text>
      <Box marginTop={1}>
        <Text color="cyan">{"> "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          mask="*"
          onSubmit={(v) => {
            const trimmed = v.trim();
            if (trimmed) onDecision({ action: "save", key: trimmed });
          }}
        />
      </Box>
    </Box>
  );
}
