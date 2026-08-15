import fs from "node:fs";
import path from "node:path";

/**
 * Staged new-project workflow: brainstorm -> spec -> plan -> build -> review.
 *
 * The order is deliberate. Brainstorm settles direction, spec pins down *what*
 * (contracts, data schema, acceptance criteria), plan works out *how*
 * (architecture and an ordered milestone sequence keyed to those criteria),
 * build implements it, and review checks the result against the spec that
 * authorized it. Each phase reads only the artifact immediately before it, so
 * a phase never re-derives something an earlier one already decided.
 *
 * Each phase produces a durable Markdown artifact under docs/<name>/ so the
 * flow survives across sessions, and the agent hard-stops for the user's
 * approval between phases. The current phase is tracked in .kritya/project.json
 * at the workspace root; both the slash commands (deterministically) and the
 * agent (via write_file, when running autonomously) keep it up to date.
 */
export type WorkflowPhase = "brainstorm" | "spec" | "plan" | "build" | "review" | "fix";

export const PHASE_ORDER: WorkflowPhase[] = [
  "brainstorm",
  "spec",
  "plan",
  "build",
  "review",
  "fix",
];

/** The slash command that runs each phase, for user-facing guidance. */
export const PHASE_COMMAND: Record<WorkflowPhase, string> = {
  brainstorm: "/flow-brainstorm",
  spec: "/flow-spec",
  plan: "/flow-plan",
  build: "/flow-build",
  review: "/flow-review",
  fix: "/flow-fix",
};

/** One-line summary of what each phase produces, for help text and the system prompt. */
export const PHASE_SUMMARY: Record<WorkflowPhase, string> = {
  brainstorm: "problem, users, MVP features, recommended stack",
  spec: "goals, non-goals, contracts, data schema, prioritized acceptance criteria, non-functional requirements",
  plan: "architecture and ordered milestones, flagged by risk (runs in read-only plan mode)",
  build: "the application code, with tests per acceptance criterion, written test-first",
  review: "spec-compliance, security, and reliability findings, with a scorecard up top",
  fix: "fixes for the review's findings, each re-verified",
};

/**
 * Word budget for each phase's artifact. These docs are read by every phase
 * that follows, so a bloated one is paid for repeatedly — the cap is a cost
 * control, not a style preference.
 */
const PHASE_WORD_CAP: Partial<Record<WorkflowPhase, number>> = {
  brainstorm: 600,
  spec: 1200,
  plan: 1000,
  review: 800,
  fix: 600,
};

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

/** Parse a phase name from user input (e.g. `/project goto spec`). */
export function parsePhase(v: string): WorkflowPhase | null {
  const t = v.trim().toLowerCase();
  return isPhase(t) ? t : null;
}

/**
 * Turn free text into a filesystem-safe project slug (docs/<slug>/…).
 *
 * The 40-character cap is trimmed back to the last whole word rather than cut
 * mid-token — an idea passed straight through used to produce folder names
 * like `a-script-that-reverses-a-string-python-s`.
 */
export function slugify(name: string): string {
  const full = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= SLUG_MAX) return full || "project";
  const cut = full.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf("-");
  // Keep whole words, unless the first word alone already exceeds the cap.
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "") || "project";
}

const SLUG_MAX = 40;

/** How many words a `name: idea` prefix may have before it reads as prose. */
const NAME_PREFIX_MAX_WORDS = 5;

/**
 * Split `/flow-brainstorm` input into a project name and the idea itself.
 *
 * `reverser: a script that reverses a string` names the project `reverser`.
 * Without a short leading `name:` the whole input is the idea, and the name is
 * derived from it as before — so naming is opt-in and nothing existing breaks.
 */
export function parseIdea(input: string): { name: string; idea: string } {
  const text = input.trim();
  const colon = text.indexOf(":");
  if (colon > 0) {
    const prefix = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();
    const words = prefix.split(/\s+/).filter(Boolean);
    // A prefix that carries sentence punctuation is prose, not a name.
    const looksLikeName =
      rest.length > 0 &&
      words.length > 0 &&
      words.length <= NAME_PREFIX_MAX_WORDS &&
      prefix.length <= SLUG_MAX &&
      !/[.,;!?—–]/.test(prefix);
    if (looksLikeName) return { name: prefix, idea: rest };
  }
  return { name: text, idea: text };
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

/**
 * End the active workflow. The docs/<name>/ artifacts are left alone — only the
 * pointer goes, so the agent stops being told to resume a project the user has
 * moved on from.
 */
export function clearProjectState(workspace: string): boolean {
  try {
    fs.rmSync(stateFile(workspace));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename the active project, moving its docs/<name>/ folder with it. Returns an
 * error message rather than throwing, since every caller is a slash command
 * reporting back to the user.
 *
 * Refuses to overwrite an existing folder: a rename that silently merged two
 * projects' artifacts would be indistinguishable from data loss.
 */
export function renameProject(
  workspace: string,
  from: string,
  to: string
): { ok: true; name: string } | { ok: false; error: string } {
  const next = slugify(to);
  const current = slugify(from);
  if (!to.trim()) return { ok: false, error: "Usage: /project rename <name>" };
  if (next === current) return { ok: true, name: next };

  const state = loadProjectState(workspace);
  if (!state) return { ok: false, error: "No active project workflow." };

  const srcDir = path.join(workspace, "docs", current);
  const dstDir = path.join(workspace, "docs", next);
  if (fs.existsSync(dstDir)) {
    return { ok: false, error: `docs/${next}/ already exists — pick another name.` };
  }
  try {
    // A project renamed before it wrote anything has no folder to move.
    if (fs.existsSync(srcDir)) {
      fs.mkdirSync(path.dirname(dstDir), { recursive: true });
      fs.renameSync(srcDir, dstDir);
    }
  } catch (err) {
    return { ok: false, error: `Could not move docs/${current}/: ${(err as Error).message}` };
  }
  saveProjectState(workspace, next, state.phase);
  return { ok: true, name: next };
}

/** The phase before `phase` in PHASE_ORDER, or null for the first one. */
export function previousPhase(phase: WorkflowPhase): WorkflowPhase | null {
  const i = PHASE_ORDER.indexOf(phase);
  return i > 0 ? PHASE_ORDER[i - 1] : null;
}

/** The phase after `phase` in PHASE_ORDER, or null for the last one. */
export function nextPhase(phase: WorkflowPhase): WorkflowPhase | null {
  const i = PHASE_ORDER.indexOf(phase);
  return i >= 0 && i < PHASE_ORDER.length - 1 ? PHASE_ORDER[i + 1] : null;
}

/**
 * Relative path of the artifact a phase produces. Build is the exception: it
 * produces application code, not a single document.
 */
export function artifactPath(name: string, phase: WorkflowPhase): string | null {
  if (phase === "build") return null;
  return `docs/${slugify(name)}/${phase}.md`;
}

/** Whether a phase's artifact has actually been written (non-empty). */
export function artifactExists(workspace: string, name: string, phase: WorkflowPhase): boolean {
  const rel = artifactPath(name, phase);
  if (rel === null) return true; // build has no doc to check
  try {
    return fs.statSync(path.join(workspace, rel)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Why `phase` isn't ready to run yet, or null if it is. A phase is ready when
 * the one before it left its artifact behind — otherwise the prompt would tell
 * the agent to "read docs/x/spec.md first" for a file that was never written,
 * and it would improvise the requirements instead.
 */
export function phaseBlocker(workspace: string, name: string, phase: WorkflowPhase): string | null {
  const prev = previousPhase(phase);
  if (!prev || artifactExists(workspace, name, prev)) return null;
  const rel = artifactPath(name, prev);
  return (
    `The ${phase} phase reads ${rel}, which doesn't exist yet. ` +
    `Run ${PHASE_COMMAND[prev]} first (${PHASE_SUMMARY[prev]}).`
  );
}

/**
 * Artifacts that are now older than one they depend on, e.g. spec.md edited
 * after plan.md was already written from it. This never blocks a phase — a
 * stale downstream doc might still be exactly what the user wants — it only
 * warns, at the two points that matter: right before a phase runs (its input
 * may be stale) and in `/project` status (a standing view of the whole chain).
 * `build` has no artifact file to timestamp, so a stale `plan.md` also flags
 * "the code already built from it" once the project has reached `build` or
 * beyond — there is no way to prove the code is out of sync without a file to
 * check, but staying silent would be worse: silent drift between spec and
 * code is exactly the failure mode the whole staged workflow exists to avoid.
 */
export function staleArtifacts(
  workspace: string,
  name: string,
  currentPhase: WorkflowPhase
): string[] {
  const mtime = (phase: WorkflowPhase): number | null => {
    const rel = artifactPath(name, phase);
    if (!rel) return null;
    try {
      return fs.statSync(path.join(workspace, rel)).mtimeMs;
    } catch {
      return null;
    }
  };
  const reachedBuild = PHASE_ORDER.indexOf(currentPhase) >= PHASE_ORDER.indexOf("build");

  const warnings: string[] = [];
  let planIsStale = false;
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const upstream = PHASE_ORDER[i];
    const upstreamMtime = mtime(upstream);
    if (upstreamMtime === null) continue;
    for (const downstream of PHASE_ORDER.slice(i + 1)) {
      if (downstream === "build") continue; // no doc to compare — handled below
      const downstreamRel = artifactPath(name, downstream)!;
      const downstreamMtime = mtime(downstream);
      if (downstreamMtime === null) continue;
      if (downstreamMtime < upstreamMtime) {
        const upstreamRel = artifactPath(name, upstream)!;
        warnings.push(
          `⚠ ${downstreamRel} was written before ${upstreamRel}'s latest change — it may be stale.`
        );
        if (downstream === "plan") planIsStale = true;
      }
    }
  }
  // Only plan.md feeds build directly; spec/brainstorm feed build only through
  // plan.md, so this fires once, off of plan.md's own staleness above, rather
  // than once per upstream phase.
  if (planIsStale && reachedBuild) {
    warnings.push(
      `⚠ plan.md changed after the code was built from it — the build may no longer match.`
    );
  }
  return warnings;
}

/**
 * During plan mode all mutating tools are blocked — except the active project's
 * own planning documents. Scoping this to docs/<slug>/ matters: plan mode's
 * promise is that nothing outside the plan changes, and a workspace-wide
 * docs/**\/*.md exemption would let a read-only phase overwrite unrelated
 * documentation (a project's ARCHITECTURE.md, its README docs) as a side
 * effect. With no active project there is no planning doc to write, so nothing
 * is exempt.
 */
export function isPlanningDocWrite(
  workspace: string,
  toolName: string,
  args: Record<string, unknown>,
  projectName?: string | null
): boolean {
  if (toolName !== "write_file" && toolName !== "edit_file") return false;
  if (!projectName) return false;
  const raw = String(args.path ?? "");
  if (!raw) return false;
  // Resolve exactly the way the write tools do (resolveSafe -> path.resolve),
  // then compare relative to the workspace. Models routinely pass an absolute
  // path even when told the argument is workspace-relative, and a plain string
  // prefix test misses those — which left plan mode blocking the very document
  // the plan phase exists to write.
  const rel = path.relative(path.resolve(workspace), path.resolve(workspace, raw));
  const p = rel.split(path.sep).join("/");
  // Anything that resolved outside the workspace is not a planning doc.
  if (!p || p === ".." || p.startsWith("../")) return false;
  const dir = `docs/${slugify(projectName)}/`;
  if (!p.startsWith(dir)) return false;
  const rest = p.slice(dir.length);
  return rest.endsWith(".md") && rest.length > 3 && !rest.startsWith(".");
}

function capLine(phase: WorkflowPhase): string {
  const cap = PHASE_WORD_CAP[phase];
  return cap
    ? `Keep it under ~${cap} words — every later phase reads this document, so length here is paid for several times over. Be dense, not verbose.\n`
    : "";
}

/**
 * Write first, ask second. Models otherwise present the artifact's contents in
 * chat and ask for approval *before* writing it — which strands the phase: the
 * user approves, but the file the next phase reads was never created, and in
 * the plan phase the belated write lands after plan mode has already been
 * turned off by the next command.
 */
function approvalLine(phase: WorkflowPhase, artifact: string | null): string {
  const next = nextPhase(phase);
  const write = artifact
    ? `Write ${artifact} BEFORE you ask for anything. Approval comes after the file exists — ` +
      `never show the document in chat and ask whether to save it. `
    : "";
  if (!next) return `${write}Finish by summarizing the findings for the user.`;
  return (
    `${write}Then summarize what you produced in a few lines and ask the user to approve ` +
    `before the ${next} phase (they will run ${PHASE_COMMAND[next]}). Do not advance on your own.`
  );
}

/** The instruction sent to the agent to carry out a given phase. */
export function phasePrompt(name: string, phase: WorkflowPhase, userInput: string): string {
  const slug = slugify(name);
  const extra = userInput.trim() ? `\n\nUser input for this phase:\n${userInput.trim()}` : "";
  const cap = capLine(phase);
  const approve = approvalLine(phase, artifactPath(name, phase));
  switch (phase) {
    case "brainstorm":
      return (
        `PROJECT WORKFLOW — BRAINSTORM phase for project "${slug}".\n` +
        `Be a sharp product thinking-partner. Clarify the problem, the target users, the core ` +
        `features (MVP vs. later), and recommend a concrete tech stack with a short rationale. ` +
        `If you can make a sensible default choice (e.g. a common tech-stack pick), make it and ` +
        `state your reasoning in the doc rather than asking — reserve questions for the make-or` +
        `-break ones you genuinely cannot guess (who the user is, what the MVP must include). For ` +
        `each one, use ask_user with a short list of concrete options (e.g. candidate stacks or ` +
        `feature scopes) rather than an open-ended question in chat — the user answers faster from ` +
        `a list, and can always type their own answer via the option ask_user adds automatically. ` +
        `When recommending a stack, name the trade-off in one clause (e.g. "SQLite: simplest, no ` +
        `multi-user support" vs. "Postgres: more setup, scales past one writer") rather than just ` +
        `announcing a pick. Once resolved, write your synthesis to docs/${slug}/brainstorm.md.\n` +
        cap +
        `Do NOT write application code, do NOT design the architecture, and do NOT specify ` +
        `interfaces yet — this phase settles direction only.\n` +
        approve +
        extra
      );
    case "spec":
      return (
        `PROJECT WORKFLOW — SPEC phase for project "${slug}".\n` +
        `Read docs/${slug}/brainstorm.md first — that is your only required input. Write a ` +
        `concrete spec/PRD to docs/${slug}/spec.md covering: goals, non-goals, user stories, ` +
        `API/interface contracts, the data schema, success metrics, and acceptance criteria.\n` +
        `Acceptance criteria are the contract the build and review phases are held to, so make ` +
        `each one specific and checkable — a criterion that cannot fail a test is not a criterion. ` +
        `Label them AC1, AC2, AC3, … under an "Acceptance criteria" heading; later phases cite ` +
        `those labels, so they must be stable identifiers, not positions in the document. Mark ` +
        `each one MUST or LATER (must-have for this build, vs. a later iteration) — if build ever ` +
        `runs short on time or scope, LATER is what gets cut first, and that decision belongs here, ` +
        `not left for build to guess.\n` +
        `Before finalizing, use ask_user to ask whether this project: handles sensitive or ` +
        `personal data, needs auth/access control, takes input from outside the user's own ` +
        `machine, has real reliability or performance stakes, or needs CI/logging from day one. ` +
        `If any answer is yes, add a "Non-functional requirements" section with concrete, ` +
        `checkable requirements for it — label security ones SEC1, SEC2, … and reliability/` +
        `performance/observability ones REL1, REL2, …, same stable-identifier rule as the ACs. ` +
        `If none apply, write one line saying so and move on — do not invent security or ` +
        `reliability requirements a small project doesn't need.\n` +
        cap +
        `Do NOT design the architecture, choose a folder layout, or sequence the work — that is ` +
        `the plan phase's job. Do NOT write application code.\n` +
        approve +
        extra
      );
    case "plan":
      return (
        `PROJECT WORKFLOW — PLAN phase for project "${slug}". Plan mode is ON (read-only for code).\n` +
        `Read docs/${slug}/spec.md first — that is your only required input. Design how to build ` +
        `it: folder/module layout, dependencies, external services, and an ordered, ` +
        `milestone-based build sequence. Each milestone must cite the acceptance criteria it ` +
        `satisfies by their AC labels (e.g. "satisfies AC2, AC5") — never by line numbers or ` +
        `positions in spec.md, which change the moment the file is edited — and be ` +
        `independently testable.\n` +
        `Note which milestones are genuinely independent of each other — the build phase uses ` +
        `that to parallelize.\n` +
        `Tag each milestone RISKY or ROUTINE. RISKY means it depends on something you haven't ` +
        `confirmed works — an external API, a library behavior, a performance assumption — or ` +
        `touches a part of the system where a wrong guess is expensive to unwind. Say what makes ` +
        `it risky in one clause. This is what tells the user, and the build phase, where to slow ` +
        `down and check assumptions instead of plowing straight through.\n` +
        `If spec.md has a "Non-functional requirements" section: for each milestone that cites a ` +
        `SEC or REL label, note the trust boundary or failure mode it implies (e.g. "this endpoint ` +
        `takes unauthenticated input" or "this call can time out") and flag any dependency it ` +
        `needs that's worth vetting for license or maintenance risk before adopting it. If spec.md ` +
        `has no such section, skip this — don't invent security or reliability process for a ` +
        `project that doesn't need it.\n` +
        `Write the plan to docs/${slug}/plan.md — writing Markdown under docs/${slug}/ is allowed ` +
        `in plan mode; application code and shell are still blocked. That write will succeed, so ` +
        `do not ask the user to turn plan mode off in order to save the plan, and use the ` +
        `workspace-relative path exactly as given.\n` +
        cap +
        `Do NOT restate the spec's requirements, contracts, or data schema — reference them by ` +
        `number instead. Duplicated requirements drift.\n` +
        approve +
        extra
      );
    case "build":
      return (
        `PROJECT WORKFLOW — BUILD phase for project "${slug}". Plan mode is OFF.\n` +
        `Read docs/${slug}/plan.md — it is your build order. Call update_tasks first with the full ` +
        `milestone breakdown (one task per milestone), then keep it current as you go: mark a ` +
        `milestone in_progress the moment you start it and done the moment its tests pass — call ` +
        `update_tasks again each time a milestone's status changes, not just once at the start. ` +
        `This is the user's only live view into a build that can otherwise run for a long time in ` +
        `silence, so do not let the checklist go stale.\n` +
        `RISKY milestones (per plan.md's tags): confirm the assumption that makes them risky before ` +
        `writing the rest of the milestone, so a wrong guess is caught early and cheaply, not after ` +
        `everything downstream is built on top of it.\n` +
        `Tests are part of the deliverable, not an afterthought: for each milestone, consult the ` +
        `AC-labelled acceptance criteria it cites in docs/${slug}/spec.md (read just those, not the ` +
        `whole file again). Write the test before the code it tests: write it, run it, confirm it ` +
        `fails for the right reason, then write the minimal implementation that makes it pass. Do ` +
        `not write the implementation first and backfill a test that already passes — that proves ` +
        `nothing. Do not mark a milestone done until its tests actually run and pass. Report ` +
        `pass/fail per milestone, not just what you changed.\n` +
        `If a milestone cites a SEC or REL label from spec.md's Non-functional requirements ` +
        `section, also write a negative/failure-path test for it — invalid input, an unauthorized ` +
        `attempt, a timeout or dependency failure, whatever the label implies — not just the ` +
        `happy-path test for its AC. A milestone touching sensitive data or access control is not ` +
        `done until that test exists and passes too.\n` +
        `If a milestone's tests fail twice in a row after genuine fix attempts, stop working that ` +
        `milestone: mark it blocked in the task list with why, move on to milestones that don't ` +
        `depend on it, and report the block to the user at the end instead of retrying indefinitely.\n` +
        `If the workspace is a git repository and the plan marks milestones as independent, ` +
        `dispatch them with spawn_write_agent in parallel — each subagent gets a fresh context ` +
        `and its own branch, which keeps this conversation from accumulating the full text of ` +
        `every file you touch. Give each one the milestone's criteria verbatim; never a summary ` +
        `of them. Build sequentially otherwise.\n` +
        approve +
        extra
      );
    case "review":
      return (
        `PROJECT WORKFLOW — REVIEW phase for project "${slug}".\n` +
        `Review what the build phase produced. Dispatch all of these as read-only subagents in ` +
        `one spawn_agent call so they run concurrently and their tool output never enters this ` +
        `conversation:\n` +
        `  1. SPEC COMPLIANCE — check the implementation against every AC-labelled acceptance ` +
        `criterion in docs/${slug}/spec.md. For each: met, not met, or partially met, with the ` +
        `file and line that decides it. Confirm the tests for each criterion exist and pass.\n` +
        `  2. SECURITY — review the actual code and diffs for injection, authentication and ` +
        `authorization gaps, secret handling, unsafe deserialization, path traversal, SSRF, ` +
        `dependency risk, and missing input validation. Report concrete exploitable findings ` +
        `with file and line, not generic advice.\n` +
        `  3. RELIABILITY — review error handling, edge cases, resource cleanup, and whether every ` +
        `REL-labelled requirement in docs/${slug}/spec.md's Non-functional requirements section ` +
        `(if any) is actually met. Report concrete failure scenarios — what input or condition ` +
        `breaks it, and what happens when it does — with file and line, not generic advice. If ` +
        `spec.md has no REL labels, still check for unhandled errors and missing cleanup; skip ` +
        `only the requirement-compliance half of the remit.\n` +
        `Each subagent starts with no context, so give it the project slug, the paths it needs, ` +
        `and its full remit in the task string.\n` +
        `Open docs/${slug}/review.md with a short SCORECARD before the detailed findings — one ` +
        `line, e.g. "4/6 acceptance criteria met · 2 security findings (1 high, 1 medium) · 1 ` +
        `reliability finding" — so the headline is visible without reading the whole document. ` +
        `Then list the findings grouped by ` +
        `severity, each with a file:line and a concrete suggested fix. State plainly whether the ` +
        `build satisfies the spec. Do not fix anything in this phase — reviewing and fixing in one ` +
        `pass produces neither a trustworthy review nor a reviewed fix.\n` +
        cap +
        approve +
        extra
      );
    case "fix":
      return (
        `PROJECT WORKFLOW — FIX phase for project "${slug}". Plan mode is OFF.\n` +
        `Read docs/${slug}/review.md — it lists every finding from the review phase. Address each ` +
        `one: not-met or partially-met acceptance criteria, and every security finding, in severity ` +
        `order. Skip only findings the user has explicitly told you to leave (say which and why in ` +
        `the writeup); everything else gets fixed.\n` +
        `For each finding you fix, note what changed and why in a few words — this becomes ` +
        `docs/${slug}/fix.md, so keep the running log as you go rather than reconstructing it at ` +
        `the end.\n` +
        `After the fixes, dispatch a read-only subagent to re-check only what you touched: give it ` +
        `the specific findings you addressed and the files you changed, and have it confirm each ` +
        `finding is actually resolved (tests pass, the AC is now met, the vulnerability is closed) ` +
        `rather than re-running the full spec-compliance and security sweep from scratch. Record its ` +
        `verdict per finding — fixed, still open, or newly broken — in docs/${slug}/fix.md.\n` +
        `If anything is still open after the subagent's check, say so plainly; do not report success ` +
        `on a finding that didn't actually verify as fixed.\n` +
        cap +
        `Write docs/${slug}/fix.md BEFORE you ask for anything. Approval comes after the file ` +
        `exists — never show the writeup in chat and ask whether to save it. Then summarize the ` +
        `outcome in a few lines. If anything is still open, tell the user they can run ` +
        `${PHASE_COMMAND.review} to re-check the whole build, or run ${PHASE_COMMAND.fix} again ` +
        `once they've decided how to handle what's left.\n` +
        extra
      );
  }
}
