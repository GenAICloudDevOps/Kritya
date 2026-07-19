import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { languageIdForFile, type LspServerConfig } from "./registry.js";

export interface LspPosition {
  /** 0-based, per the LSP spec. */
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** LocationLink shape some servers (gopls, rust-analyzer) return for definition. */
interface LspLocationLink {
  targetUri: string;
  targetSelectionRange: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Minimal LSP client over stdio. Implements only what the lsp_* tools need:
 * initialize, didOpen/didChange full-text sync, definition, references, and
 * collecting publishDiagnostics pushes. Deliberately dependency-free — the
 * framing and dispatch below is the whole protocol surface we use.
 */
export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private initPromise: Promise<void> | null = null;
  /** version + last-synced text per open document, keyed by absolute path. */
  private openDocs = new Map<string, { version: number; text: string }>();
  /** Latest diagnostics push per document URI, with a receipt counter for waiting. */
  private diagnostics = new Map<string, { items: LspDiagnostic[]; stamp: number }>();
  private diagStamp = 0;
  private diagWaiters = new Set<() => void>();
  /** Progress tokens with an active begin — nonempty means the server is still indexing. */
  private activeProgress = new Set<string | number>();
  private progressWaiters = new Set<() => void>();
  /** Set when the server process exits or errors; the manager respawns on next use. */
  dead = false;
  deathReason = "";

  constructor(
    readonly config: LspServerConfig,
    private readonly workspace: string
  ) {}

  /** Spawn the server and run the initialize handshake. Rejects if the binary is missing. */
  start(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doStart();
    return this.initPromise;
  }

  private doStart(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.command, this.config.args, {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = proc;

      proc.on("error", (err: NodeJS.ErrnoException) => {
        this.markDead(
          err.code === "ENOENT"
            ? `'${this.config.command}' is not installed (install: ${this.config.installHint})`
            : `failed to start '${this.config.command}': ${err.message}`
        );
        reject(new Error(this.deathReason));
      });
      proc.on("exit", (code) => {
        this.markDead(`language server '${this.config.command}' exited (code ${code})`);
      });
      proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
      // stderr is ignored: language servers log progress there and it is not
      // useful to the model; a crash surfaces via the exit handler instead.
      proc.stderr.resume();

      this.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.workspace).href,
        workspaceFolders: [{ uri: pathToFileURL(this.workspace).href, name: "workspace" }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            definition: { linkSupport: true },
            references: {},
            publishDiagnostics: {},
          },
          workspace: { configuration: true, workspaceFolders: true },
          // Lets the server report indexing/project-load progress, which
          // waitForIndexing uses to avoid answering queries from a
          // half-loaded project (tsserver, gopls, and rust-analyzer all
          // return incomplete references until their initial scan finishes).
          window: { workDoneProgress: true },
        },
      })
        .then(() => {
          this.notify("initialized", {});
          resolve();
        })
        .catch(reject);
    });
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deathReason = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.wakeDiagWaiters();
    this.wakeProgressWaiters();
  }

  dispose(): void {
    if (this.proc && !this.dead) {
      // Fire-and-forget shutdown; kill regardless so we never hang on exit.
      this.notify("exit", undefined);
      this.proc.kill();
    }
    this.markDead("client disposed");
  }

  // ---- JSON-RPC transport -------------------------------------------------

  private send(msg: object): void {
    if (!this.proc || this.dead) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(this.deathReason));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed frame — drop the header and resync rather than spinning.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.onMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Unparseable frame from the server; skip it.
      }
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && msg.method) {
      this.onServerRequest(msg);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.method ?? "LSP"}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.diagnostics.set(params.uri, { items: params.diagnostics, stamp: ++this.diagStamp });
      this.wakeDiagWaiters();
    } else if (msg.method === "$/progress") {
      const params = msg.params as { token: string | number; value?: { kind?: string } };
      if (params.value?.kind === "begin") this.activeProgress.add(params.token);
      else if (params.value?.kind === "end") this.activeProgress.delete(params.token);
      this.wakeProgressWaiters();
    }
    // Other notifications (logMessage, progress, ...) are irrelevant here.
  }

  /** Servers block waiting for answers to their own requests — respond to the common ones. */
  private onServerRequest(msg: JsonRpcMessage): void {
    switch (msg.method) {
      case "workspace/configuration": {
        const items = (msg.params as { items?: unknown[] })?.items ?? [];
        this.send({ id: msg.id, result: items.map(() => null) });
        break;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
        this.send({ id: msg.id, result: null });
        break;
      case "workspace/applyEdit":
        this.send({ id: msg.id, result: { applied: false } });
        break;
      default:
        this.send({ id: msg.id, error: { code: -32601, message: "method not supported" } });
    }
  }

  // ---- document sync ------------------------------------------------------

  /**
   * Ensure the server has the current on-disk content of `absPath`.
   * Returns the document URI and whether a (re)sync was actually sent —
   * callers use that to know if fresh diagnostics are on the way.
   */
  async syncDocument(absPath: string): Promise<{ uri: string; changed: boolean }> {
    const uri = pathToFileURL(absPath).href;
    const text = await fs.readFile(absPath, "utf8");
    const open = this.openDocs.get(absPath);
    if (!open) {
      this.openDocs.set(absPath, { version: 1, text });
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdForFile(this.config, absPath),
          version: 1,
          text,
        },
      });
      return { uri, changed: true };
    }
    if (open.text !== text) {
      open.version++;
      open.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: open.version },
        contentChanges: [{ text }],
      });
      return { uri, changed: true };
    }
    return { uri, changed: false };
  }

  /**
   * Wait for the server's active indexing/project-load progress to finish
   * (bounded). Definition/references answered mid-load silently miss
   * cross-file results, which is worse than a short delay. `justSynced`
   * grants a grace period for the "begin" notification to arrive at all —
   * project loading only starts after the first didOpen.
   */
  private async waitForIndexing(justSynced: boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (justSynced && this.activeProgress.size === 0) {
      const grace = Date.now() + 700;
      while (Date.now() < grace && this.activeProgress.size === 0 && !this.dead) {
        await this.waitForProgressChange(grace - Date.now());
      }
    }
    while (this.activeProgress.size > 0 && Date.now() < deadline && !this.dead) {
      await this.waitForProgressChange(deadline - Date.now());
    }
  }

  private waitForProgressChange(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.progressWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(50, Math.min(maxMs, 500)));
      this.progressWaiters.add(done);
    });
  }

  private wakeProgressWaiters(): void {
    const waiters = [...this.progressWaiters];
    this.progressWaiters.clear();
    for (const w of waiters) w();
  }

  // ---- feature requests ---------------------------------------------------

  async definition(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    const { uri, changed } = await this.syncDocument(absPath);
    await this.waitForIndexing(changed);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    return normalizeLocations(result);
  }

  async references(absPath: string, position: LspPosition): Promise<LspLocation[]> {
    const { uri, changed } = await this.syncDocument(absPath);
    await this.waitForIndexing(changed);
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(result);
  }

  /**
   * Sync the file and return its diagnostics. Diagnostics are pushed by the
   * server asynchronously, so after a (re)sync we wait for the next push for
   * this URI, up to `timeoutMs` — servers analyzing a large project for the
   * first time may deliver later, in which case the last-known set is returned.
   */
  async diagnosticsFor(absPath: string, timeoutMs = 8_000): Promise<LspDiagnostic[]> {
    const { uri, changed } = await this.syncDocument(absPath);
    const before = this.diagnostics.get(uri)?.stamp ?? 0;
    if (!changed && before > 0) return this.diagnostics.get(uri)!.items;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.dead) {
      const current = this.diagnostics.get(uri);
      if (current && current.stamp > before) return current.items;
      await this.waitForDiagPush(deadline - Date.now());
    }
    return this.diagnostics.get(uri)?.items ?? [];
  }

  private waitForDiagPush(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(50, Math.min(maxMs, 1000)));
      const waiter = done;
      this.diagWaiters.add(waiter);
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private wakeDiagWaiters(): void {
    const waiters = [...this.diagWaiters];
    this.diagWaiters.clear();
    for (const w of waiters) w();
  }
}

/** Servers return Location | Location[] | LocationLink[] | null; flatten to Location[]. */
function normalizeLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.map((item: LspLocation | LspLocationLink) =>
    "targetUri" in item
      ? { uri: item.targetUri, range: item.targetSelectionRange }
      : { uri: item.uri, range: item.range }
  );
}
