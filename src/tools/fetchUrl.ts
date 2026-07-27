import { lookup as dnsLookup } from "node:dns/promises";
import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";
import { isPrivateOrLoopbackHost } from "../net/urlSafety.js";

/** Cap on how much text a single fetch returns, unless the caller asks for less. */
const DEFAULT_MAX_CHARS = 20_000;
/** Give up on a slow or hanging server rather than blocking the whole turn. */
const FETCH_TIMEOUT_MS = 20_000;
/**
 * Hard cap on raw response bytes read off the wire, independent of max_chars.
 * Enforced while streaming (not after buffering the full body) so a server
 * that lies about content-length or sends gigabytes of text can't blow up
 * process memory before truncation ever gets a chance to run.
 */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

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
  if (isPrivateOrLoopbackHost(host)) {
    throw new Error(`Refusing to fetch a private/internal address: ${host}`);
  }
  return url;
}

/**
 * Resolve `hostname` and check whether any answer is private/loopback.
 * assertPublicUrl only checks the literal hostname string, so a
 * public-looking name that resolves (now, or on a later request) to an
 * internal IP — DNS rebinding, or simply attacker-controlled DNS — slips
 * past it. This closes that gap for the initial request; lookupFn is
 * injectable for tests, and defaults to a real DNS resolution.
 */
export async function hostResolvesToPrivateAddress(
  hostname: string,
  lookupFn: typeof dnsLookup = dnsLookup
): Promise<boolean> {
  try {
    const addresses = await lookupFn(hostname, { all: true });
    return addresses.some((a) => isPrivateOrLoopbackHost(a.address));
  } catch {
    // Unresolvable host — let the actual fetch fail naturally with its own error.
    return false;
  }
}

/** Refuse to keep chasing redirects forever. */
const MAX_REDIRECTS = 5;

/**
 * Fetch `url`, following redirects manually so every hop — not just the
 * original URL — is checked against assertPublicUrl. A public URL that
 * 302s to 169.254.169.254 or localhost would otherwise sail straight past
 * the initial check, since `redirect: "follow"` never re-validates.
 */
async function assertNotDnsRebound(url: URL): Promise<void> {
  if (await hostResolvesToPrivateAddress(url.hostname)) {
    throw new Error(`Refusing to fetch ${url.hostname}: resolves to a private/internal address`);
  }
}

async function fetchFollowingRedirects(
  url: URL,
  signal: AbortSignal,
  headers: Record<string, string>
): Promise<{ res: Response; finalUrl: URL }> {
  let current = url;
  await assertNotDnsRebound(current);
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { redirect: "manual", signal, headers });
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (!isRedirect || !location) {
      return { res, finalUrl: current };
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects fetching ${url.href} (stopped at ${current.href})`);
    }
    current = assertPublicUrl(new URL(location, current).href);
    await assertNotDnsRebound(current);
  }
}

/**
 * Read a response body up to `maxBytes`, stopping the underlying stream as
 * soon as the cap is hit instead of buffering the whole thing first. A
 * server that ignores Content-Length (or lies about it) can otherwise be
 * used to exhaust process memory before `truncateResult` ever runs.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      const keep = value.length - (total - maxBytes);
      if (keep > 0) chunks.push(value.subarray(0, keep));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
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
  let finalUrl: URL;
  try {
    ({ res, finalUrl } = await fetchFollowingRedirects(url, controller.signal, {
      // Some servers 403 an unknown agent; identify honestly.
      "User-Agent": "kritya-agent/1.0 (+https://github.com/) fetch_url",
      Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
    }));
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
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${finalUrl.href}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/|application\/(json|xml|xhtml)|\+xml|\+json/i.test(contentType) && contentType) {
    throw new Error(
      `Refusing to fetch non-text content (${contentType}) from ${finalUrl.href}. ` +
        `fetch_url only reads web pages, docs, and APIs — not binaries.`
    );
  }
  const body = await readBodyCapped(res, MAX_RESPONSE_BYTES);
  const text = /html/i.test(contentType) ? htmlToText(body) : body.trim();
  const header = `URL: ${finalUrl.href}\nContent-Type: ${contentType || "unknown"}\n\n`;
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
