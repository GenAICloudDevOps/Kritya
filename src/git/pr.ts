import { execFileSync } from "node:child_process";
import type { GitCommit } from "./git.js";

/**
 * Opening a GitHub pull request from the terminal: parse the repo from the
 * origin remote, push the branch, and call the GitHub REST API.
 *
 * Kept separate from the git helpers because this half talks to a network
 * API rather than the local repo — and because every piece of it (URL
 * parsing, title derivation, token lookup) is pure enough to test without
 * touching either.
 */

/** Owner and repo parsed from a git remote URL. */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Parse `owner/repo` out of the usual origin URL shapes:
 * `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)`,
 * and `ssh://git@github.com/owner/repo(.git)`. Returns null for anything
 * else — a non-GitHub remote, or a shape we do not recognise, is not
 * something `/pr` can open a pull request against.
 */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const t = url.trim();
  const m =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(t) ??
    /^(?:ssh:\/\/)?git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(t) ??
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(t);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/** Where a GitHub token came from, for the user-facing message. */
export type TokenSource = "GITHUB_TOKEN" | "gh CLI";

/**
 * Find a token for the GitHub API without asking the user to paste one into
 * chat. `GITHUB_TOKEN` wins when set; otherwise `gh auth token` is tried
 * when the gh CLI is installed and logged in. Returns null when neither
 * works, and the caller tells the user exactly how to provide one.
 */
export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): {
  token: string;
  source: TokenSource;
} | null {
  const fromEnv = env.GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "GITHUB_TOKEN" };
  try {
    const fromGh = execFileSync("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
    if (fromGh) return { token: fromGh, source: "gh CLI" };
  } catch {
    // gh missing or not logged in — fall through to null.
  }
  return null;
}

/** Flags `/pr` accepts, after the command name is stripped. */
export interface PrOptions {
  draft: boolean;
  title?: string;
  body?: string;
  base?: string;
}

/**
 * Pull the `/pr` flags out of the command argument. `--title` and `--body`
 * take every word up to the next flag, so titles can contain spaces without
 * quoting and flags can come in any order; `--base` takes one word (or
 * `--base=<branch>`). A bare `/pr` takes no positional argument, so anything
 * else is ignored.
 */
export function parsePrFlags(arg: string): PrOptions {
  const opts: PrOptions = { draft: false };
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const isFlag = (t: string): boolean =>
    t === "--draft" ||
    t === "--title" ||
    t === "--body" ||
    t === "--base" ||
    t.startsWith("--base=");
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "--draft") {
      opts.draft = true;
      i += 1;
    } else if (t === "--title" || t === "--body") {
      const words: string[] = [];
      i += 1;
      while (i < tokens.length && !isFlag(tokens[i])) {
        words.push(tokens[i]);
        i += 1;
      }
      const value = words.join(" ").trim() || undefined;
      if (t === "--title") opts.title = value;
      else opts.body = value;
    } else if (t === "--base" || t.startsWith("--base=")) {
      const inline = t.startsWith("--base=") ? t.slice("--base=".length).trim() : "";
      const next = tokens[i + 1];
      if (inline) {
        opts.base = inline;
        i += 1;
      } else if (next && !isFlag(next)) {
        opts.base = next;
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return opts;
}

/**
 * The PR title when the user did not pass `--title`. One commit ahead names
 * itself; several get the branch name, since no single commit speaks for the
 * change. An explicit `--title` always wins.
 */
export function prTitleFor(commits: GitCommit[], branch: string, override?: string): string {
  if (override?.trim()) return override.trim();
  if (commits.length === 1) return commits[0].subject || branch;
  return branch;
}

/**
 * The PR body when the user did not pass `--body`. One commit contributes
 * its own body (often empty — fine); several become a list of subjects so
 * the PR still says what it contains. An explicit `--body` always wins.
 */
export function prBodyFor(commits: GitCommit[], override?: string): string | undefined {
  if (override !== undefined) return override;
  if (commits.length <= 1) return commits[0]?.body || undefined;
  return commits.map((c) => `- ${c.subject}`).join("\n");
}

export interface CreatePrRequest {
  owner: string;
  repo: string;
  /** The branch to merge from. */
  head: string;
  /** The branch to merge into. */
  base: string;
  title: string;
  body?: string;
  draft: boolean;
  token: string;
}

export interface CreatedPr {
  number: number;
  url: string;
}

type FetchFn = typeof fetch;

/**
 * Create the pull request via the GitHub REST API. `fetchFn` is injectable
 * so tests can fake the API without network access.
 *
 * A 422 from GitHub usually means a PR for the branch already exists — the
 * caller then looks it up and reports its URL rather than failing.
 */
export async function createPullRequest(
  req: CreatePrRequest,
  fetchFn: FetchFn = fetch
): Promise<CreatedPr> {
  let res: Response;
  try {
    res = await fetchFn(`https://api.github.com/repos/${req.owner}/${req.repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "kritya",
      },
      body: JSON.stringify({
        title: req.title,
        head: req.head,
        base: req.base,
        body: req.body ?? "",
        draft: req.draft,
      }),
    });
  } catch (err) {
    throw new Error(`Could not reach api.github.com: ${(err as Error).message}`);
  }
  if (res.status === 401) {
    throw new Error(
      "GitHub rejected the token (401). Check that GITHUB_TOKEN is valid, or re-run `gh auth login`."
    );
  }
  if (res.status === 403) {
    throw new Error(
      "GitHub refused the request (403) — the token may lack repo scope, or the API rate limit was hit."
    );
  }
  if (res.status === 404) {
    throw new Error(
      `Repository ${req.owner}/${req.repo} not found (404). The token may not have access to it.`
    );
  }
  if (res.status === 422) {
    const err = new Error("ALREADY_EXISTS") as Error & { alreadyExists: boolean };
    err.alreadyExists = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}.`);
  }
  const data = (await res.json()) as { number?: number; html_url?: string };
  if (typeof data.number !== "number" || typeof data.html_url !== "string") {
    throw new Error("GitHub's response did not include the pull request URL.");
  }
  return { number: data.number, url: data.html_url };
}

/**
 * Find an already-open PR from `head` into any base, so `/pr` reports the
 * existing one instead of failing on a duplicate. Returns null when there
 * is none (or the lookup itself fails — absence of evidence either way).
 */
export async function findOpenPullRequest(
  owner: string,
  repo: string,
  head: string,
  token: string,
  fetchFn: FetchFn = fetch
): Promise<CreatedPr | null> {
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "kritya",
        },
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { number?: number; html_url?: string }[];
    const first = Array.isArray(data) ? data[0] : undefined;
    if (first && typeof first.number === "number" && typeof first.html_url === "string") {
      return { number: first.number, url: first.html_url };
    }
    return null;
  } catch {
    return null;
  }
}
