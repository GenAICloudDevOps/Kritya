import { renderMarkdown } from "../../dist/electron/markdown.js";

const messagesEl = document.getElementById("messages");
const workspaceLabel = document.getElementById("workspace-label");
const usageLabel = document.getElementById("usage-label");
const retryLabel = document.getElementById("retry-label");
const stopButton = document.getElementById("stop-button");
const killBanner = document.getElementById("kill-banner");
const resumeButton = document.getElementById("resume-button");
const taskListEl = document.getElementById("task-list");
const form = document.getElementById("input-form");
const input = document.getElementById("prompt-input");
const permissionPrompt = document.getElementById("permission-prompt");
const permissionText = document.getElementById("permission-text");
const permissionDiff = document.getElementById("permission-diff");
const sessionListEl = document.getElementById("session-list");
const newConversationBtn = document.getElementById("new-conversation");
const providerSelect = document.getElementById("provider-select");
const modelSelect = document.getElementById("model-select");
const planModeToggle = document.getElementById("plan-mode-toggle");
const dryRunToggle = document.getElementById("dry-run-toggle");
const acceptEditsToggle = document.getElementById("accept-edits-toggle");

let assistantBubble = null;
let assistantText = "";
let currentWorkspace = ".";

function addMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  if (cls === "assistant") {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function clearMessages() {
  messagesEl.innerHTML = "";
  assistantBubble = null;
  assistantText = "";
}

/** Flattens an OpenAI-style message content (string or content-part array) to plain text. */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function replayHistory(messages) {
  clearMessages();
  for (const message of messages) {
    if (message.role === "user") {
      const text = contentToText(message.content);
      if (text) addMessage(text, "user");
    } else if (message.role === "assistant") {
      const text = contentToText(message.content);
      if (text) addMessage(text, "assistant");
    }
  }
}

async function refreshSessionList() {
  const sessions = await window.kritya.listSessions();
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    const titleEl = document.createElement("div");
    titleEl.className = "session-title";
    titleEl.textContent = s.title;
    const dateEl = document.createElement("div");
    dateEl.className = "session-date";
    dateEl.textContent = s.date;
    item.append(titleEl, dateEl);
    item.addEventListener("click", async () => {
      const result = await window.kritya.loadSession(s.file);
      if (result.ok) replayHistory(result.messages);
    });
    sessionListEl.appendChild(item);
  }
}

async function refreshPickers(activeProvider, activeModel) {
  const [providers, models] = await Promise.all([
    window.kritya.listProviders(),
    window.kritya.listModels(),
  ]);
  providerSelect.innerHTML = "";
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.hasKey ? p.name : `${p.name} (no key)`;
    opt.disabled = !p.hasKey;
    if (p.name === activeProvider) opt.selected = true;
    providerSelect.appendChild(opt);
  }
  modelSelect.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === activeModel) opt.selected = true;
    modelSelect.appendChild(opt);
  }
}

function renderTasks(tasks) {
  if (!tasks || tasks.length === 0) {
    taskListEl.classList.add("hidden");
    taskListEl.innerHTML = "";
    return;
  }
  taskListEl.classList.remove("hidden");
  taskListEl.innerHTML = "";
  for (const t of tasks) {
    const div = document.createElement("div");
    div.className = `task-item ${t.status}`;
    div.textContent = `${t.status === "done" ? "☑" : t.status === "in_progress" ? "▶" : "☐"} ${t.text}`;
    taskListEl.appendChild(div);
  }
}

function formatUsage(usage) {
  const total = usage.promptTokens + usage.completionTokens;
  const approx = usage.estimated ? "~" : "";
  return `${approx}${total.toLocaleString()} tokens`;
}

newConversationBtn.addEventListener("click", async () => {
  const result = await window.kritya.start(currentWorkspace);
  if (result.ok) {
    clearMessages();
    renderTasks([]);
    workspaceLabel.textContent = `${result.workspace} — ${result.model}`;
    await Promise.all([refreshSessionList(), refreshPickers(result.provider, result.model)]);
  } else {
    addMessage(result.error, "error");
  }
});

providerSelect.addEventListener("change", async () => {
  const result = await window.kritya.switchProvider(providerSelect.value);
  if (result.ok) {
    workspaceLabel.textContent = `${currentWorkspace} — ${result.model}`;
    await refreshPickers(result.provider, result.model);
  } else {
    addMessage(result.error, "error");
  }
});

modelSelect.addEventListener("change", async () => {
  const result = await window.kritya.switchModel(modelSelect.value);
  if (result.ok) {
    workspaceLabel.textContent = `${currentWorkspace} — ${result.model}`;
  } else {
    addMessage(result.error, "error");
  }
});

async function applyMode(flags) {
  const result = await window.kritya.setMode(flags);
  if (!result.ok) {
    addMessage(result.error, "error");
    return;
  }
  planModeToggle.checked = result.planMode;
  dryRunToggle.checked = result.dryRunMode;
  acceptEditsToggle.checked = result.acceptEdits;
}

planModeToggle.addEventListener("change", () => applyMode({ planMode: planModeToggle.checked }));
dryRunToggle.addEventListener("change", () => applyMode({ dryRunMode: dryRunToggle.checked }));
acceptEditsToggle.addEventListener("change", () =>
  applyMode({ acceptEdits: acceptEditsToggle.checked })
);

stopButton.addEventListener("click", async () => {
  await window.kritya.kill();
  stopButton.classList.add("hidden");
  killBanner.classList.remove("hidden");
});

resumeButton.addEventListener("click", async () => {
  await window.kritya.killRelease();
  killBanner.classList.add("hidden");
});

async function init() {
  const result = await window.kritya.start(".");
  if (result.ok) {
    currentWorkspace = result.workspace;
    workspaceLabel.textContent = `${result.workspace} — ${result.model}`;
    await Promise.all([refreshSessionList(), refreshPickers(result.provider, result.model)]);
  } else {
    workspaceLabel.textContent = "Failed to start";
    addMessage(result.error, "error");
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMessage(text, "user");
  assistantBubble = null;
  assistantText = "";
  retryLabel.classList.add("hidden");
  stopButton.classList.remove("hidden");
  const result = await window.kritya.sendPrompt(text);
  stopButton.classList.add("hidden");
  if (!result.ok) addMessage(result.error, "error");
});

window.kritya.onEvent((evt) => {
  switch (evt.type) {
    case "textDelta":
      if (!assistantBubble) assistantBubble = addMessage("", "assistant");
      assistantText += evt.delta;
      assistantBubble.innerHTML = renderMarkdown(assistantText);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    case "assistantText":
      assistantBubble = null;
      assistantText = "";
      break;
    case "toolStart":
      addMessage(`→ ${evt.name}: ${evt.summary}`, "tool");
      break;
    case "toolEnd":
      addMessage(
        `${evt.isError ? "✗" : "✓"} ${evt.name}: ${evt.resultSummary || evt.resultPreview}`,
        "tool"
      );
      break;
    case "usage":
      usageLabel.textContent = formatUsage(evt.usage);
      break;
    case "retry":
      retryLabel.textContent = `retrying (attempt ${evt.attempt}${evt.status ? `, HTTP ${evt.status}` : ""})…`;
      retryLabel.classList.remove("hidden");
      break;
    case "tasksUpdate":
      renderTasks(evt.tasks);
      break;
    case "permissionRequest":
      permissionText.textContent = `${evt.name}: ${evt.summary}${evt.warning ? `\n\n⚠ ${evt.warning}` : ""}`;
      permissionDiff.textContent = evt.diff || "";
      permissionPrompt.classList.remove("hidden");
      permissionPrompt.dataset.requestId = evt.id;
      break;
    default:
      break;
  }
});

document.getElementById("permission-yes").addEventListener("click", () => respond("yes"));
document.getElementById("permission-always").addEventListener("click", () => respond("always"));
document.getElementById("permission-no").addEventListener("click", () => respond("no"));

function respond(decision) {
  const id = permissionPrompt.dataset.requestId;
  window.kritya.respondPermission(id, decision);
  permissionPrompt.classList.add("hidden");
}

init();
