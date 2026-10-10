import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPullRequest,
  findOpenPullRequest,
  parseGitHubRemote,
  parsePrFlags,
  prBodyFor,
  prTitleFor,
  resolveGitHubToken,
  type CreatePrRequest,
} from "../git/pr.js";

/** A fake fetch returning a canned response, capturing the request. */
function fakeFetch(
  status: number,
  json: unknown,
  opts: { ok?: boolean; throwOnCall?: Error } = {}
) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (opts.throwOnCall) throw opts.throwOnCall;
    return {
      ok: opts.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => json,
    };
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const PR_REQ: CreatePrRequest = {
  owner: "octo",
  repo: "hello",
  head: "feat/x",
  base: "main",
  title: "Add x",
  draft: false,
  token: "sekret",
};

test("parseGitHubRemote handles the usual origin URL shapes", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/octo/hello"), {
    owner: "octo",
    repo: "hello",
  });
  assert.deepEqual(parseGitHubRemote("https://github.com/octo/hello.git"), {
    owner: "octo",
    repo: "hello",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:octo/hello.git"), {
    owner: "octo",
    repo: "hello",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:octo/hello"), {
    owner: "octo",
    repo: "hello",
  });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/octo/hello.git"), {
    owner: "octo",
    repo: "hello",
  });
});

test("parseGitHubRemote rejects non-GitHub and malformed remotes", () => {
  assert.equal(parseGitHubRemote("https://gitlab.com/octo/hello.git"), null);
  assert.equal(parseGitHubRemote("not a url"), null);
  assert.equal(parseGitHubRemote("https://github.com/just-an-owner"), null);
});

test("parsePrFlags reads each flag, in any order", () => {
  assert.deepEqual(parsePrFlags(""), { draft: false });
  assert.deepEqual(parsePrFlags("--draft"), { draft: true });
  assert.deepEqual(parsePrFlags("--title hello world"), {
    draft: false,
    title: "hello world",
  });
  assert.deepEqual(parsePrFlags("--title hello --draft"), {
    draft: true,
    title: "hello",
  });
  assert.deepEqual(parsePrFlags("--draft --title hello"), {
    draft: true,
    title: "hello",
  });
  assert.deepEqual(parsePrFlags("--body some body text"), {
    draft: false,
    body: "some body text",
  });
  // Flags do not swallow each other regardless of order.
  assert.deepEqual(parsePrFlags("--title t --body b"), {
    draft: false,
    title: "t",
    body: "b",
  });
  assert.deepEqual(parsePrFlags("--body b --title t"), {
    draft: false,
    title: "t",
    body: "b",
  });
});

test("parsePrFlags reads --base as one word, with or without =", () => {
  assert.equal(parsePrFlags("--base develop").base, "develop");
  assert.equal(parsePrFlags("--base=develop").base, "develop");
  assert.equal(parsePrFlags("--base").base, undefined);
  assert.equal(parsePrFlags("--base --draft").base, undefined);
});

test("prTitleFor prefers --title, then a lone commit subject, then the branch", () => {
  const one = [{ subject: "Fix the thing", body: "" }];
  const two = [
    { subject: "One", body: "" },
    { subject: "Two", body: "" },
  ];
  assert.equal(prTitleFor(one, "feat/x", "Custom"), "Custom");
  assert.equal(prTitleFor(one, "feat/x"), "Fix the thing");
  assert.equal(prTitleFor(two, "feat/x"), "feat/x");
  assert.equal(prTitleFor([], "feat/x"), "feat/x");
  assert.equal(prTitleFor([{ subject: "", body: "" }], "feat/x"), "feat/x");
});

test("prBodyFor prefers --body, then a lone commit body, then a commit list", () => {
  const one = [{ subject: "Fix the thing", body: "Details here" }];
  const two = [
    { subject: "One", body: "" },
    { subject: "Two", body: "" },
  ];
  assert.equal(prBodyFor(one, "Custom body"), "Custom body");
  assert.equal(prBodyFor(one), "Details here");
  assert.equal(prBodyFor([{ subject: "Fix", body: "" }]), undefined);
  assert.equal(prBodyFor(two), "- One\n- Two");
});

test("resolveGitHubToken prefers GITHUB_TOKEN", () => {
  const found = resolveGitHubToken({ GITHUB_TOKEN: "  abc123  " } as NodeJS.ProcessEnv);
  assert.deepEqual(found, { token: "abc123", source: "GITHUB_TOKEN" });
});

test("createPullRequest posts the right shape and returns the PR", async () => {
  const { fn, seen } = fakeFetch(201, {
    number: 12,
    html_url: "https://github.com/octo/hello/pull/12",
  });
  const pr = await createPullRequest({ ...PR_REQ, body: "Some body", draft: true }, fn);
  assert.deepEqual(pr, { number: 12, url: "https://github.com/octo/hello/pull/12" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.github.com/repos/octo/hello/pulls");
  const init = seen[0].init!;
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sekret");
  const body = JSON.parse(init.body as string);
  assert.deepEqual(body, {
    title: "Add x",
    head: "feat/x",
    base: "main",
    body: "Some body",
    draft: true,
  });
});

test("createPullRequest explains auth and repo problems", async () => {
  const { fn: f401 } = fakeFetch(401, {}, { ok: false });
  await assert.rejects(() => createPullRequest(PR_REQ, f401), /401/);
  const { fn: f404 } = fakeFetch(404, {}, { ok: false });
  await assert.rejects(() => createPullRequest(PR_REQ, f404), /not found/);
  const { fn: fNet } = fakeFetch(0, {}, { throwOnCall: new Error("boom") });
  await assert.rejects(() => createPullRequest(PR_REQ, fNet), /Could not reach/);
});

test("createPullRequest flags the already-exists case for the caller", async () => {
  const { fn } = fakeFetch(422, {}, { ok: false });
  let caught: unknown;
  await assert.rejects(async () => {
    try {
      await createPullRequest(PR_REQ, fn);
    } catch (err) {
      caught = err;
      throw err;
    }
  });
  assert.equal((caught as { alreadyExists?: boolean }).alreadyExists, true);
});

test("findOpenPullRequest returns the first open PR, or null", async () => {
  const { fn, seen } = fakeFetch(200, [
    { number: 7, html_url: "https://github.com/octo/hello/pull/7" },
  ]);
  const pr = await findOpenPullRequest("octo", "hello", "feat/x", "sekret", fn);
  assert.deepEqual(pr, { number: 7, url: "https://github.com/octo/hello/pull/7" });
  assert.match(seen[0].url, /pulls\?head=octo:feat\/x&state=open/);

  const { fn: empty } = fakeFetch(200, []);
  assert.equal(await findOpenPullRequest("octo", "hello", "feat/x", "sekret", empty), null);

  const { fn: bad } = fakeFetch(500, {}, { ok: false });
  assert.equal(await findOpenPullRequest("octo", "hello", "feat/x", "sekret", bad), null);

  const { fn: net } = fakeFetch(0, {}, { throwOnCall: new Error("boom") });
  assert.equal(await findOpenPullRequest("octo", "hello", "feat/x", "sekret", net), null);
});
