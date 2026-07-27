import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { fetchUrlText, MAX_RESPONSE_BYTES } from "../tools/fetchUrl.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
}

test("fetch_url rejects non-http(s) schemes", async () => {
  await assert.rejects(() => fetchUrlText("file:///etc/passwd"), /Only http and https/);
});

test("fetch_url refuses localhost", async () => {
  await assert.rejects(() => fetchUrlText("http://localhost:8080/admin"), /local address/);
});

test("fetch_url refuses private and metadata IPs", async () => {
  await assert.rejects(() => fetchUrlText("http://127.0.0.1/"), /private|local/i);
  await assert.rejects(() => fetchUrlText("http://10.0.0.5/"), /private/i);
  await assert.rejects(() => fetchUrlText("http://192.168.1.1/"), /private/i);
  await assert.rejects(() => fetchUrlText("http://169.254.169.254/latest/meta-data/"), /private/i);
});

test("fetch_url rejects a malformed URL", async () => {
  await assert.rejects(() => fetchUrlText("not a url"), /valid URL/);
});

test("fetch_url refuses a redirect that points at a private address", async () => {
  globalThis.fetch = (async () =>
    textResponse(302, "", {
      location: "http://169.254.169.254/latest/meta-data/",
    })) as typeof fetch;
  await assert.rejects(() => fetchUrlText("https://example.com/redirector"), /private/i);
});

test("fetch_url follows a redirect chain between two validated public hosts", async () => {
  let calls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls++;
    if (String(url) === "https://example.com/start") {
      return textResponse(302, "", { location: "https://example.org/final" });
    }
    return textResponse(200, "hello world");
  }) as typeof fetch;
  const result = await fetchUrlText("https://example.com/start");
  assert.equal(calls, 2);
  assert.match(result, /hello world/);
});

test("fetch_url gives up after too many redirects", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return textResponse(302, "", { location: `https://example.com/hop${n}` });
  }) as typeof fetch;
  await assert.rejects(() => fetchUrlText("https://example.com/hop0"), /redirect/i);
});

test("fetch_url stops reading the body once it exceeds the byte cap, without buffering the whole stream", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(97); // 1 MiB of 'a'
  const totalChunksAvailable = Math.ceil((MAX_RESPONSE_BYTES * 4) / chunk.length);
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalChunksAvailable) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(chunk);
    },
  });
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;

  await fetchUrlText("https://example.com/huge", 50_000);

  // A cap that actually streams stops pulling well before the "server" would
  // have run out of chunks; a buffer-then-truncate implementation reads them all.
  assert.ok(
    pulled < totalChunksAvailable,
    `expected streaming to stop early, but read all ${totalChunksAvailable} chunks`
  );
});
