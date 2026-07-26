const messagesEl = document.getElementById("messages");
const workspaceLabel = document.getElementById("workspace-label");
const form = document.getElementById("input-form");
const input = document.getElementById("prompt-input");
const permissionPrompt = document.getElementById("permission-prompt");
const permissionText = document.getElementById("permission-text");
const permissionDiff = document.getElementById("permission-diff");
const sessionListEl = document.getElementById("session-list");
const newConversationBtn = document.getElementById("new-conversation");
const providerSelect = document.getElementById("provider-select");
const modelSelect = document.getElementById("model-select");

let assistantBubble = null;
let currentWorkspace = ".";

function addMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function clearMessages() {
  messagesEl.innerHTML = "";
  assistantBubble = null;
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

newConversationBtn.addEventListener("click", async () => {
  const result = await window.kritya.start(currentWorkspace);
  if (result.ok) {
    clearMessages();
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
  const result = await window.kritya.sendPrompt(text);
  if (!result.ok) addMessage(result.error, "error");
});

window.kritya.onEvent((evt) => {
  switch (evt.type) {
    case "textDelta":
      if (!assistantBubble) assistantBubble = addMessage("", "assistant");
      assistantBubble.textContent += evt.delta;
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    case "assistantText":
      assistantBubble = null;
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
