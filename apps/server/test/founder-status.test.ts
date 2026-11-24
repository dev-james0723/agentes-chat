import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { FounderStatus } from "@agenteschat/engine";
import { recordDeploy, recordMergeEvidence } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

// ADR 0204: the route reads the server's own identity; a deploy it doesn't run never reads as available.

const DIGEST = `sha256:${"1".repeat(64)}`;
const MERGE = "a".repeat(40);
let t: TestServer;
afterEach(() => t?.close());

async function world(identity: (() => Promise<{ digest: string; files: number }>) | undefined) {
  t = await createTestServer({ sourceIdentity: identity });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const issue = (await (await api("/issues", { json: { title: "Score preview" } })).json()) as { id: string };
  // Agents link pull requests through their tools; the row is what the status reads.
  await t.db
    .update(schema.issues)
    .set({ pullRequests: [{ number: 42, url: "https://github.com/acme/app/pull/42", openedBy: null }] })
    .where(eq(schema.issues.id, issue.id));
  await recordMergeEvidence(t.db, orgId, { subject: "acme/app#42", mergeCommit: MERGE });
  const status = async () => (await api(`/issues/${issue.id}/founder-status`)).json() as Promise<FounderStatus>;
  return { orgId, agentId, channelId, issueId: issue.id, status };
}

test("available only when this server runs the recorded deploy of the merge", async () => {
  const { orgId, status } = await world(async () => ({ digest: DIGEST, files: 10 }));
  expect((await status()).delivery).toMatchObject({ state: "merged_not_deployed", available: false });
  await recordDeploy(
    t.db,
    { orgId, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST },
    { digest: DIGEST, files: 10 },
  );
  const s = await status();
  expect(s.delivery).toMatchObject({ state: "available", available: true });
  expect(s.needsMe).toMatchObject({ needed: false, decisions: [] });
  expect(s.summary).toContain("已喺現用版本");
});

test("negative control: a server that can't say what it runs reads as unknown, never available", async () => {
  const { orgId, status } = await world(async () => {
    throw new Error("unreadable tree");
  });
  // Recorded while it could say: the identity then is gone now.
  await recordDeploy(
    t.db,
    { orgId, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST },
    { digest: DIGEST, files: 10 },
  );
  expect((await status()).delivery).toMatchObject({ state: "runtime_unknown", available: false });
});

test("Needs you: a pending approval on the task's run, linked by its id and where its card is", async () => {
  const { orgId, agentId, channelId, issueId, status } = await world(async () => ({ digest: DIGEST, files: 10 }));
  const [user] = await t.db.select({ id: schema.users.id }).from(schema.users);
  const rootId = crypto.randomUUID();
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: rootId,
      triggerMessageId: rootId,
      trigger: "mention",
      hop: 1,
      status: "waiting_approval",
      startedAt: new Date(),
      issueId,
    })
    .returning();
  if (!run || !user) throw new Error("no run");
  const [approval] = await t.db
    .insert(schema.approvals)
    .values({
      orgId,
      runId: run.id,
      agentId,
      channelId,
      threadRootId: rootId,
      toolUseId: "toolu_1",
      tool: "merge_pull_request",
      scope: "pr.merge",
      params: {},
      actionHash: "h",
      title: "Merge PR #42 in acme/app",
      ownerUserId: user.id,
      expiresAt: new Date(Date.now() + 3600_000),
    })
    .returning();
  const s = await status();
  expect(s.needsMe).toMatchObject({ needed: true, decisions: [{ approvalId: approval?.id, channelId }] });
  expect(s.next).toMatchObject({ action: "decide", owner: { type: "you" } });
});
