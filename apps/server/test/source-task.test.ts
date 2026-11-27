import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import { callTool, connectApp, mcp, token } from "./ai-apps";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["checked"] }) });
});
afterEach(() => t.close());
const SOURCE = "https://x.com/example/status/2123733950308974993?s=20";
const CANONICAL = "https://x.com/i/status/2123733950308974993";
type Bound = {
  state: string;
  issue_id: string;
  channel_id: string;
  thread_id: string;
  binding_id: string;
  owner_user_id: string;
  workspace_id: string;
  source_key: string;
  source_url: string;
  created: boolean;
  replayed: boolean;
};
async function setup() {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const app = await connectApp(t, b, seeded.orgId);
  return { b, app, ...seeded };
}
async function ensure(access: string, key: string, source = SOURCE, expected?: string) {
  return callTool(t, access, "ensure_source_task", {
    source_url: source,
    idempotency_key: key,
    ...(expected ? { expected_issue_id: expected } : {}),
  });
}
const bindings = () => t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "apps.source_task.bound"));

test("read is non-mutating; first ensure creates one owner-private native task and no agent work", async () => {
  const { b, app, orgId } = await setup();
  const reader = await connectApp(t, b, orgId, { access: "read", scope: "read" });
  const before = await t.db.select().from(schema.auditLog);
  const unbound = await callTool(t, reader.access, "read_source_task", { source_url: SOURCE });
  expect(unbound.structuredContent).toMatchObject({ state: "unbound", source_key: "x:2123733950308974993" });
  expect(await t.db.select().from(schema.auditLog)).toEqual(before);
  const unavailable = await mcp(t, reader.access, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "ensure_source_task", arguments: { source_url: SOURCE, idempotency_key: "read-denied" } },
  });
  expect(JSON.stringify(await unavailable.json())).toContain("error");
  expect(await bindings()).toHaveLength(0);
  const result = await ensure(app.access, "bookmark");
  expect(result.isError).not.toBe(true);
  const bound = result.structuredContent as Bound;
  expect(bound).toMatchObject({
    state: "bound",
    schema_version: 1,
    source_url: CANONICAL,
    source_key: "x:2123733950308974993",
    workspace_id: orgId,
    channel_kind: "task",
    created: true,
  });
  const issue = await (await b(`/api/app/organizations/${orgId}/issues/${bound.issue_id}`)).json();
  expect(issue).toMatchObject({
    id: bound.issue_id,
    source: { type: "manual" },
    status: "todo",
    audience: { mode: "people", userIds: [bound.owner_user_id] },
  });
  expect(await t.db.select().from(schema.appSends)).toHaveLength(0);
  expect(await t.db.select().from(schema.agentRuns)).toHaveLength(0);
  const after = await t.db.select().from(schema.auditLog);
  expect(
    (await callTool(t, reader.access, "read_source_task", { source_url: SOURCE })).structuredContent,
  ).toMatchObject({ issue_id: bound.issue_id, channel_id: bound.channel_id, thread_id: bound.thread_id });
  expect(await t.db.select().from(schema.auditLog)).toEqual(after);
});

test("simultaneous bookmark/Share/repeated Share aliases and lost-response replay preserve one binding", async () => {
  const { app } = await setup();
  const results = await Promise.all([
    ensure(app.access, "bookmark"),
    ensure(app.access, "bookmark"),
    ensure(app.access, "share", "https://twitter.com/another/status/2123733950308974993/photo/1"),
    ensure(app.access, "share-again", CANONICAL),
  ]);
  for (const result of results) expect(result.isError).not.toBe(true);
  const values = results.map((r) => r.structuredContent as Bound);
  expect(new Set(values.map((v) => v.issue_id)).size).toBe(1);
  expect(new Set(values.map((v) => v.thread_id)).size).toBe(1);
  expect(values.filter((v) => v.created)).toHaveLength(1);
  expect(await bindings()).toHaveLength(1);
  expect(await t.db.select().from(schema.issues)).toHaveLength(1);
  const replay = (await ensure(app.access, "bookmark")).structuredContent as Bound;
  expect(replay).toMatchObject({ issue_id: values[0]?.issue_id, replayed: true, created: false });
  const conflict = await ensure(app.access, "bookmark", "https://x.com/example/status/123");
  expect(conflict.isError).toBe(true);
  expect(await t.db.select().from(schema.issues)).toHaveLength(1);
});

test("token rotation and a newly authorized app retain the owner/source binding without receipt TTL", async () => {
  const { b, app, orgId } = await setup();
  const original = (await ensure(app.access, "first")).structuredContent as Bound;
  await t.db
    .update(schema.auditLog)
    .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
    .where(eq(schema.auditLog.action, "apps.source_task.bound"));
  const refreshed = await token(t, {
    grant_type: "refresh_token",
    refresh_token: app.refresh,
    client_id: app.clientId,
  });
  expect(refreshed.res.status).toBe(200);
  const rotated = (await ensure(String(refreshed.json.access_token), "rotated")).structuredContent as Bound;
  const another = await connectApp(t, b, orgId, { name: "Second authorized app" });
  const reauthorized = (await ensure(another.access, "reauthorized")).structuredContent as Bound;
  for (const bound of [rotated, reauthorized])
    expect(bound).toMatchObject({
      issue_id: original.issue_id,
      channel_id: original.channel_id,
      thread_id: original.thread_id,
      binding_id: original.binding_id,
      created: false,
    });
  expect(await bindings()).toHaveLength(1);
});

test("deleted task is a binding tombstone; a read or repeated Share never recreates it", async () => {
  const { b, app, orgId } = await setup();
  const bound = (await ensure(app.access, "first")).structuredContent as Bound;
  expect((await b(`/api/app/organizations/${orgId}/issues/${bound.issue_id}`, { method: "DELETE" })).status).toBe(204);
  expect((await callTool(t, app.access, "read_source_task", { source_url: SOURCE })).isError).toBe(true);
  expect((await ensure(app.access, "share")).isError).toBe(true);
  expect((await ensure(app.access, "first")).isError).toBe(true);
  expect(await bindings()).toHaveLength(1);
  expect(await t.db.select().from(schema.issues)).toHaveLength(0);
});

test("owner and workspace scope prevent arbitrary legacy issue binding or access to another source task", async () => {
  const { b, app, orgId } = await setup();
  const bound = (await ensure(app.access, "first")).structuredContent as Bound;
  const member = await joinByInvitation(t, b, orgId, "member@example.com");
  const theirs = await connectApp(t, member, orgId);
  expect(
    (await callTool(t, theirs.access, "read_source_task", { source_url: SOURCE })).structuredContent,
  ).toMatchObject({ state: "unbound" });
  expect((await ensure(theirs.access, "steal", SOURCE, bound.issue_id)).isError).toBe(true);
  expect((await member(`/api/app/organizations/${orgId}/issues/${bound.issue_id}`)).status).toBe(404);
  const legacy = (await (
    await b(`/api/app/organizations/${orgId}/issues`, {
      json: { title: "Saved X post 123", description: "https://x.com/a/status/123" },
    })
  ).json()) as { id: string };
  expect((await ensure(app.access, "legacy", "https://x.com/a/status/123", legacy.id)).isError).toBe(true);
  await b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json: { finished: true } });
  const other = (await (await b("/api/app/organizations", { json: { name: "Other" } })).json()) as {
    organization: { id: string };
  };
  const cross = await connectApp(t, b, other.organization.id);
  expect((await ensure(cross.access, "cross", SOURCE, bound.issue_id)).isError).toBe(true);
  expect(await bindings()).toHaveLength(1);
});

test("binding conflicts and damaged native roots fail closed and leave the existing issue untouched", async () => {
  const { app } = await setup();
  const bound = (await ensure(app.access, "first")).structuredContent as Bound;
  const [row] = await bindings();
  if (!row) throw new Error("binding absent");
  await t.db.insert(schema.auditLog).values({ ...row, id: undefined });
  expect((await callTool(t, app.access, "read_source_task", { source_url: SOURCE })).isError).toBe(true);
  expect((await ensure(app.access, "duplicate")).isError).toBe(true);
  const duplicate = (await bindings()).find((r) => r.id !== row.id);
  if (!duplicate) throw new Error("duplicate fixture absent");
  await t.db
    .delete(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "apps.source_task.bound"), eq(schema.auditLog.id, duplicate.id)));
  await t.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, bound.thread_id));
  expect((await ensure(app.access, "root-deleted")).isError).toBe(true);
  expect(await t.db.select().from(schema.issues)).toHaveLength(1);
});

test("cross-agent phases use the canonical native root while execution messages remain distinct and directly verified", async () => {
  const { app, channelId, agentId } = await setup();
  const bound = (await ensure(app.access, "bookmark")).structuredContent as Bound;
  const phase = async (agent: string, key: string) => {
    const result = await callTool(t, app.access, "send_to_agent", {
      agent,
      message: key,
      channel_id: bound.channel_id,
      thread_id: bound.thread_id,
      wait_seconds: 0,
      idempotency_key: key,
    });
    expect(result.isError).not.toBe(true);
    const sent = result.structuredContent as {
      task_id: string;
      thread_id: string;
      channel: { id: string; kind: string };
    };
    expect(sent).toMatchObject({ thread_id: bound.thread_id, channel: { id: bound.channel_id, kind: "task" } });
    expect(sent.task_id).not.toBe(bound.thread_id);
    await t.drain();
    const done = await callTool(t, app.access, "wait_for_reply", { task_id: sent.task_id, timeout_seconds: 1 });
    expect(done.structuredContent).toMatchObject({
      status: "done",
      thread_id: bound.thread_id,
      direct_reply: { task_id: sent.task_id },
      channel: { id: bound.channel_id, kind: "task" },
    });
    return sent.task_id;
  };
  const research = await phase("dev", "research");
  expect((await ensure(app.access, "share")).structuredContent).toMatchObject({ issue_id: bound.issue_id });
  const adoption = await phase("lodi", "adoption");
  const review = await phase("dev", "independent-review");
  expect(new Set([research, adoption, review]).size).toBe(3);
  const replay = await callTool(t, app.access, "send_to_agent", {
    agent: "dev",
    message: "independent-review",
    channel_id: bound.channel_id,
    thread_id: bound.thread_id,
    wait_seconds: 0,
    idempotency_key: "independent-review",
  });
  expect(replay.structuredContent).toMatchObject({ task_id: review });
  expect(await t.db.select().from(schema.appSends)).toHaveLength(3);
  for (const args of [
    { channel_id: channelId, thread_id: bound.thread_id },
    { channel_id: bound.channel_id, thread_id: research },
  ]) {
    const bad = await callTool(t, app.access, "send_to_agent", {
      agent: agentId,
      message: "bad root",
      wait_seconds: 0,
      ...args,
    });
    expect(bad.isError).toBe(true);
  }
  expect(await bindings()).toHaveLength(1);
});

test("input schemas reject credentials, untrusted target IDs and unsupported source URLs without side effects", async () => {
  const { app } = await setup();
  for (const source of [
    "http://x.com/a/status/1",
    "https://user:secret@x.com/a/status/1",
    "not a URL",
    "https://x.com:444/a/status/1",
  ]) {
    expect((await ensure(app.access, "invalid", source)).isError).toBe(true);
  }
  const forged = await callTool(t, app.access, "ensure_source_task", {
    source_url: SOURCE,
    idempotency_key: "forged",
    owner_user_id: crypto.randomUUID(),
    issue_id: crypto.randomUUID(),
  });
  expect(forged.isError).toBe(true);
  expect(await bindings()).toHaveLength(0);
  expect(await t.db.select().from(schema.issues)).toHaveLength(0);
});

test("concurrent grants keep one source task; a failed binding audit rolls back issue and conversation", async () => {
  const { b, app, orgId } = await setup();
  const another = await connectApp(t, b, orgId, { name: "Concurrent app" });
  const results = await Promise.all([ensure(app.access, "one"), ensure(another.access, "two")]);
  expect(results.every((r) => r.isError !== true)).toBe(true);
  expect(new Set(results.map((r) => r.structuredContent?.issue_id)).size).toBe(1);
  const beforeIssues = await t.db.select().from(schema.issues);
  const beforeChannels = await t.db.select().from(schema.channels);
  const beforeMessages = await t.db.select().from(schema.messages);
  await t.db.execute(sql`ALTER TABLE audit_log ADD CONSTRAINT source_binding_test_failure
    CHECK (action <> 'apps.source_task.bound') NOT VALID`);
  expect((await ensure(app.access, "failure", "https://x.com/a/status/456")).isError).toBe(true);
  expect(await t.db.select().from(schema.issues)).toEqual(beforeIssues);
  expect(await t.db.select().from(schema.channels)).toEqual(beforeChannels);
  expect(await t.db.select().from(schema.messages)).toEqual(beforeMessages);
  expect(await bindings()).toHaveLength(1);
  await t.db.execute(sql`ALTER TABLE audit_log DROP CONSTRAINT source_binding_test_failure`);
  const recovered = (await ensure(app.access, "failure", "https://x.com/a/status/456")).structuredContent as Bound;
  expect(recovered).toMatchObject({ created: true, replayed: false });
  expect(await bindings()).toHaveLength(2);
});
