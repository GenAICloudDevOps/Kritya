import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";
import { tavilyRaw } from "./webSearch.js";
import { fetchUrlText } from "./fetchUrl.js";

const MAX_QUERIES = 5;
const DEFAULT_PAGES_PER_QUERY = 2;
const MAX_PAGES_PER_QUERY = 4;
/** Keep each fetched page compact so a multi-source bundle still fits in context. */
const PER_PAGE_CHARS = 6_000;

/**
 * Deep research: the caller (the model) breaks a big question into a handful of
 * focused sub-queries; this tool runs a web search for each, then fetches the
 * full text of the top result pages and returns one consolidated bundle. It is
 * web_search + fetch_url in a loop — use it only for questions that genuinely
 * need multiple sources, since it makes many external calls.
 */
async function runDeepResearch(queries: string[], pagesPerQuery: number): Promise<string> {
  const seenUrls = new Set<string>();
  const sections: string[] = [];

  for (const query of queries) {
    const block: string[] = [`## Sub-query: ${query}`];
    let search;
    try {
      search = await tavilyRaw(query, 5);
    } catch (err) {
      block.push(`(search failed: ${err instanceof Error ? err.message : String(err)})`);
      sections.push(block.join("\n"));
      continue;
    }
    if (search.answer) block.push(`Search summary: ${search.answer}`);

    const results = (search.results ?? []).filter((r) => r.url && !seenUrls.has(r.url));
    if (results.length === 0) block.push("(no new sources found)");

    let fetched = 0;
    for (const r of results) {
      if (fetched >= pagesPerQuery) break;
      seenUrls.add(r.url!);
      block.push(`\n### Source: ${r.title ?? "(untitled)"}\n${r.url}`);
      try {
        const page = await fetchUrlText(r.url!, PER_PAGE_CHARS);
        block.push(page);
      } catch (err) {
        // A single unreachable page shouldn't sink the whole research run;
        // fall back to the search snippet so the source still contributes.
        block.push(
          `(could not fetch full page: ${err instanceof Error ? err.message : String(err)})`
        );
        if (r.content) block.push(`Snippet: ${r.content}`);
      }
      fetched++;
    }
    sections.push(block.join("\n"));
  }

  const preamble =
    `Deep research bundle: ${queries.length} sub-quer${queries.length === 1 ? "y" : "ies"}, ` +
    `${seenUrls.size} source page(s). Synthesize an answer from these and cite the URLs used.\n`;
  return truncateResult(preamble + "\n" + sections.join("\n\n---\n\n"));
}

export const deepResearchTool: ToolDef = {
  name: "deep_research",
  description:
    "Research a topic in depth across multiple web sources. You supply 1-5 focused sub-queries " +
    "that break the question apart; the tool runs a web search for each and reads the full text " +
    "of the top result pages, returning one consolidated, cited bundle to synthesize from. " +
    "Reserve this for broad, multi-source questions (comparisons, surveys, 'how do people do X') " +
    "— for a single known URL use fetch_url, and for a quick fact use web_search.",
  parameters: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        description: `1-${MAX_QUERIES} focused sub-queries covering different angles of the question`,
      },
      pages_per_query: {
        type: "number",
        description: `Full pages to read per sub-query, 1-${MAX_PAGES_PER_QUERY} (default ${DEFAULT_PAGES_PER_QUERY})`,
      },
    },
    required: ["queries"],
  },
  requiresPermission: true,
  external: true,
  summarize: (args) => {
    const qs = Array.isArray(args.queries) ? args.queries : [];
    return `Deep research (${qs.length} quer${qs.length === 1 ? "y" : "ies"}): ${qs.join("; ").slice(0, 80)}`;
  },
  async execute(args) {
    const raw = Array.isArray(args.queries) ? args.queries : [];
    const queries = raw.map((q) => String(q).trim()).filter(Boolean).slice(0, MAX_QUERIES);
    if (queries.length === 0) {
      throw new Error("deep_research needs at least one non-empty query");
    }
    const pagesPerQuery =
      args.pages_per_query === undefined || args.pages_per_query === null
        ? DEFAULT_PAGES_PER_QUERY
        : Math.min(Math.max(Number(args.pages_per_query), 1), MAX_PAGES_PER_QUERY);
    return runDeepResearch(queries, pagesPerQuery);
  },
};
