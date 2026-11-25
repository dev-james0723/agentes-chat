import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { FounderStatus, Traceability } from "@agenteschat/engine";
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
  return { orgId, agentId, channelId, issueId: issue.id, status, api };
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

test("traceability (ADR 0206): a requirement is delivered only once its merge runs here; an unlinked merge is flagged", async () => {
  const { orgId, issueId, api } = await world(async () => ({ digest: DIGEST, files: 10 }));
  const req = (await (await api("/issues", { json: { title: "Score preview", labels: ["requirement"] } })).json()) as {
    id: string;
  };
  await t.db.update(schema.issues).set({ parentIssueId: req.id, status: "done" }).where(eq(schema.issues.id, issueId));
  const OTHER = "c".repeat(40);
  await recordMergeEvidence(t.db, orgId, { subject: "acme/app#7", mergeCommit: OTHER });
  const read = async () => (await api("/traceability")).json() as Promise<Traceability>;
  const before = await read();
  expect(before.requirements[0]).toMatchObject({ id: req.id, state: "done_undelivered", delivered: false });
  expect(before.flags).toContainEqual({ kind: "unlinked_merge", subject: "acme/app#7", mergeCommit: OTHER });
  await recordDeploy(
    t.db,
    { orgId, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST },
    { digest: DIGEST, files: 10 },
  );
  expect((await read()).requirements[0]).toMatchObject({ state: "delivered", delivered: true });
});

test("independent verification (ADR 0211): contract, refused self-verification, missing evidence, then verified", async () => {
  const { orgId, issueId, status, api } = await world(async () => ({ digest: DIGEST, files: 10 }));
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  const contract = await api(`/issues/${issueId}/completion-contract`, {
    method: "PUT",
    json: { evidence: ["pr_merged", "deploy_running"] },
  });
  expect(contract.status).toBe(200);
  // The agent's work closed it: a claim, not verification.
  await t.db.update(schema.issues).set({ status: "done" }).where(eq(schema.issues.id, issueId));
  expect((await status()).verification).toMatchObject({ state: "done_unverified", verified: false });

  const verify = () => api(`/issues/${issueId}/verification`, { method: "POST", json: { verdict: "verified" } });
  const missing = await verify();
  expect(missing.status).toBe(409);
  expect(await code(missing)).toBe("evidence_missing");

  await recordDeploy(
    t.db,
    { orgId, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST },
    { digest: DIGEST, files: 10 },
  );
  const [user] = await t.db.select({ id: schema.users.id }).from(schema.users);
  // Assigned to the reader: they implemented it, so they can't verify it.
  await t.db
    .update(schema.issues)
    .set({ assigneeType: "person", assigneeId: user?.id ?? "" })
    .where(eq(schema.issues.id, issueId));
  const self = await verify();
  expect(self.status).toBe(403);
  expect(await code(self)).toBe("self_verification");

  await t.db.update(schema.issues).set({ assigneeType: null, assigneeId: null }).where(eq(schema.issues.id, issueId));
  const ok = await verify();
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ verdict: "verified", missing: [] });
  expect((await status()).verification).toMatchObject({ state: "verified", verified: true });

  const usage = (await (await api("/usage/cost-per-success")).json()) as { claims: { claimedDone: number } };
  expect(usage.claims).toBeDefined();
});
