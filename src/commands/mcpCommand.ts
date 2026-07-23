import {
  assertSafeUrl,
  connectServer,
  disconnectServer,
  forgetStatus,
  mcpStatus,
  replaceStatus,
  isToolOf,
} from "../mcp/client.js";
import { beginLogin, logout, pendingLogin } from "../mcp/login.js";
import { loadAuth } from "../mcp/tokens.js";
import { expandServerConfig, loadProjectMcpServers } from "../mcp/servers.js";
import { loadConfig, saveConfig, type McpServerConfig } from "../config/config.js";
import { isServerTrusted, serverFingerprint, trustServer } from "../trust/mcpTrust.js";
import type { CommandContext } from "./registry.js";

/**
 * The `/mcp` command family: status, add/remove, login/logout.
 *
 * Where a server was declared decides how much ceremony a login gets. A server
 * in the user's own ~/.kritya/config.json is theirs — logging in opens the
 * browser straight away. A server declared by the workspace's .mcp.json was
 * written by whoever wrote the repo, and an OAuth login mints a durable token
 * against the user's real Linear/Notion/GitHub account. That is worth one
 * deliberate keystroke, because an unexpected browser popup mid-task is exactly
 * the situation where people click "Allow" without reading.
 *
 * (Per-server trust from mcpTrust.ts already gates whether a project server
 * loads at all; this is the narrower question of whether it may send the user
 * to an account-consent screen.)
 */

export type Provenance = "global" | "project" | "unknown";

export interface ResolvedServer {
  name: string;
  cfg: McpServerConfig;
  provenance: Provenance;
}

/** Find a server by name across both config sources, with where it came from. */
export function resolveServer(name: string, workspace: string): ResolvedServer | undefined {
  const global = loadConfig().mcpServers?.[name];
  if (global) return { name, cfg: expandServerConfig(global), provenance: "global" };
  const project = loadProjectMcpServers(workspace)?.[name];
  if (project) return { name, cfg: expandServerConfig(project), provenance: "project" };
  return undefined;
}

const USAGE = `Usage:
  /mcp                          status of every configured server
  /mcp add <name> <url>         add a remote (HTTP) server to your config
  /mcp add <name> -- <cmd...>   add a local (stdio) server to your config
  /mcp remove <name>            remove a server from your config
  /mcp login <name>             sign in to a server via your browser
  /mcp logout <name>            revoke and delete a server's saved token
  /mcp code <name> <code>       finish a login by pasting the code (SSH/headless)`;

export async function runMcpCommand(ctx: CommandContext): Promise<void> {
  const parts = ctx.arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  switch (sub) {
    case undefined:
      return showStatus(ctx);
    case "add":
      return addServer(ctx, parts.slice(1));
    case "remove":
    case "rm":
      return removeServer(ctx, parts[1]);
    case "login":
      return loginServer(ctx, parts[1], parts.slice(2));
    case "logout":
      return logoutServer(ctx, parts[1]);
    case "code":
      return submitCode(ctx, parts[1], parts.slice(2).join(" "));
    default:
      ctx.addItem({ kind: "info", text: `Unknown /mcp subcommand "${sub}".\n\n${USAGE}` });
  }
}

function showStatus(ctx: CommandContext): void {
  const statuses = mcpStatus();
  if (statuses.length === 0) {
    ctx.addItem({
      kind: "info",
      text:
        "No MCP servers configured.\n\n" +
        "Add one with /mcp add <name> <url>, or by hand under mcpServers in\n" +
        "~/.kritya/config.json or a .mcp.json at the workspace root:\n" +
        `  { "mcpServers": { "linear": { "url": "https://mcp.linear.app/mcp" },\n` +
        `                    "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }`,
    });
    return;
  }
  const lines = statuses.map((s) => {
    const mark = s.ok ? "✔" : s.needsAuth ? "○" : "✘";
    const head = `${mark} ${s.name} (${s.transport}) — ${s.target}`;
    if (s.ok) {
      const auth = s.transport === "http" && loadAuth(s.target) ? " · signed in" : "";
      return `${head}${auth}\n    ${s.tools.length} tool(s): ${s.tools.join(", ") || "(none)"}`;
    }
    return `${head}\n    ${s.needsAuth ? s.error : `failed: ${s.error}`}`;
  });
  const anyAuth = statuses.some((s) => s.needsAuth);
  const hint = anyAuth ? "\n\n○ = signed out. Run /mcp login <name> to connect it." : "";
  ctx.addItem({ kind: "info", text: `MCP servers:\n${lines.join("\n")}${hint}\n\n${USAGE}` });
}

function addServer(ctx: CommandContext, args: string[]): void {
  const name = args[0];
  const rest = args.slice(1);
  if (!name || rest.length === 0) {
    ctx.addItem({
      kind: "info",
      text: `Usage: /mcp add <name> <url>  ·  /mcp add <name> -- <command> [args...]`,
    });
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    ctx.addItem({
      kind: "info",
      text: `Invalid server name "${name}". Use letters, digits, "-" and "_" only — the name becomes part of each tool's name.`,
    });
    return;
  }

  let cfg: McpServerConfig;
  if (rest[0] === "--") {
    const [command, ...cmdArgs] = rest.slice(1);
    if (!command) {
      ctx.addItem({ kind: "info", text: "Usage: /mcp add <name> -- <command> [args...]" });
      return;
    }
    cfg = { command, args: cmdArgs.length ? cmdArgs : undefined };
  } else {
    const url = rest[0];
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      ctx.addItem({
        kind: "info",
        text: `"${url}" is not a valid URL. For a local server use: /mcp add ${name} -- <command> [args...]`,
      });
      return;
    }
    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      ctx.addItem({
        kind: "info",
        text: `Refusing to add "${url}" over plain HTTP — an MCP session carries your credentials. Use https:// (localhost is exempt).`,
      });
      return;
    }
    cfg = { url };
  }

  const config = loadConfig();
  const servers = { ...config.mcpServers, [name]: cfg };
  saveConfig({ mcpServers: servers });
  // Added by hand from this session, so it's the user's own decision — record
  // the trust now rather than prompting about it on the next startup.
  trustServer(name, serverFingerprint(cfg));

  ctx.addItem({
    kind: "info",
    text: `Added "${name}" to ~/.kritya/config.json. Connecting…`,
  });
  void connectAndAttach(ctx, name, expandServerConfig(cfg));
}

async function removeServer(ctx: CommandContext, name: string | undefined): Promise<void> {
  if (!name) {
    ctx.addItem({ kind: "info", text: "Usage: /mcp remove <name>" });
    return;
  }
  const config = loadConfig();
  const cfg = config.mcpServers?.[name];
  if (!cfg) {
    const inProject = loadProjectMcpServers(ctx.workspace)?.[name];
    ctx.addItem({
      kind: "info",
      text: inProject
        ? `"${name}" comes from this workspace's .mcp.json, not your config — remove it from that file (it is checked into the repo).`
        : `No server named "${name}" in ~/.kritya/config.json.`,
    });
    return;
  }

  const servers = { ...config.mcpServers };
  delete servers[name];
  saveConfig({ mcpServers: servers });

  // A stored token for a server you just removed is a credential with no
  // remaining purpose; revoke and delete it rather than leaving it behind.
  let tokenNote = "";
  if (cfg.url) {
    const url = expandServerConfig(cfg).url as string;
    const result = await logout(url);
    if (result.hadToken) {
      tokenNote = result.revoked
        ? "\nIts saved token was revoked and deleted."
        : "\nIts saved token was deleted locally (the server offers no revocation endpoint).";
    }
  }

  disconnectServer(name);
  // Withdraw before forgetting: forgetStatus releases the server's tool names,
  // after which isToolOf can no longer identify them.
  const removed = ctx.agent.removeTools(isToolOf(name));
  forgetStatus(name);
  ctx.addItem({
    kind: "info",
    text: `Removed "${name}" — ${removed} tool(s) withdrawn.${tokenNote}`,
  });
}

async function loginServer(
  ctx: CommandContext,
  name: string | undefined,
  flags: string[]
): Promise<void> {
  if (!name) {
    ctx.addItem({ kind: "info", text: "Usage: /mcp login <name>" });
    return;
  }
  const server = resolveServer(name, ctx.workspace);
  if (!server) {
    ctx.addItem({
      kind: "info",
      text: `No server named "${name}". See /mcp for the list, or add one with /mcp add <name> <url>.`,
    });
    return;
  }
  if (!server.cfg.url) {
    ctx.addItem({
      kind: "info",
      text: `"${name}" is a local (stdio) server — it runs as your own user and has nothing to log in to.`,
    });
    return;
  }
  // A login never reaches connectServer, so the transport's own scheme check
  // can't cover it — and this path is worse than a plain request, since it
  // mints a durable token against the user's real account.
  try {
    assertSafeUrl(name, server.cfg.url);
  } catch (err) {
    ctx.addItem({ kind: "info", text: err instanceof Error ? err.message : String(err) });
    return;
  }

  const confirmed = flags.some((f) => f === "--yes" || f === "-y" || f === "confirm");
  if (server.provenance === "project" && !confirmed) {
    ctx.addItem({
      kind: "info",
      text:
        `"${name}" is declared by this workspace's .mcp.json, not by you.\n\n` +
        `  ${server.cfg.url}\n\n` +
        `Logging in opens your browser and grants this server a token for your\n` +
        `real account there — it will keep working after this session ends.\n\n` +
        `If you trust the repo, confirm with:  /mcp login ${name} --yes`,
    });
    return;
  }
  // A project server that was never through the per-server trust gate (added by
  // a pull after startup, say) must not reach a consent screen on --yes alone.
  if (server.provenance === "project" && !isServerTrusted(serverFingerprint(server.cfg))) {
    trustServer(name, serverFingerprint(server.cfg));
  }

  const status = mcpStatus().find((s) => s.name === name);
  ctx.setActivity(`Signing in to ${name}…`);
  try {
    const login = await beginLogin({
      serverName: name,
      serverUrl: server.cfg.url,
      resourceMetadataUrl: status?.authMetadataUrl,
    });
    ctx.addItem({
      kind: "info",
      text: login.browserOpened
        ? `Opened your browser to sign in to "${name}".\n` +
          `Approve the request there, then this session picks it up automatically.\n\n` +
          `If the browser didn't open: ${login.authorizeUrl}`
        : `No browser available here. Open this URL on any machine:\n\n` +
          `${login.authorizeUrl}\n\n` +
          `If the redirect can reach ${login.redirectUri} it completes by itself.\n` +
          `Otherwise copy the "code" from the address bar and run:\n` +
          `  /mcp code ${name} <code>`,
    });

    const auth = await login.completed;
    ctx.addItem({
      kind: "info",
      text: `Signed in to "${name}"${auth.scope ? ` (scope: ${auth.scope})` : ""}. Connecting…`,
    });
    await connectAndAttach(ctx, name, server.cfg);
  } catch (err) {
    ctx.addItem({
      kind: "info",
      text: `Login for "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    ctx.setActivity(null);
  }
}

function submitCode(ctx: CommandContext, name: string | undefined, code: string): void {
  if (!name || !code) {
    ctx.addItem({ kind: "info", text: "Usage: /mcp code <name> <code-or-redirect-url>" });
    return;
  }
  const login = pendingLogin(name);
  if (!login) {
    ctx.addItem({
      kind: "info",
      text: `No login in progress for "${name}". Start one with /mcp login ${name}.`,
    });
    return;
  }
  login.submitCode(code);
  ctx.addItem({ kind: "info", text: `Code accepted for "${name}" — exchanging it for a token…` });
}

async function logoutServer(ctx: CommandContext, name: string | undefined): Promise<void> {
  if (!name) {
    ctx.addItem({ kind: "info", text: "Usage: /mcp logout <name>" });
    return;
  }
  const server = resolveServer(name, ctx.workspace);
  if (!server?.cfg.url) {
    ctx.addItem({
      kind: "info",
      text: `No remote server named "${name}" to log out of.`,
    });
    return;
  }

  const result = await logout(server.cfg.url);
  if (!result.hadToken) {
    ctx.addItem({ kind: "info", text: `No saved token for "${name}" — nothing to log out of.` });
    return;
  }

  disconnectServer(name);
  const removed = ctx.agent.removeTools(isToolOf(name));
  replaceStatus({
    name,
    transport: "http",
    target: server.cfg.url,
    ok: false,
    needsAuth: true,
    error: `needs login — run /mcp login ${name}`,
    tools: [],
  });

  // Deleting a token locally is not the same as killing it, and only one of
  // those is something the user can rely on. Say which happened.
  ctx.addItem({
    kind: "info",
    text: result.revoked
      ? `Logged out of "${name}" — token revoked with the server and deleted locally. ${removed} tool(s) withdrawn.`
      : `Logged out of "${name}" — token deleted locally. ${removed} tool(s) withdrawn.\n` +
        `⚠ This server offers no revocation endpoint, so the token stays valid on\n` +
        `  their side until it expires. Remove kritya in that service's settings\n` +
        `  if you need it dead now.`,
  });
}

/** Connect (or reconnect) a server and hand its tools to the running agent. */
async function connectAndAttach(
  ctx: CommandContext,
  name: string,
  cfg: McpServerConfig
): Promise<void> {
  disconnectServer(name);
  ctx.agent.removeTools(isToolOf(name));
  const { tools, status } = await connectServer(name, cfg, {
    tracer: ctx.agent.tracer,
    audit: ctx.agent.audit,
    workspace: ctx.workspace,
  });
  replaceStatus(status);
  if (!status.ok) {
    ctx.addItem({
      kind: "info",
      text: status.needsAuth
        ? `"${name}" still needs a login — run /mcp login ${name}.`
        : `"${name}" failed to connect: ${status.error}`,
    });
    return;
  }
  ctx.agent.addTools(tools);
  ctx.addItem({
    kind: "info",
    text: `"${name}" connected — ${tools.length} tool(s) available now: ${status.tools.join(", ") || "(none)"}`,
  });
}
