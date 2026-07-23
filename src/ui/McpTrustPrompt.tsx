import { useState } from "react";
import { Box, Text } from "ink";
import { SelectList } from "./SelectList.js";
import type { McpServerConfig } from "../config/config.js";

/**
 * First-use approval for servers declared by the workspace's .mcp.json.
 *
 * Deliberately one server at a time. Approving the whole file as a batch means
 * that a branch adding a useful server and a hostile one offers only "both" or
 * "neither" — and someone who wants the useful one takes both. Per-server, the
 * hostile one can be refused on its own, so the safe answer stops costing
 * anything.
 */
function targetFor(cfg: McpServerConfig): string {
  return cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" ");
}

export function McpTrustPrompt({
  servers,
  onComplete,
}: {
  /** Servers declared in this workspace's .mcp.json that haven't been approved before. */
  servers: Record<string, McpServerConfig>;
  /** The subset the user approved, in declaration order. */
  onComplete(approved: string[]): void;
}) {
  const names = Object.keys(servers);
  const [index, setIndex] = useState(0);
  const [approved, setApproved] = useState<string[]>([]);

  const name = names[index];
  const cfg = servers[name];
  const isRemote = Boolean(cfg.url);

  const decide = (trust: boolean) => {
    const next = trust ? [...approved, name] : approved;
    if (index + 1 < names.length) {
      setApproved(next);
      setIndex(index + 1);
    } else {
      onComplete(next);
    }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        New MCP server{names.length > 1 ? ` (${index + 1} of ${names.length})` : ""}
      </Text>
      <Text>
        This workspace&apos;s .mcp.json declares a server not previously approved. It will run as a
        child process (or contact a remote endpoint) with your credentials, and its tools may be
        called automatically. Review before trusting.
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{name}</Text>
        <Text dimColor>{targetFor(cfg)}</Text>
        {isRemote ? (
          <Text color="yellow">
            ⚠ remote endpoint — requests, and any token you hold for it, leave this machine
          </Text>
        ) : null}
        {cfg.cwd ? <Text dimColor>runs in: {cfg.cwd}</Text> : null}
      </Box>
      <Box marginTop={1}>
        <SelectList
          // Keyed by name so the highlight resets to the top for each server:
          // holding Enter through a list shouldn't carry a "trust" choice
          // forward onto a server the user hasn't looked at.
          key={name}
          items={[
            { label: `Trust and load "${name}"`, value: "trust" },
            { label: "Don't trust (skip it this session)", value: "no" },
          ]}
          onSelect={(v) => decide(v === "trust")}
          onCancel={() => onComplete(approved)}
        />
      </Box>
    </Box>
  );
}
