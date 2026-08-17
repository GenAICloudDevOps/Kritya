import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

const BLINK_INTERVAL_MS = 500;

/**
 * One-time, first-run notice: kritya is an AI agent that reads/writes files
 * and runs shell commands via a model you configure. Shown once per machine
 * (see aiDisclosureAcknowledged in config.ts) and only on the interactive
 * path — headless/CI runs skip it, since --trust already signals deliberate,
 * informed use there.
 */
export function AiDisclosurePrompt({ onDismiss }: { onDismiss(): void }) {
  useInput((_input, key) => {
    if (key.return) onDismiss();
  });

  const [blinkOn, setBlinkOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setBlinkOn((v) => !v), BLINK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>kritya is an AI agent</Text>
      <Box marginTop={1}>
        <Text>
          You are interacting with an AI system: kritya reads/writes files and runs shell commands
          here, acting on an AI model's output — not a human.
        </Text>
      </Box>
      <Text>Mutating actions ask for approval first.</Text>
      <Text>Details: /help, SECURITY.md (EU AI Act Art. 50).</Text>
      <Box marginTop={1}>
        <Text>
          Shown once. <Text color="yellow">{blinkOn ? "AI Disclosure" : " "}</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>Press Enter to continue…</Text>
      </Box>
    </Box>
  );
}
