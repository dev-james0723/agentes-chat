import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  createIssue,
  deriveFounderStatus,
  type FounderEvidence,
  founderStatus,
  mergeDetailsOf,
  mergeEvidenceOf,
  NotFoundError,
  postPersonMessage,
  prSubjectOf,
  recordDeploy,
  recordMergeEvidence,
  recordOutcome,
  setCriterion,
  updateIssue,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

// ADR 0204: a founder's status is a projection of stored evidence. These cases pin the rules that keep it honest.

const MERGE = "a".repeat(40);
const OTHER = "b".repeat(40);
const DIGEST = `sha256:${"1".repeat(64)}`;
const ELSEWHERE = `sha256:${"2".repeat(64)}`;
const PR_URL = "https://github.com/acme/app/pull/42";
const SUBJECT = "acme/app#42";
const NOW = new Date("2026-11-19T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() - (60 - minutes) * 60_000);

function evidence(over: Partial<FounderEvidence> = {}, issue: Partial<FounderEvidence["issue"]> = {}): FounderEvidence {
  return {
    issue: {
      id: "issue-1",
      number: 7,
      title: "Score preview in File Room",
      description: "James can read a score next to the file.\n\nDetails for engineers.",
      status: "in_review",
      criteria: [],
      createdBy: { type: "person", id: "james" },
      assignee: { type: "agent", id: "agent-1" },
      pullRequests: [{ number: 42, url: PR_URL }],
      blocked: null,
      ...issue,
    },
    outcomes: [],
    decisions: [],
    running: { digest: DIGEST, files: 3000 },
    names: { james: "James", "agent-1": "Ada" },
    now: NOW,
    ...over,
  };
}

const merged = (mergeCommit: string | null = MERGE, minute = 10) => ({
  id: `m-${minute}`,
  kind: "pr_merged",
  subject: SUBJECT,
  details: mergeCommit ? { mergeCommit } : {},
  createdAt: at(minute),
});
const deployed = (commit: string, digest: string, minute = 20, commits: string[] = []) => ({
  id: `d-${minute}`,
  kind: "deploy_succeeded",
  subject: "deploy:acme/app",
  details: { repo: "acme/app", commit, sourceDigest: digest, commits },
  createdAt: at(minute),
});

describe("delivery: available only when the running server is the deploy that holds the merge", () => {
  test("negative control: merged but never deployed is never available", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [merged()] }));
    expect(s.delivery.state).toBe("merged_not_deployed");
    expect(s.delivery.available).toBe(false);
    expect(s.delivery.text).toContain("未有部署紀錄");
    expect(s.summary).not.toContain("已喺現用版本");
  });

  test("not merged: a linked PR alone is code, not delivery", () => {
    const s = deriveFounderStatus(evidence());
    expect(s.delivery.state).toBe("not_merged");
    expect(s.delivery.available).toBe(false);
    expect(s.next).toMatchObject({ action: "merge_pr", owner: { type: "agent", id: "agent-1", name: "Ada" } });
  });

  test("deployed and the server runs that digest now: available", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [merged(), deployed(MERGE, DIGEST)] }));
    expect(s.delivery.state).toBe("available");
    expect(s.delivery.available).toBe(true);
    expect(s.delivery.text).toContain("已喺現用版本");
  });

  test("a later deploy that names the merge among its commits counts", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [merged(), deployed(OTHER, DIGEST, 30, [MERGE])] }));
    expect(s.delivery.state).toBe("available");
  });

  test("negative control: deployed once, but the server runs something else now", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [merged(), deployed(MERGE, ELSEWHERE)] }));
    expect(s.delivery.state).toBe("deployed_not_running");
    expect(s.delivery.available).toBe(false);
  });

  test("negative control: the server can't say what it runs, so nobody knows", () => {
    for (const running of [null, { digest: DIGEST, files: 0 }]) {
      const s = deriveFounderStatus(evidence({ outcomes: [merged(), deployed(MERGE, DIGEST)], running }));
      expect(s.delivery.state).toBe("runtime_unknown");
      expect(s.delivery.available).toBe(false);
    }
  });

  test("negative control: a merge with no recorded commit can't be matched to any deploy", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [merged(null), deployed(OTHER, DIGEST)] }));
    expect(s.delivery.state).toBe("merge_commit_unknown");
    expect(s.delivery.available).toBe(false);
  });

  test("negative control: rolled back after the deploy", () => {
    const back = { ...deployed(MERGE, DIGEST, 40), id: "r", kind: "deploy_rolled_back" };
    const s = deriveFounderStatus(evidence({ outcomes: [merged(), deployed(MERGE, DIGEST), back] }));
    expect(s.delivery.available).toBe(false);
    expect(s.delivery.state).toBe("rolled_back");
  });

  test("negative control: reverted after the merge", () => {
    const revert = { ...merged(MERGE, 30), id: "rv", kind: "pr_reverted" };
    const s = deriveFounderStatus(evidence({ outcomes: [merged(), revert, deployed(MERGE, DIGEST)] }));
    expect(s.delivery.state).toBe("reverted");
    expect(s.delivery.available).toBe(false);
  });

  test("negative control: another PR's merge and deploy say nothing about this task", () => {
    const foreign = { ...merged(), subject: "acme/app#43" };
    const s = deriveFounderStatus(evidence({ outcomes: [foreign, deployed(MERGE, DIGEST)] }));
    expect(s.delivery.state).toBe("not_merged");
  });
});

describe("verification: only a persisted, person-vouched outcome is verified", () => {
  const criteria = (doneBy: "person" | "agent" | null) => [
    { id: "c1", text: "Opens", done: doneBy !== null, doneBy: doneBy ? { type: doneBy, id: "x" } : null },
  ];
  const met = (minute = 30) => ({
    id: `cm-${minute}`,
    kind: "criteria_met",
    subject: "",
    details: { issueId: "issue-1" },
    createdAt: at(minute),
  });

  test("negative control: marked done in the UI without a persisted outcome is never verified", () => {
    const s = deriveFounderStatus(evidence({}, { status: "done", criteria: criteria("person") }));
    expect(s.verification.state).toBe("done_unverified");
    expect(s.verification.verified).toBe(false);
  });

  test("negative control: an agent ticking its own criteria is not verification", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [met()] }, { status: "done", criteria: criteria("agent") }));
    expect(s.verification.verified).toBe(false);
  });

  test("negative control: a criterion unchecked after the outcome", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [met()] }, { status: "done", criteria: criteria(null) }));
    expect(s.verification.verified).toBe(false);
  });

  test("negative control: reopened after the outcome", () => {
    const reopened = {
      id: "ro",
      kind: "issue_reopened",
      subject: "",
      details: { issueId: "issue-1" },
      createdAt: at(40),
    };
    const s = deriveFounderStatus(
      evidence({ outcomes: [met(), reopened] }, { status: "in_progress", criteria: criteria("person") }),
    );
    expect(s.verification.verified).toBe(false);
  });

  test("criteria_met with every criterion checked by a person: verified", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [met()] }, { status: "done", criteria: criteria("person") }));
    expect(s.verification.state).toBe("verified");
    expect(s.verification.verified).toBe(true);
  });

  test("no criteria: nothing to verify against, said so", () => {
    const s = deriveFounderStatus(evidence({}, { status: "done" }));
    expect(s.verification.state).toBe("no_criteria");
    expect(s.verification.verified).toBe(false);
  });

  test("CI and test outcomes are listed as checks, newest per kind, never as verification", () => {
    const ci = { id: "ci", kind: "ci_passed", subject: SUBJECT, details: {}, createdAt: at(15) };
    const s = deriveFounderStatus(evidence({ outcomes: [ci] }, { status: "done", criteria: criteria("person") }));
    expect(s.verification.checks).toMatchObject([{ kind: "ci_passed", positive: true }]);
    expect(s.verification.verified).toBe(false);
  });
});

describe("Needs Me: only a real pending decision", () => {
  const decision = {
    approvalId: "ap-1",
    title: "Merge PR #42 into main",
    channelId: "ch",
    threadId: "th",
    messageId: "msg",
    expiresAt: new Date(NOW.getTime() + 3600_000),
  };

  test("negative control: blocked, in review, failing CI: none of it is a decision for James", () => {
    const failing = { id: "f", kind: "ci_failed", subject: SUBJECT, details: {}, createdAt: at(15) };
    const s = deriveFounderStatus(
      evidence({ outcomes: [failing] }, { blocked: { reason: "waiting_on_service", since: at(5).toISOString() } }),
    );
    expect(s.needsMe.needed).toBe(false);
    expect(s.needsMe.decisions).toEqual([]);
    expect(s.needsMe.text).toBe("唔使你決定任何嘢。");
    expect(s.next.owner?.type).not.toBe("you");
  });

  test("a pending approval James can decide: Needs Me, and it is the next action", () => {
    const s = deriveFounderStatus(evidence({ decisions: [decision] }));
    expect(s.needsMe.needed).toBe(true);
    expect(s.needsMe.decisions).toHaveLength(1);
    expect(s.next).toMatchObject({ action: "decide", owner: { type: "you" } });
  });

  test("negative control: an expired request is no decision", () => {
    const s = deriveFounderStatus(evidence({ decisions: [{ ...decision, expiresAt: at(1) }] }));
    expect(s.needsMe.needed).toBe(false);
  });
});

describe("what changed and why, from what people wrote", () => {
  test("why it matters: a person's description, first paragraph only", () => {
    expect(deriveFounderStatus(evidence()).changed.why).toBe("James can read a score next to the file.");
  });

  test("negative control: an agent's description is not the reason", () => {
    const s = deriveFounderStatus(evidence({}, { createdBy: { type: "agent", id: "agent-1" } }));
    expect(s.changed.why).toBeNull();
    expect(s.changed.text).toContain("未有人寫低");
  });

  test("blockers come from the task's own record", () => {
    const s = deriveFounderStatus(
      evidence({}, { blocked: { reason: "waiting_on_service", since: at(5).toISOString(), text: "API down" } }),
    );
    expect(s.blockers).toMatchObject([{ reason: "waiting_on_service" }]);
    expect(s.next).toMatchObject({ action: "unblock", owner: { type: "agent", id: "agent-1" } });
  });

  test("an unknown tool effect is a blocker until a later run ends cleanly", () => {
    const unknown = {
      id: "u",
      kind: "run_effect_unknown",
      subject: "",
      details: { issueId: "issue-1" },
      createdAt: at(10),
    };
    expect(deriveFounderStatus(evidence({ outcomes: [unknown] })).blockers).toMatchObject([
      { reason: "effect_unknown" },
    ]);
    const done = { id: "d", kind: "run_done", subject: "", details: { issueId: "issue-1" }, createdAt: at(20) };
    expect(deriveFounderStatus(evidence({ outcomes: [unknown, done] })).blockers).toEqual([]);
  });

  test("merged and not deployed: the next action is a deploy, its owner unknown", () => {
    const s = deriveFounderStatus(evidence({ outcomes: [merged()] }));
    expect(s.next).toMatchObject({ action: "deploy", owner: null });
  });
});

describe("evidence helpers", () => {
  test("a PR address names its subject; anything else names none", () => {
    expect(prSubjectOf(PR_URL)).toBe(SUBJECT);
    expect(prSubjectOf("https://github.com/Acme/App/pull/42/files")).toBe(SUBJECT);
    expect(prSubjectOf("https://example.com/acme/app/pull/42")).toBeNull();
    expect(prSubjectOf("https://github.com/acme/app/issues/42")).toBeNull();
  });

  test("GitHub's answer to an agent's merge gives the commit; anything else gives none", () => {
    expect(mergeDetailsOf("pr_merged", JSON.stringify({ sha: MERGE, merged: true }))).toEqual({
      details: { mergeCommit: MERGE },
    });
    expect(mergeDetailsOf("pr_merged", JSON.stringify({ sha: MERGE, merged: false }))).toEqual({});
    expect(mergeDetailsOf("pr_merged", "Merged!")).toEqual({});
    expect(mergeDetailsOf("ci_passed", JSON.stringify({ sha: MERGE, merged: true }))).toEqual({});
  });

  test("a merged pull_request webhook gives the merge commit; a close without merge gives nothing", () => {
    const payload = {
      action: "closed",
      repository: { full_name: "Acme/App" },
      pull_request: { number: 42, merged: true, merge_commit_sha: MERGE },
    };
    expect(mergeEvidenceOf("pull_request", payload)).toEqual({ subject: SUBJECT, mergeCommit: MERGE });
    expect(
      mergeEvidenceOf("pull_request", { ...payload, pull_request: { ...payload.pull_request, merged: false } }),
    ).toBeNull();
    expect(mergeEvidenceOf("issues", payload)).toBeNull();
    expect(
      mergeEvidenceOf("pull_request", { ...payload, pull_request: { ...payload.pull_request, merge_commit_sha: "x" } }),
    ).toBeNull();
  });
});

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

describe("founderStatus: read from the database", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const owner = () => ({ type: "person" as const, userId: f.owner.id });

  async function issueWithRun() {
    const issue = await createIssue(deps(), owner(), f.org.id, { title: "Preview" });
    await updateIssue(deps(), owner(), f.org.id, issue.id, { addPullRequest: { number: 42, url: PR_URL } });
    const msg = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "go" });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
        status: "waiting_approval",
        startedAt: new Date(),
        issueId: issue.id,
      })
      .returning();
    if (!run) throw new Error("no run");
    return { issue, run };
  }

  const approval = (run: { id: string; channelId: string; threadRootId: string }, over: Record<string, unknown>) =>
    f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        runId: run.id,
        agentId: f.agent.id,
        channelId: run.channelId,
        threadRootId: run.threadRootId,
        toolUseId: `toolu_${Math.random()}`,
        tool: "merge_pull_request",
        scope: "pr.merge",
        params: {},
        actionHash: "hash-1",
        title: "Merge PR #42 in acme/app",
        ownerUserId: f.owner.id,
        expiresAt: new Date(Date.now() + 3600_000),
        ...over,
      })
      .returning();

  test("a pending approval on the task's run is Needs Me for whoever decides it, nobody else", async () => {
    f = await setup();
    const { issue, run } = await issueWithRun();
    await approval(run, {});
    const running = { digest: DIGEST, files: 10 };
    const mine = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running);
    expect(mine.needsMe.needed).toBe(true);
    expect(mine.delivery.state).toBe("not_merged");

    const member = await addMember(f.db, f.org.id, "member", "Bea");
    const theirs = await founderStatus(f.db, member.id, f.org.id, issue.id, running);
    expect(theirs.needsMe.needed).toBe(false);
  });

  test("negative control: the same action already approved and not yet run is not asked again", async () => {
    f = await setup();
    const { issue, run } = await issueWithRun();
    await approval(run, { status: "approved", decidedByUserId: f.owner.id, decidedAt: new Date() });
    await approval(run, {});
    const s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, null);
    expect(s.needsMe.needed).toBe(false);
  });

  test("negative control: an expired pending approval, or another task's, is no decision", async () => {
    f = await setup();
    const { issue, run } = await issueWithRun();
    await approval(run, { expiresAt: new Date(Date.now() - 1000) });
    const other = await issueWithRun();
    await approval(other.run, { actionHash: "hash-2" });
    const s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, null);
    expect(s.needsMe.needed).toBe(false);
  });

  test("merge and deploy evidence flow through the stored outcomes", async () => {
    f = await setup();
    const { issue } = await issueWithRun();
    await recordMergeEvidence(f.db, f.org.id, { subject: SUBJECT, mergeCommit: MERGE });
    const running = { digest: DIGEST, files: 10 };
    expect((await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running)).delivery.state).toBe(
      "merged_not_deployed",
    );
    await recordDeploy(f.db, { orgId: f.org.id, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST }, running);
    expect((await founderStatus(f.db, f.owner.id, f.org.id, issue.id, running)).delivery.available).toBe(true);
    // Another server build now: no longer available.
    const later = { digest: ELSEWHERE, files: 10 };
    expect((await founderStatus(f.db, f.owner.id, f.org.id, issue.id, later)).delivery.available).toBe(false);
  });

  test("merge evidence is recorded once per commit", async () => {
    f = await setup();
    await recordMergeEvidence(f.db, f.org.id, { subject: SUBJECT, mergeCommit: MERGE });
    await recordMergeEvidence(f.db, f.org.id, { subject: SUBJECT, mergeCommit: MERGE });
    const rows = await f.db
      .select()
      .from(schema.outcomes)
      .where(and(eq(schema.outcomes.orgId, f.org.id), eq(schema.outcomes.kind, "pr_merged")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: SUBJECT, source: "webhook", details: { mergeCommit: MERGE } });
  });

  test("negative control: a deploy record the server doesn't run is refused", async () => {
    f = await setup();
    const running = { digest: DIGEST, files: 10 };
    const input = { orgId: f.org.id, repo: "acme/app", commit: MERGE, sourceDigest: ELSEWHERE };
    await expect(recordDeploy(f.db, input, running)).rejects.toBeInstanceOf(ConflictError);
    await expect(recordDeploy(f.db, input, null)).rejects.toBeInstanceOf(ConflictError);
    const ok = await recordDeploy(f.db, { ...input, sourceDigest: DIGEST }, running);
    const again = await recordDeploy(f.db, { ...input, sourceDigest: DIGEST }, running);
    expect(again.id).toBe(ok.id);
  });

  test("a person-vouched criteria_met makes it verified; a task they can't see is a 404", async () => {
    f = await setup();
    const issue = await createIssue(deps(), owner(), f.org.id, {
      title: "Preview",
      criteria: ["Opens"],
      audience: { mode: "people", userIds: [f.owner.id] },
    });
    const [c] = issue.criteria;
    if (!c) throw new Error("no criterion");
    await setCriterion(deps(), owner(), f.org.id, issue.id, c.id, true);
    const s = await founderStatus(f.db, f.owner.id, f.org.id, issue.id, null);
    expect(s.verification.state).toBe("verified");
    const member = await addMember(f.db, f.org.id, "member", "Bea");
    await expect(founderStatus(f.db, member.id, f.org.id, issue.id, null)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("recordOutcome stays the only writer: an operator-sourced deploy is an ordinary outcome row", async () => {
    f = await setup();
    const row = await recordOutcome(f.db, { orgId: f.org.id, kind: "deploy_succeeded", source: "operator" });
    expect(row.source).toBe("operator");
  });
});
