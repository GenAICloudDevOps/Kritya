import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";

export interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

export interface TavilyResponse {
  answer?: string;
  results?: TavilyResult[];
}

/**
 * Raw Tavily search call, returning the parsed structured response. Shared by
 * the web_search tool (which formats it for display) and deep_research (which
 * needs the result URLs to fetch full pages). Throws on any error so callers
 * can decide how to surface it.
 */
export async function tavilyRaw(query: string, maxResults = 5): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set. Add it to your .env file to enable web search.");
  }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(Math.max(maxResults, 1), 10),
      include_answer: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tavily search failed (HTTP ${res.status}) ${body.slice(0, 300)}`);
  }
  return (await res.json()) as TavilyResponse;
}

export async function tavilySearch(query: string, maxResults = 5): Promise<string> {
  let data: TavilyResponse;
  try {
    data = await tavilyRaw(query, maxResults);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const parts: string[] = [];
  if (data.answer) parts.push(`Answer: ${data.answer}`);
  for (const [i, r] of (data.results ?? []).entries()) {
    parts.push(
      `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 400)}`
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
    "library versions, news. Returns an answer summary plus result snippets with URLs.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      max_results: { type: "number", description: "Number of results, 1-10 (default 5)" },
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
    return tavilySearch(String(args.query), parseMaxResults(args.max_results));
  },
};
