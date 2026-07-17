import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "../config/config.js";
import type { ToolDef } from "../types.js";

/**
 * Minimal Model Context Protocol client over the stdio transport: newline-
 * delimited JSON-RPC 2.0. Each configured server is launched, initialized, and
 * its tools are wrapped as kritya ToolDefs. Tool output is treated as external
 * (untrusted) content. No SDK dependency, to keep the install lean.
 */

const PROTOCOL_VERSION = "2024-11-05";
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

class McpConnection {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;

  constructor(
    public readonly name: string,
    cfg: McpServerConfig
  ) {
    this.proc = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.on("exit", () => this.fail(new Error(`MCP server "${name}" exited`)));
    this.proc.on("error", (err) => this.fail(err));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON (some servers log to stdout)
    }
    if (typeof msg.id !== "number") return; // notification or log
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private send(obj: unknown): void {
    this.proc.stdin?.write(JSON.stringify(obj) + "\n");
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<McpToolSpec[]> {
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "kritya", version: "0.3.0" },
      },
      CONNECT_TIMEOUT_MS
    );
    this.notify("notifications/initialized");
    const listed = (await this.request("tools/list", {}, CONNECT_TIMEOUT_MS)) as {
      tools?: McpToolSpec[];
    };
    return listed.tools ?? [];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request(
      "tools/call",
      { name: toolName, arguments: args },
      CALL_TIMEOUT_MS
    )) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
      .join("\n");
    return text || "(no output)";
  }

  close(): void {
    this.closed = true;
    this.proc.kill();
  }
}

const connections: McpConnection[] = [];

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Launch all configured MCP servers and return their tools as ToolDefs.
 * Resilient: a server that fails to start is skipped with a warning, never
 * crashing kritya. Returns an empty list when nothing is configured.
 */
export async function loadMcpTools(
  servers: Record<string, McpServerConfig> | undefined
): Promise<ToolDef[]> {
  if (!servers || Object.keys(servers).length === 0) return [];
  const tools: ToolDef[] = [];

  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const conn = new McpConnection(name, cfg);
      try {
        const specs = await conn.initialize();
        connections.push(conn);
        for (const spec of specs) {
          tools.push(mcpToolDef(conn, name, spec));
        }
      } catch (err) {
        conn.close();
        process.stderr.write(
          `kritya: MCP server "${name}" failed to start: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    })
  );

  return tools;
}

function mcpToolDef(conn: McpConnection, server: string, spec: McpToolSpec): ToolDef {
  const name = `mcp_${sanitize(server)}_${sanitize(spec.name)}`;
  return {
    name,
    description: `[MCP: ${server}] ${spec.description ?? spec.name}`,
    parameters: spec.inputSchema ?? { type: "object", properties: {} },
    requiresPermission: true,
    external: true,
    summarize: (args) => `${server}/${spec.name}(${JSON.stringify(args).slice(0, 80)})`,
    execute: (args) => conn.callTool(spec.name, args),
  };
}

/** Kill all MCP servers (call on exit). */
export function shutdownMcp(): void {
  for (const conn of connections) conn.close();
}
