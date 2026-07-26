const messagesEl = document.getElementById("messages");
const workspaceLabel = document.getElementById("workspace-label");
const form = document.getElementById("input-form");
const input = document.getElementById("prompt-input");
const permissionPrompt = document.getElementById("permission-prompt");
const permissionText = document.getElementById("permission-text");
const permissionDiff = document.getElementById("permission-diff");

let assistantBubble = null;

function addMessage(text, cls) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function init() {
  const result = await window.kritya.start(".");
  if (result.ok) {
    workspaceLabel.textContent = `${result.workspace} — ${result.model}`;
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
