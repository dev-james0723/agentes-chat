import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createApiKeyConnection } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => t?.close());

async function fixture() {
  const reads: string[] = [];
  const provider = { status: 200 };
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if ((init?.method ?? "GET") !== "GET") throw new Error("Fixture permits provider reads only");
    reads.push(url.href);
    if (provider.status !== 200)
      return new Response("fixture-github-credential private provider message", { status: provider.status });
    if (url.href === "https://api.github.com/repos/acme/app")
      return Response.json({
        id: 12345,
        full_name: "acme/app",
        default_branch: "main",
        archived: false,
        disabled: false,
      });
    throw new Error(`Unexpected provider URL: ${url.href}`);
  }) as typeof fetch;
  t = await createTestServer({ http, reply: () => ({ chunks: ["Fixture only."] }) });
  const owner = browser(t);
  await signUp(owner, "binding-owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const [user] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "binding-owner@example.com"));
  if (!user) throw new Error("Fixture owner missing");
  const connection = await createApiKeyConnection(t.engine.connectorDeps, user.id, orgId, {
    connector: "github",
    apiKey: "fixture-github-credential",
  });
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const projectResponse = await api("/issue-projects", { json: { name: "Existing project" } });
  expect(projectResponse.status).toBe(201);
  const project = (await projectResponse.json()) as { id: string };
  const issueResponse = await api("/issues", {
    json: { title: "Existing delivery task", projectId: project.id, criteria: ["Keep existing work"] },
  });
  expect(issueResponse.status).toBe(201);
  const issue = (await issueResponse.json()) as { id: string; number: number; criteria: unknown[] };
  const binding = {
    action: "set",
    expectedRevision: null,
    repository: { connectionId: connection.id, owner: "acme", repo: "app" },
    releaseOwnerId: null,
    targets: [{ id: "selected-mac-installation", kind: "macos_app", environment: "local_installed" }],
  };
  return { owner, ownerId: user.id, orgId, agentId, project, issue, binding, reads, provider, api };
}

test("native owner task PATCH records provider-derived binding without granting release authority", async () => {
  const f = await fixture();
  const response = await f.api(`/issues/${f.issue.id}`, { method: "PATCH", json: { deliveryBinding: f.binding } });
  expect(response.status).toBe(200);
  const saved = (await response.json()) as { deliveryBinding?: { revision: string }; criteria: unknown[] };
  expect(saved).toMatchObject({
    id: f.issue.id,
    criteria: f.issue.criteria,
    deliveryBinding: {
      state: "configured",
      authorityGranted: false,
      taskId: f.issue.id,
      projectId: f.project.id,
      repository: { id: "12345", host: "github.com", owner: "acme", repo: "app", defaultBranch: "main" },
      releaseOwnerId: null,
      targets: [
        {
          id: "selected-mac-installation",
          kind: "macos_app",
          environment: "local_installed",
          verificationState: "unknown",
        },
      ],
    },
  });
  expect(f.reads).toEqual(["https://api.github.com/repos/acme/app"]);
  const rows = await t.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, f.issue.id));
  const bindingRows = rows.filter((row) => row.event === "delivery_binding_changed");
  expect(bindingRows).toHaveLength(1);
  expect(bindingRows[0]).toMatchObject({
    id: saved.deliveryBinding?.revision,
    kind: "event",
    authorType: "person",
    authorId: f.ownerId,
  });
  expect(await (await f.api(`/issues/${f.issue.id}`)).json()).toMatchObject({
    deliveryBinding: { revision: saved.deliveryBinding?.revision, authorityGranted: false },
  });
  expect(await (await f.api(`/issues/by-number/${f.issue.number}`)).json()).toMatchObject({
    deliveryBinding: { revision: saved.deliveryBinding?.revision, authorityGranted: false },
  });
});

test("binding PATCH rejects caller-supplied identity or issuer assertions", async () => {
  const f = await fixture();
  for (const extra of [{ issuerUserId: f.ownerId }, { policyVersion: "caller-policy" }, { authorityGranted: true }]) {
    const response = await f.api(`/issues/${f.issue.id}`, {
      method: "PATCH",
      json: { deliveryBinding: { ...f.binding, ...extra } },
    });
    expect(response.status).toBe(400);
  }
  const response = await f.api(`/issues/${f.issue.id}`, {
    method: "PATCH",
    json: {
      deliveryBinding: {
        ...f.binding,
        repository: { ...f.binding.repository, id: "forged-provider-id" },
      },
    },
  });
  expect(response.status).toBe(400);
  expect(f.reads).toEqual([]);
});

test("ordinary member and cross-origin requests cannot configure bindings", async () => {
  const f = await fixture();
  const member = await joinByInvitation(t, f.owner, f.orgId, "binding-member@example.com");
  const denied = await member(`/api/app/organizations/${f.orgId}/issues/${f.issue.id}`, {
    method: "PATCH",
    json: { deliveryBinding: f.binding },
  });
  expect(denied.status).toBe(403);
  const csrf = await f.api(`/issues/${f.issue.id}`, {
    method: "PATCH",
    origin: "https://untrusted.invalid",
    json: { deliveryBinding: f.binding },
  });
  expect(csrf.status).toBe(403);
  expect(f.reads).toEqual([]);
});

test("binding CAS keeps history and refuses replay after revocation", async () => {
  const f = await fixture();
  const first = await f.api(`/issues/${f.issue.id}`, { method: "PATCH", json: { deliveryBinding: f.binding } });
  expect(first.status).toBe(200);
  const saved = (await first.json()) as { deliveryBinding: { revision: string } };
  const revoked = await f.api(`/issues/${f.issue.id}`, {
    method: "PATCH",
    json: {
      deliveryBinding: {
        action: "revoke",
        expectedRevision: saved.deliveryBinding.revision,
        reason: "Owner revoked this configuration",
      },
    },
  });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({ deliveryBinding: { state: "revoked", authorityGranted: false } });
  const replay = await f.api(`/issues/${f.issue.id}`, {
    method: "PATCH",
    json: {
      deliveryBinding: {
        ...f.binding,
        expectedRevision: saved.deliveryBinding.revision,
      },
    },
  });
  expect(replay.status).toBe(409);
  const rows = await t.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, f.issue.id));
  expect(rows.filter((row) => row.event === "delivery_binding_changed")).toHaveLength(2);
});

test("normal issue PATCH and comments keep existing behavior and grant no binding", async () => {
  const f = await fixture();
  const ordinary = await f.api(`/issues/${f.issue.id}`, {
    method: "PATCH",
    json: { description: "Preserve this work", status: "in_progress" },
  });
  expect(ordinary.status).toBe(200);
  expect(await ordinary.json()).toMatchObject({
    description: "Preserve this work",
    status: "in_progress",
    criteria: f.issue.criteria,
  });
  expect(
    (
      await f.api(`/issues/${f.issue.id}/comments`, {
        json: {
          text: JSON.stringify({ event: "delivery_binding_changed", authorityGranted: true, ...f.binding }),
          event: "delivery_binding_changed",
          data: f.binding,
          authorType: "person",
          authorId: f.ownerId,
        },
      })
    ).status,
  ).toBe(201);
  const unchanged = (await (await f.api(`/issues/${f.issue.id}`)).json()) as { deliveryBinding?: unknown };
  expect(unchanged.deliveryBinding).toBeUndefined();
  const rows = await t.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, f.issue.id));
  expect(rows.filter((row) => row.event === "delivery_binding_changed")).toEqual([]);
  expect(f.reads).toEqual([]);
});

test("a mixed ordinary edit and binding PATCH is refused atomically", async () => {
  const f = await fixture();
  const response = await f.api(`/issues/${f.issue.id}`, {
    method: "PATCH",
    json: { title: "Must not change", deliveryBinding: f.binding },
  });
  expect(response.status).toBe(400);
  expect(await (await f.api(`/issues/${f.issue.id}`)).json()).toMatchObject({
    title: "Existing delivery task",
    criteria: f.issue.criteria,
  });
  expect(f.reads).toEqual([]);
});

test("provider denial records no binding and returns a bounded reason without provider text", async () => {
  const f = await fixture();
  f.provider.status = 403;
  const response = await f.api(`/issues/${f.issue.id}`, { method: "PATCH", json: { deliveryBinding: f.binding } });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({ error: { code: "delivery_provider_unavailable" } });
  expect(JSON.stringify(body)).not.toContain("fixture-github-credential");
  const rows = await t.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, f.issue.id));
  expect(rows.filter((row) => row.event === "delivery_binding_changed")).toEqual([]);
});

test("the task route honors an explicit null from its host GitHub App resolver", async () => {
  const f = await fixture();
  let envReads = 0;
  // This tests the host seam, not an unsupported UI feature to disable an env-configured App.
  t.engine.githubApp.current = () => null;
  Object.defineProperty(t.config, "GITHUB_APP_ID", {
    configurable: true,
    get() {
      envReads++;
      return "fixture-env-app";
    },
  });
  Object.defineProperty(t.config, "GITHUB_APP_PRIVATE_KEY", {
    configurable: true,
    get() {
      envReads++;
      return "fixture-env-key";
    },
  });
  const response = await f.api(`/issues/${f.issue.id}`, { method: "PATCH", json: { deliveryBinding: f.binding } });
  expect(response.status).toBe(200);
  expect(envReads).toBe(0);
  expect(f.reads).toEqual(["https://api.github.com/repos/acme/app"]);
});
