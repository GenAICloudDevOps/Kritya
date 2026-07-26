// CommonJS on purpose: Electron preload scripts run in an isolated context
// that historically only supports CJS reliably (even though package.json
// declares "type": "module" for the rest of the project). Keeping this the
// one non-ESM file avoids depending on version-specific ESM-preload support.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kritya", {
  start: (dir, opts) => ipcRenderer.invoke("kritya:start", dir, opts),
  sendPrompt: (text) => ipcRenderer.invoke("kritya:prompt", text),
  onEvent: (callback) => {
    ipcRenderer.on("kritya:event", (_event, payload) => callback(payload));
  },
  respondPermission: (id, decision) => ipcRenderer.send("kritya:permission-response", id, decision),
  listSessions: () => ipcRenderer.invoke("kritya:list-sessions"),
  loadSession: (filePath) => ipcRenderer.invoke("kritya:load-session", filePath),
  listProviders: () => ipcRenderer.invoke("kritya:list-providers"),
  listModels: () => ipcRenderer.invoke("kritya:list-models"),
  switchModel: (model) => ipcRenderer.invoke("kritya:switch-model", model),
  switchProvider: (provider, model) =>
    ipcRenderer.invoke("kritya:switch-provider", provider, model),
});
