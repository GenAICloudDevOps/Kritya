import type { ElicitationResult, ToolDef } from "../types.js";

const MAX_OPTIONS = 6;
const OTHER = "Other (type my own answer)";

/**
 * A clarifying question with pick-from-a-list options instead of open prose,
 * so the user can answer with a keypress. There is always a way to answer
 * outside the given options: picking "Other" opens a free-text field, so a
 * narrow option list never traps the user into a wrong answer.
 *
 * Deliberately not available to subagents — spawnAgents' isolated contexts
 * don't carry a UI to ask through, and a subagent blocking on user input
 * would stall the parallel batch it's part of.
 */
export const askUserTool: ToolDef = {
  name: "ask_user",
  description:
    "Ask the user one clarifying question with a short list of options to choose from, instead " +
    "of open-ended prose. Use this for make-or-break questions where you'd otherwise have to " +
    "guess — not for anything you can reasonably default and state your choice for. The user " +
    'can always type a custom answer via the automatic "Other" option, so keep the given list ' +
    `short (2-${MAX_OPTIONS - 1} options) rather than trying to enumerate every possibility.`,
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask, in one or two sentences" },
      options: {
        type: "array",
        description: `2 to ${MAX_OPTIONS - 1} short choices, each a few words`,
        items: { type: "string" },
      },
    },
    required: ["question", "options"],
  },
  requiresPermission: false,
  summarize: (args) => `Ask: ${String(args.question ?? "").slice(0, 80)}`,
  async execute(args, ctx) {
    const question = String(args.question ?? "").trim();
    if (!question) throw new Error("question must not be empty");
    const options = Array.isArray(args.options)
      ? (args.options as unknown[]).map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (options.length < 2) throw new Error("options must have at least 2 choices");
    if (options.length > MAX_OPTIONS - 1) {
      throw new Error(`options must have at most ${MAX_OPTIONS - 1} choices — keep it short`);
    }
    if (!ctx.requestElicitation) {
      return "ask_user is not available in this session — proceed with your best judgment instead.";
    }

    const picked = await ctx.requestElicitation(question, [
      { name: "choice", kind: "enum", label: question, options: [...options, OTHER] },
    ]);
    if (picked.action !== "accept")
      return "The user declined to answer — proceed with your best judgment.";
    const choice = picked.content.choice;
    if (choice !== OTHER) return `The user chose: ${choice}`;

    const typed: ElicitationResult = await ctx.requestElicitation(question, [
      { name: "answer", kind: "string", label: "Your answer" },
    ]);
    if (typed.action !== "accept")
      return "The user declined to answer — proceed with your best judgment.";
    return `The user answered: ${typed.content.answer}`;
  },
};
