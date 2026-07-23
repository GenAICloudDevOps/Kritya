import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";

const SEARCH_TIMEOUT_MS = 30_000;

export interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  /** Only returned by Tavily for the "news" topic; the source's publish date. */
  published_date?: string;
}

export interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

export interface TavilySearchOptions {
  /**
   * "news" enables recency filtering and makes Tavily return published dates;
   * "general" is the default broad web search. Defaults to "general".
   */
  topic?: "general" | "news";
  /**
   * Restrict results to the last N days. Only meaningful for the "news" topic,
   * so passing this forces topic to "news".
   */
  days?: number;
}

/**
 * Raw Tavily search call, returning the parsed structured response. Shared by
 * the web_search tool (which formats it for display) and deep_research (which
 * needs the result URLs to fetch full pages). Throws on any error so callers
 * can decide how to surface it.
 */
export async function tavilyRaw(
  query: string,
  maxResults = 5,
  opts: TavilySearchOptions = {}
): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set. Add it to your .env file to enable web search.");
  }
  const body: Record<string, unknown> = {
    query,
    max_results: Math.min(Math.max(maxResults, 1), 10),
    include_answer: true,
  };
  if (opts.topic) body.topic = opts.topic;
  // `days` is a news-topic filter; setting it implies topic "news" so the
  // recency window is actually applied (and publish dates come back).
  if (opts.days !== undefined && Number.isFinite(opts.days)) {
    body.topic = "news";
    body.days = Math.max(1, Math.floor(opts.days));
  }
  // Bounded explicitly: a fetch with no signal waits on the socket forever, and
  // this is also called outside the agent loop (the /web-search command), where
  // the loop's per-tool deadline isn't there to catch it.
  const res = await fetch("https://api.tavily.com/search", {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Tavily search failed (HTTP ${res.status}) ${errBody.slice(0, 300)}`);
  }
  return (await res.json()) as TavilyResponse;
}

export async function tavilySearch(
  query: string,
  maxResults = 5,
  opts: TavilySearchOptions = {}
): Promise<string> {
  let data: TavilyResponse;
  try {
    data = await tavilyRaw(query, maxResults, opts);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const parts: string[] = [];
  if (data.answer) parts.push(`Answer: ${data.answer}`);
  for (const [i, r] of (data.results ?? []).entries()) {
    const date = r.published_date ? ` (published ${r.published_date})` : "";
    parts.push(
      `${i + 1}. ${r.title ?? "(untitled)"}${date}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 400)}`
    );
  }
  return truncateResult(parts.join("\n\n") || "(no results)");
}

/** Distinguishes "omitted" (use default) from an explicit value like 0. */
export function parseMaxResults(raw: unknown, defaultValue = 5): number {
  return raw === undefined || raw === null ? defaultValue : Number(raw);
}

export const webSearchTool: ToolDef = {
  name: "web_search",
  description:
    "Search the web (via Tavily) for current information: documentation, error messages, " +
    "library versions, news. Returns an answer summary plus result snippets with URLs. " +
    "For time-sensitive queries ('latest', 'this week', recent news), set recency_days to the " +
    "window so results are restricted to that period and labeled with publish dates.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      max_results: { type: "number", description: "Number of results, 1-10 (default 5)" },
      recency_days: {
        type: "number",
        description:
          "Restrict results to the last N days and return publish dates (news sources). " +
          "Set this for recent/time-sensitive queries; omit for timeless ones.",
      },
    },
    required: ["query"],
  },
  // Requires a prompt (rather than running silently) so the query text is
  // visible before it's sent out — under prompt injection, a search query is
  // an easy channel to smuggle file contents to an external service.
  requiresPermission: true,
  external: true,
  summarize: (args) => `Web search: ${args.query}`,
  async execute(args) {
    const days =
      args.recency_days === undefined || args.recency_days === null
        ? undefined
        : Number(args.recency_days);
    return tavilySearch(String(args.query), parseMaxResults(args.max_results), { days });
  },
};
