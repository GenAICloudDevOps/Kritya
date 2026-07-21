import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchUrlText } from "../tools/fetchUrl.js";

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
