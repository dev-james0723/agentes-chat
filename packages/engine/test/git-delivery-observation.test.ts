import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GithubObservationHttp,
  observeGithubPull,
  observeGithubRepository,
} from "../src/git/delivery-observation";

const head = "a".repeat(40);
const base = "b".repeat(40);
const repository = { id: 12345, full_name: "Acme/App", default_branch: "main", archived: false, disabled: false };
const target = { owner: "acme", repo: "app" };
const headers = { authorization: "Bearer fixture-only-secret" };
const success =
  (body: unknown): GithubObservationHttp =>
  async () =>
    Response.json(body);
const refusal = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test("repository observation uses a fixed provider GET and returns only bounded identity", async () => {
  const calls: { url: string; method?: string; redirect?: RequestInit["redirect"] }[] = [];
  const http = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, redirect: init?.redirect });
    assert.equal(new Headers(init?.headers).get("authorization"), headers.authorization);
    return Response.json({ ...repository, private: true, description: "private irrelevant source text" });
  };
  const seen = await observeGithubRepository({ http, headers }, target);
  assert.deepEqual(seen, { id: "12345", host: "github.com", owner: "Acme", repo: "App", defaultBranch: "main" });
  assert.deepEqual(calls, [{ url: "https://api.github.com/repos/acme/app", method: "GET", redirect: "error" }]);
  assert(!JSON.stringify(seen).includes("private irrelevant"));
  assert(!JSON.stringify(seen).includes("fixture-only-secret"));
});

test("caller path or host injection is refused before outbound HTTP", async () => {
  let calls = 0;
  const http = async () => {
    calls++;
    return Response.json(repository);
  };
  for (const name of ["../private", "a/b", "https://evil.invalid", "a%2fb", "a\nsecret"])
    await assert.rejects(
      observeGithubRepository({ http, headers }, { owner: name, repo: "app" }),
      refusal("delivery_repository_invalid"),
    );
  assert.equal(calls, 0);
});

test("redirect and denied reads stay explicit unknown refusals", async () => {
  await assert.rejects(
    observeGithubRepository({ http: success(repository), headers }, { owner: "other", repo: "app" }),
    refusal("delivery_repository_identity_mismatch"),
  );
  for (const status of [301, 302, 307, 308])
    await assert.rejects(
      observeGithubRepository(
        { http: async () => new Response(null, { status, headers: { location: "https://evil.invalid" } }), headers },
        target,
      ),
      refusal("delivery_provider_redirect"),
    );
  for (const status of [401, 403, 404, 429, 500])
    await assert.rejects(
      observeGithubRepository({ http: async () => new Response("private denial", { status }), headers }, target),
      refusal("delivery_provider_unavailable"),
    );
});

test("unsafe or incomplete provider identity cannot become a configured repository", async () => {
  for (const bad of [
    { ...repository, id: 0 },
    { ...repository, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...repository, archived: true },
    { ...repository, disabled: true },
    { ...repository, default_branch: "" },
    { ...repository, full_name: "acme/other" },
  ])
    await assert.rejects(observeGithubRepository({ http: success(bad), headers }, target));
  for (const code of [0, 9, 10, 13, 31, 32, 127]) {
    const bad = { ...repository, default_branch: `main${String.fromCharCode(code)}suffix` };
    await assert.rejects(
      observeGithubRepository({ http: success(bad), headers }, target),
      refusal("delivery_provider_invalid_response"),
    );
  }
});

test("oversized or malformed responses do not expose raw provider content", async () => {
  const responses = [new Response("x".repeat(140_000)), new Response("not json fixture-only-secret")];
  for (const response of responses) {
    await assert.rejects(observeGithubRepository({ http: async () => response, headers }, target), (error: unknown) => {
      assert(!String(error).includes("fixture-only-secret"));
      return true;
    });
  }
});

test("a hung provider read is bounded even when its fake transport ignores abort", async () => {
  const http: GithubObservationHttp = () => new Promise<Response>(() => {});
  await assert.rejects(
    observeGithubRepository({ http, headers, timeoutMs: 10 }, target),
    refusal("delivery_provider_timeout"),
  );
  const controller = new AbortController();
  const waiting = observeGithubRepository({ http, headers, signal: controller.signal }, target);
  controller.abort();
  await assert.rejects(waiting, refusal("delivery_observation_aborted"));
});

test("denied or timed out observations cancel their response stream", async () => {
  for (const status of [403, 200]) {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const http = async () => new Response(stream, { status });
    await assert.rejects(
      observeGithubRepository({ http, headers, timeoutMs: 10 }, target),
      refusal(status === 403 ? "delivery_provider_unavailable" : "delivery_provider_timeout"),
    );
    assert.equal(canceled, true);
  }
});

test("a transport returning after the deadline cannot start consuming its late body", async () => {
  let canceled = false;
  let returned = false;
  let pulled = 0;
  const http = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new TextEncoder().encode("private ignored body"));
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    returned = true;
    return new Response(stream);
  };
  await assert.rejects(
    observeGithubRepository({ http, headers, timeoutMs: 5 }, target),
    refusal("delivery_provider_timeout"),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(returned, true);
  assert.equal(canceled, true);
  assert.equal(pulled, 0);
});

test("pull observation binds immutable repository, current head and base", async () => {
  const seen = await observeGithubRepository({ http: success(repository), headers }, target);
  const pull = {
    number: 21,
    state: "open",
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: { sha: head },
    base: { sha: base, ref: "main", repo: { id: 12345 } },
  };
  assert.deepEqual(await observeGithubPull({ http: success(pull), headers }, seen, 21), {
    repositoryId: "12345",
    number: 21,
    headSha: head,
    baseSha: base,
    baseRef: "main",
    state: "open",
    draft: false,
    merged: false,
    integrationSha: null,
  });
  await assert.rejects(
    observeGithubPull({ http: success({ ...pull, base: { ...pull.base, repo: { id: 54321 } } }), headers }, seen, 21),
    refusal("delivery_repository_identity_mismatch"),
  );
  await assert.rejects(
    observeGithubPull({ http: success({ ...pull, number: 22 }), headers }, seen, 21),
    refusal("delivery_provider_invalid_response"),
  );
});

test("a provider merged result is descriptive and carries no authorization claim", async () => {
  const seen = await observeGithubRepository({ http: success(repository), headers }, target);
  const pull = {
    number: 21,
    state: "closed",
    draft: false,
    merged: true,
    merge_commit_sha: "c".repeat(40),
    head: { sha: head },
    base: { sha: base, ref: "main", repo: { id: 12345 } },
  };
  const result = await observeGithubPull({ http: success(pull), headers }, seen, 21);
  assert.equal(result.merged, true);
  assert.equal(result.integrationSha, "c".repeat(40));
  assert(!("authorityGranted" in result));
});
