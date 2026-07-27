import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivateOrLoopbackHost, isLoopbackHost } from "../net/urlSafety.js";
import { hostResolvesToPrivateAddress } from "../tools/fetchUrl.js";

test("isPrivateOrLoopbackHost flags private/loopback/metadata hosts", () => {
  for (const h of [
    "localhost",
    "sub.localhost",
    "0.0.0.0",
    "::1",
    "::",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254",
    "fc00::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateOrLoopbackHost(h), true, `expected ${h} to be flagged private`);
  }
});

test("isPrivateOrLoopbackHost allows public hosts", () => {
  for (const h of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "example.com"]) {
    assert.equal(isPrivateOrLoopbackHost(h), false, `expected ${h} to be allowed`);
  }
});

test("isLoopbackHost only matches loopback, not other private ranges", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("10.0.0.1"), false);
  assert.equal(isLoopbackHost("169.254.169.254"), false);
});

test("hostResolvesToPrivateAddress catches a public-looking hostname whose DNS answer is private (rebinding)", async () => {
  const fakeLookup = (async () => [{ address: "169.254.169.254", family: 4 }]) as never;
  assert.equal(await hostResolvesToPrivateAddress("attacker-controlled.example", fakeLookup), true);
});

test("hostResolvesToPrivateAddress allows a hostname that resolves publicly", async () => {
  const fakeLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;
  assert.equal(await hostResolvesToPrivateAddress("example.com", fakeLookup), false);
});

test("hostResolvesToPrivateAddress treats an unresolvable host as not-private (fetch itself will fail)", async () => {
  const fakeLookup = (async () => {
    throw new Error("ENOTFOUND");
  }) as never;
  assert.equal(await hostResolvesToPrivateAddress("nonexistent.invalid", fakeLookup), false);
});
