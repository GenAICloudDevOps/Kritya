import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";

/** Cap on how much text a single fetch returns, unless the caller asks for less. */
const DEFAULT_MAX_CHARS = 20_000;
/** Give up on a slow or hanging server rather than blocking the whole turn. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Reject URLs that point at the local machine or a private/internal network.
 * fetch_url can reach any host the process can, so without this guard a prompt
 * injection could aim it at localhost services or a cloud metadata endpoint
 * (169.254.169.254) to read credentials. This is a literal-host/IP check, not
 * DNS-rebinding-proof, but it blocks the obvious SSRF targets.
 */
function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed (got ${url.protocol})`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::"
  ) {
    throw new Error(`Refusing to fetch a local address: ${host}`);
  }
  // IPv4 private / loopback / link-local ranges, incl. cloud metadata (169.254.169.254).
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate =
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      a === 0;
    if (isPrivate) throw new Error(`Refusing to fetch a private/internal address: ${host}`);
  }
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host.includes(":") && /^(fc|fd|fe8|fe9|fea|feb)/.test(host)) {
    throw new Error(`Refusing to fetch a private/internal address: ${host}`);
  }
  return url;
}

/** Collapse an HTML document down to readable plain text (best-effort, no deps). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fetch one URL and return its text content. HTML is reduced to plain text;
 * JSON and plain-text responses are returned as-is. Used by both the fetch_url
 * tool and deep_research. The result is untrusted web content — callers that
 * feed it to the model must fence it (the agent loop does this for tools with
 * `external: true`).
 */
export async function fetchUrlText(raw: string, maxChars = DEFAULT_MAX_CHARS): Promise<string> {
  const url = assertPublicUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Some servers 403 an unknown agent; identify honestly.
        "User-Agent": "kritya-agent/1.0 (+https://github.com/) fetch_url",
        Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timed out after ${FETCH_TIMEOUT_MS / 1000}s fetching ${url.href}`, {
        cause: err,
      });
    }
    throw new Error(`Could not fetch ${url.href}: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url.href}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/|application\/(json|xml|xhtml)|\+xml|\+json/i.test(contentType) && contentType) {
    throw new Error(
      `Refusing to fetch non-text content (${contentType}) from ${url.href}. ` +
        `fetch_url only reads web pages, docs, and APIs — not binaries.`
    );
  }
  const body = await res.text();
  const text = /html/i.test(contentType) ? htmlToText(body) : body.trim();
  const header = `URL: ${url.href}\nContent-Type: ${contentType || "unknown"}\n\n`;
  return truncateResult(header + (text || "(empty response body)"), maxChars);
}

export const fetchUrlTool: ToolDef = {
  name: "fetch_url",
  description:
    "Fetch the full text of a single known web page, documentation URL, raw file, or JSON/API " +
    "endpoint. Use this when you already have a specific URL to read — it complements web_search, " +
    "which only returns short result snippets. HTML is reduced to readable text. Local and " +
    "private-network addresses are refused.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http(s) URL to fetch" },
      max_chars: {
        type: "number",
        description: `Max characters to return (default ${DEFAULT_MAX_CHARS})`,
      },
    },
    required: ["url"],
  },
  // Prompts before reaching out: the URL is visible so an injected exfiltration
  // target (data smuggled into a query string) can be caught before it's sent.
  requiresPermission: true,
  external: true,
  summarize: (args) => `Fetch URL: ${args.url}`,
  async execute(args) {
    const maxChars =
      args.max_chars === undefined || args.max_chars === null
        ? DEFAULT_MAX_CHARS
        : Math.min(Math.max(Number(args.max_chars), 500), 50_000);
    return fetchUrlText(String(args.url), maxChars);
  },
};
