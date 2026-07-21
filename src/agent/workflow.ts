import fs from "node:fs";
import path from "node:path";

/**
 * Staged new-project workflow: brainstorm -> plan -> spec -> build.
 *
 * Each phase produces a durable Markdown artifact under docs/<name>/ so the
 * flow survives across sessions, and the agent hard-stops for the user's
 * approval between phases. The current phase is tracked in .kritya/project.json
 * at the workspace root; both the slash commands (deterministically) and the
 * agent (via write_file, when running autonomously) keep it up to date.
 */
export type WorkflowPhase = "brainstorm" | "plan" | "spec" | "build";

export const PHASE_ORDER: WorkflowPhase[] = ["brainstorm", "plan", "spec", "build"];

export interface ProjectState {
  /** Slug used for the docs/<name>/ artifact folder. */
  name: string;
  phase: WorkflowPhase;
  /** ISO timestamp of the last phase change. */
  updatedAt: string;
}

const STATE_REL = path.join(".kritya", "project.json");

export function stateFile(workspace: string): string {
  return path.join(workspace, STATE_REL);
}

function isPhase(v: unknown): v is WorkflowPhase {
  return typeof v === "string" && (PHASE_ORDER as string[]).includes(v);
}

/** Turn free text into a filesystem-safe project slug (docs/<slug>/…). */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "project"
  );
}

export function loadProjectState(workspace: string): ProjectState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(stateFile(workspace), "utf8")
    ) as Partial<ProjectState>;
    if (!parsed || typeof parsed.name !== "string" || !isPhase(parsed.phase)) return null;
    return { name: parsed.name, phase: parsed.phase, updatedAt: parsed.updatedAt ?? "" };
  } catch {
    return null;
  }
}

export function saveProjectState(
  workspace: string,
  name: string,
  phase: WorkflowPhase
): ProjectState {
  const state: ProjectState = {
    name: slugify(name),
    phase,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(stateFile(workspace)), { recursive: true });
  fs.writeFileSync(stateFile(workspace), JSON.stringify(state, null, 2) + "\n");
  return state;
}

/** Relative path of the artifact a phase produces (build has no single doc). */
export function artifactPath(name: string, phase: WorkflowPhase): string | null {
  if (phase === "build") return null;
  return `docs/${slugify(name)}/${phase}.md`;
}

/**
 * During plan mode all mutating tools are blocked — except the planning
 * documents themselves. Any Markdown file under docs/ counts as a planning
 * doc, so the plan phase can persist docs/<name>/plan.md while application
 * code and shell stay read-only.
 */
export function isPlanningDocWrite(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName !== "write_file" && toolName !== "edit_file") return false;
  const p = String(args.path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return /^docs\/.+\.md$/.test(p);
}

/** The instruction sent to the agent to carry out a given phase. */
export function phasePrompt(name: string, phase: WorkflowPhase, userInput: string): string {
  const slug = slugify(name);
  const extra = userInput.trim() ? `\n\nUser input for this phase:\n${userInput.trim()}` : "";
  switch (phase) {
    case "brainstorm":
      return (
        `PROJECT WORKFLOW — BRAINSTORM phase for project "${slug}".\n` +
        `Be a sharp product thinking-partner. Clarify the problem, the target users, the core ` +
        `features (MVP vs. later), and recommend a concrete tech stack with a short rationale. ` +
        `Ask any make-or-break questions you still have, then write your synthesis to ` +
        `docs/${slug}/brainstorm.md.\n` +
        `Do NOT write application code and do NOT design the architecture yet. Finish by ` +
        `summarizing the direction and asking the user to approve before the plan phase ` +
        `(they will run /plan).${extra}`
      );
    case "plan":
      return (
        `PROJECT WORKFLOW — PLAN phase for project "${slug}". Plan mode is ON (read-only for code).\n` +
        `Read docs/${slug}/brainstorm.md first. Design the architecture: folder/module layout, ` +
        `dependencies, data model, external services, and an ordered, milestone-based build ` +
        `sequence. Write the plan to docs/${slug}/plan.md — writing Markdown docs is allowed in ` +
        `plan mode; application code and shell are still blocked.\n` +
        `Finish by asking the user to approve before the spec phase (they will run /spec).${extra}`
      );
    case "spec":
      return (
        `PROJECT WORKFLOW — SPEC phase for project "${slug}".\n` +
        `Read docs/${slug}/plan.md first. Write a concrete spec/PRD to docs/${slug}/spec.md: ` +
        `goals, non-goals, user stories, API/interface contracts, data schema, success metrics, ` +
        `and acceptance criteria grouped into phased milestones.\n` +
        `Do NOT write application code yet. Finish by asking the user to approve before the build ` +
        `phase (they will run /build).${extra}`
      );
    case "build":
      return (
        `PROJECT WORKFLOW — BUILD phase for project "${slug}". Plan mode is OFF.\n` +
        `Implement the project by following docs/${slug}/spec.md and docs/${slug}/plan.md. Call ` +
        `update_tasks first with the milestone breakdown, then build milestone by milestone, ` +
        `verifying as you go (install dependencies, run builds/tests). Report what you changed.${extra}`
      );
  }
}
