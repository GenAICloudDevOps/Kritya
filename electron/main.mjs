// Electron main process. Deliberately thin: all agent behavior lives in the
// compiled core (dist/engine.js, built from src/engine.ts), which is the
// same contract the Ink CLI relies on. This file should only ever need to
// change when the *shape* of that contract changes, not when tools,
// providers, or agent internals change.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngineSession } from "../dist/engine.js";
import { SessionStore } from "../dist/session/store.js";
import { loadConfig, listProviders } from "../dist/config/config.js";
import { CURATED_MODELS } from "../dist/config/models.js";
import {
  isNonEmptyString,
  isValidPermissionDecision,
  isValidStartOpts,
  isValidModeFlags,
  permissionIdBelongsToSession,
} from "../dist/electron/ipcValidation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** One engine session per renderer window, keyed by WebContents id. */
const sessions = new Map();
/** Pending permission prompts, keyed by a request id, resolved by the renderer's reply. */
const pendingPermissions = new Map();

/**
 * Reject every pending permission prompt that belongs to this window/session
 * as "no", so a tool call `await`ing requestPermission doesn't hang forever
 * when the switch is killed or the window is closed out from under it —
 * mirrors the Ink CLI's useKillSwitch, which does the same on engage().
 */
function rejectPendingPermissions(webContentsId) {
  for (const [id, resolve] of pendingPermissions) {
    if (permissionIdBelongsToSession(id, webContentsId)) {
      resolve("no");
      pendingPermissions.delete(id);
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  const webContentsId = win.webContents.id;
  win.on("closed", () => {
    const engine = sessions.get(webContentsId);
    sessions.delete(webContentsId);
    rejectPendingPermissions(webContentsId);
    // engine.dispose() tears down backgroundManager/lspManager — process-wide
    // singletons, not scoped to this window's session. Calling it while other
    // windows still have an active session would kill their background
    // shells and LSP servers too. Only the window that empties the map
    // should trigger the teardown.
    if (sessions.size === 0) engine?.dispose();
  });
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("kritya:start", async (event, dir, opts) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (dir !== undefined && !isNonEmptyString(dir)) {
    return { ok: false, error: "Invalid workspace directory." };
  }
  if (!isValidStartOpts(opts)) {
    return { ok: false, error: "Invalid start options." };
  }
  try {
    const engine = await createEngineSession(dir || process.cwd(), opts || {});
    // Not dispose() on a pre-existing session here: it tears down the
    // process-wide backgroundManager/lspManager singletons other windows may
    // still depend on — restarting this window's session doesn't need that.
    sessions.set(event.sender.id, engine);
    return {
      ok: true,
      workspace: engine.workspace,
      provider: engine.provider,
      model: engine.model,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    void win;
  }
});

ipcMain.handle("kritya:list-sessions", (event) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return [];
  return SessionStore.listSessions(engine.workspace);
});

ipcMain.handle("kritya:load-session", (event, filePath) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };
  // filePath comes from the renderer; without this check "load this session"
  // is really "read any file this OS user can read" (path traversal / arbitrary
  // file read). Only files inside the current workspace's own session
  // directory — the ones kritya:list-sessions actually returned — are valid.
  if (!isNonEmptyString(filePath) || !SessionStore.isSessionFile(engine.workspace, filePath)) {
    return { ok: false, error: "Not a valid session file for this workspace." };
  }
  const messages = SessionStore.loadFile(filePath);
  engine.agent.loadHistory(messages);
  return { ok: true, messages };
});

ipcMain.handle("kritya:list-providers", () => listProviders(loadConfig()));

ipcMain.handle("kritya:list-models", () => {
  const config = loadConfig();
  return [
    ...CURATED_MODELS,
    ...(config.customModels ?? []).map((m) => ({ id: m.id, label: m.label || m.id })),
  ];
});

ipcMain.handle("kritya:switch-model", (event, model) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };
  if (!isNonEmptyString(model)) return { ok: false, error: "Invalid model id." };
  engine.setModel(model);
  return { ok: true, model: engine.model };
});

ipcMain.handle("kritya:switch-provider", async (event, provider, model) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };
  if (!isNonEmptyString(provider)) return { ok: false, error: "Invalid provider name." };
  if (model !== undefined && !isNonEmptyString(model)) {
    return { ok: false, error: "Invalid model id." };
  }
  try {
    const history = engine.agent.history;
    const next = await createEngineSession(engine.workspace, { provider, model });
    next.agent.loadHistory(history);
    // Not engine.dispose() here: it tears down the same process-wide
    // backgroundManager/lspManager singletons the new engine also uses, and
    // that other windows may still depend on — nothing to clean up just for
    // swapping the provider on one window's session.
    sessions.set(event.sender.id, next);
    return { ok: true, workspace: next.workspace, provider: next.provider, model: next.model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("kritya:prompt", async (event, text) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };
  if (typeof text !== "string") return { ok: false, error: "Invalid prompt text." };

  const send = (channel, payload) => event.sender.send(channel, payload);
  let reqCounter = 0;

  // update_tasks pushes checklist changes through ctx.onTasksUpdate, not the
  // per-turn AgentHandlers — wire it here so each window's task list only
  // reaches that window.
  engine.agent.ctx.onTasksUpdate = (tasks) => send("kritya:event", { type: "tasksUpdate", tasks });

  const handlers = {
    onTextDelta: (delta) => send("kritya:event", { type: "textDelta", delta }),
    onReasoningDelta: (delta) => send("kritya:event", { type: "reasoningDelta", delta }),
    onAssistantText: (text) => send("kritya:event", { type: "assistantText", text }),
    onToolStart: (id, name, summary) =>
      send("kritya:event", { type: "toolStart", id, name, summary }),
    onToolEnd: (id, name, summary, resultPreview, isError, resultSummary) =>
      send("kritya:event", {
        type: "toolEnd",
        id,
        name,
        summary,
        resultPreview,
        isError,
        resultSummary,
      }),
    onUsage: (usage) => send("kritya:event", { type: "usage", usage }),
    onRetry: (attempt, status) => send("kritya:event", { type: "retry", attempt, status }),
    requestPermission: (name, summary, diff, warning) => {
      const id = `perm-${event.sender.id}-${++reqCounter}`;
      send("kritya:event", { type: "permissionRequest", id, name, summary, diff, warning });
      return new Promise((resolve) => pendingPermissions.set(id, resolve));
    },
  };

  try {
    await engine.agent.runTurn(text, handlers, new AbortController().signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.on("kritya:permission-response", (_event, id, decision) => {
  if (!isNonEmptyString(id) || !isValidPermissionDecision(decision)) return;
  const resolve = pendingPermissions.get(id);
  if (resolve) {
    resolve(decision);
    pendingPermissions.delete(id);
  }
});

ipcMain.handle("kritya:kill", (event, reason) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };
  if (reason !== undefined && !isNonEmptyString(reason)) {
    return { ok: false, error: "Invalid kill reason." };
  }
  engine.agent.kill.engage(reason);
  rejectPendingPermissions(event.sender.id);
  return { ok: true };
});

ipcMain.handle("kritya:kill-release", (event) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };
  engine.agent.kill.release();
  return { ok: true };
});

ipcMain.handle("kritya:set-mode", (event, flags) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };
  if (!isValidModeFlags(flags)) return { ok: false, error: "Invalid mode flags." };
  const agent = engine.agent;
  if (flags.planMode !== undefined) agent.planMode = flags.planMode;
  if (flags.dryRunMode !== undefined) agent.dryRunMode = flags.dryRunMode;
  if (flags.acceptEdits !== undefined) agent.acceptEdits = flags.acceptEdits;
  // Mirrors the Ink CLI's /plan command: plan mode and auto-accept are
  // mutually exclusive, so entering plan mode always drops accept-edits.
  if (agent.planMode && agent.acceptEdits) agent.acceptEdits = false;
  return {
    ok: true,
    planMode: agent.planMode,
    dryRunMode: agent.dryRunMode,
    acceptEdits: agent.acceptEdits,
  };
});
