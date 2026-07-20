import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";
import type { McpServerConfig } from "../config/config.js";

function targetFor(cfg: McpServerConfig): string {
  return cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" ");
}

export function McpTrustPrompt({
  servers,
  onDecision,
}: {
  /** Servers declared in this workspace's .mcp.json that haven't been approved before. */
  servers: Record<string, McpServerConfig>;
  onDecision(trust: boolean): void;
}) {
  const names = Object.keys(servers);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        New MCP server{names.length > 1 ? "s" : ""}
      </Text>
      <Text>
        This workspace's .mcp.json declares {names.length} server{names.length > 1 ? "s" : ""} not
        previously approved. Each will run as a child process (or contact a remote endpoint) with
        your credentials, and its tools may be called automatically. Review before trusting.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {names.map((name) => (
          <Text key={name} dimColor>
            {name}: {targetFor(servers[name])}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <SelectList
          items={[
            { label: "Trust and load these servers", value: "trust" },
            { label: "Don't trust (skip them this session)", value: "no" },
          ]}
          onSelect={(v) => onDecision(v === "trust")}
          onCancel={() => onDecision(false)}
        />
      </Box>
    </Box>
  );
}
