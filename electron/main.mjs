// Electron main process. Deliberately thin: all agent behavior lives in the
// compiled core (dist/engine.js, built from src/engine.ts), which is the
// same contract the Ink CLI relies on. This file should only ever need to
// change when the *shape* of that contract changes, not when tools,
// providers, or agent internals change.
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngineSession } from "../dist/engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** One engine session per renderer window, keyed by WebContents id. */
const sessions = new Map();
/** Pending permission prompts, keyed by a request id, resolved by the renderer's reply. */
const pendingPermissions = new Map();

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
    sessions.get(webContentsId)?.dispose();
    sessions.delete(webContentsId);
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

ipcMain.handle("kritya:start", async (event, dir) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try {
    const engine = await createEngineSession(dir || process.cwd());
    sessions.set(event.sender.id, engine);
    return { ok: true, workspace: engine.workspace, model: engine.model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    void win;
  }
});

ipcMain.handle("kritya:prompt", async (event, text) => {
  const engine = sessions.get(event.sender.id);
  if (!engine) return { ok: false, error: "No active session — call kritya:start first." };

  const send = (channel, payload) => event.sender.send(channel, payload);
  let reqCounter = 0;

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
  const resolve = pendingPermissions.get(id);
  if (resolve) {
    resolve(decision);
    pendingPermissions.delete(id);
  }
});
