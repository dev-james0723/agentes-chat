import { afterEach, describe, expect, test } from "bun:test";
import {
  createIssue,
  deriveTraceability,
  type TraceEvidence,
  recordDeploy,
  recordMergeEvidence,
  traceability,
  updateIssue,
} from "../src";
import { type Fixture, setup } from "./fixtures";

// ADR 0206: requirement → task → merge commit → deploy, read from stored records only.

const MERGE = "a".repeat(40);
const OTHER = "c".repeat(40);
const DIGEST = `sha256:${"1".repeat(64)}`;
const ELSEWHERE = `sha256:${"2".repeat(64)}`;
const RUNNING = { digest: DIGEST, files: 10 };
const at = (m: number) => new Date(Date.UTC(2026, 10, 19, 10, m));

type Issue = TraceEvidence["issues"][number];
const issue = (over: Partial<Issue>): Issue => ({
  id: "req",
  number: 1,
  title: "Score preview",
  status: "todo",
  labels: [],
  parentIssueId: null,
  pullRequests: [],
  ...over,
});
const requirement = (over: Partial<Issue> = {}) => issue({ labels: ["requirement"], ...over });
const task = (over: Partial<Issue> = {}) =>
  issue({
    id: "task",
    number: 2,
    title: "Build it",
    parentIssueId: "req",
    status: "done",
    pullRequests: [{ number: 42, url: "https://github.com/acme/app/pull/42" }],
    ...over,
  });
const merged = (subject = "acme/app#42", commit = MERGE) => ({
  id: `m-${subject}`,
  kind: "pr_merged",
  subject,
  details: { mergeCommit: commit },
  createdAt: at(1),
});
const deployed = (commit = MERGE, digest = DIGEST) => ({
  id: `d-${commit}`,
  kind: "deploy_succeeded",
  subject: "deploy:acme/app",
  details: { commit, sourceDigest: digest },
  createdAt: at(2),
});

describe("deriveTraceability", () => {
  test("delivered only when every task is closed and its merge runs here", () => {
    const t = deriveTraceability({
      issues: [requirement(), task()],
      outcomes: [merged(), deployed()],
      running: RUNNING,
    });
    expect(t.requirements[0]).toMatchObject({ number: 1, state: "delivered", delivered: true });
    expect(t.requirements[0]?.tasks[0]?.changes[0]).toMatchObject({
      subject: "acme/app#42",
      mergeCommit: MERGE,
      delivery: "available",
    });
    expect(t.flags).toEqual([]);
  });

  test("negative control: merged but not deployed is never delivered, and is flagged", () => {
    const t = deriveTraceability({ issues: [requirement(), task()], outcomes: [merged()], running: RUNNING });
    expect(t.requirements[0]).toMatchObject({ state: "done_undelivered", delivered: false });
    expect(t.requirements[0]?.tasks[0]?.changes[0]?.delivery).toBe("merged_not_deployed");
    expect(t.flags).toContainEqual({ kind: "done_without_delivery", requirementId: "req", number: 1 });
  });

  test("negative control: a deploy this server no longer runs is not delivered", () => {
    const t = deriveTraceability({
      issues: [requirement(), task()],
      outcomes: [merged(), deployed(MERGE, ELSEWHERE)],
      running: RUNNING,
    });
    expect(t.requirements[0]?.delivered).toBe(false);
  });

  test("negative control: one delivered PR does not cover another merged but undeployed one", () => {
    const t = deriveTraceability({
      issues: [
        requirement(),
        task(),
        task({ id: "t2", number: 3, pullRequests: [{ number: 43, url: "https://github.com/acme/app/pull/43" }] }),
      ],
      outcomes: [merged(), deployed(), merged("acme/app#43", OTHER)],
      running: RUNNING,
    });
    expect(t.requirements[0]?.delivered).toBe(false);
  });

  test("open tasks keep it in progress; no tasks and no PR is no_tasks", () => {
    const open = deriveTraceability({
      issues: [requirement(), task({ status: "in_progress" })],
      outcomes: [merged(), deployed()],
      running: RUNNING,
    });
    expect(open.requirements[0]).toMatchObject({ state: "in_progress", delivered: false });
    const empty = deriveTraceability({ issues: [requirement()], outcomes: [], running: RUNNING });
    expect(empty.requirements[0]).toMatchObject({ state: "no_tasks", delivered: false });
  });

  test("a requirement with no sub-tasks traces its own pull requests", () => {
    const t = deriveTraceability({
      issues: [
        requirement({ status: "done", pullRequests: [{ number: 42, url: "https://github.com/acme/app/pull/42" }] }),
      ],
      outcomes: [merged(), deployed()],
      running: RUNNING,
    });
    expect(t.requirements[0]).toMatchObject({ state: "delivered", delivered: true });
  });

  test("a merged PR no task links is flagged; a linked one is not", () => {
    const t = deriveTraceability({
      issues: [requirement(), task()],
      outcomes: [merged(), deployed(), merged("acme/app#99", OTHER)],
      running: RUNNING,
    });
    expect(t.flags).toEqual([{ kind: "unlinked_merge", subject: "acme/app#99", mergeCommit: OTHER }]);
  });

  test("two open requirements with the same title are flagged as duplicates", () => {
    const t = deriveTraceability({
      issues: [requirement(), requirement({ id: "req2", number: 9, title: "  score PREVIEW! " })],
      outcomes: [],
      running: RUNNING,
    });
    expect(t.flags).toContainEqual({ kind: "duplicate_requirement", numbers: [1, 9] });
  });

  test("tasks not under a requirement are not requirements", () => {
    const t = deriveTraceability({ issues: [issue({ labels: ["bug"] })], outcomes: [], running: RUNNING });
    expect(t.requirements).toEqual([]);
  });
});

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

describe("traceability: read from the database", () => {
  test("requirement label + sub-task + webhook merge + deploy record", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const owner = { type: "person" as const, userId: f.owner.id };
    const req = await createIssue(deps, owner, f.org.id, { title: "Score preview", labels: ["Requirement"] });
    const child = await createIssue(deps, owner, f.org.id, { title: "Build it", parentIssueId: req.id });
    await updateIssue(deps, owner, f.org.id, child.id, {
      addPullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
    });
    await updateIssue(deps, owner, f.org.id, child.id, { status: "done" });
    await recordMergeEvidence(f.db, f.org.id, { subject: "acme/app#42", mergeCommit: MERGE });
    await recordMergeEvidence(f.db, f.org.id, { subject: "acme/app#7", mergeCommit: OTHER });

    const before = await traceability(f.db, f.owner.id, f.org.id, RUNNING);
    expect(before.requirements[0]).toMatchObject({ id: req.id, state: "done_undelivered", delivered: false });
    expect(before.flags).toContainEqual({ kind: "unlinked_merge", subject: "acme/app#7", mergeCommit: OTHER });

    await recordDeploy(f.db, { orgId: f.org.id, repo: "acme/app", commit: MERGE, sourceDigest: DIGEST }, RUNNING);
    const after = await traceability(f.db, f.owner.id, f.org.id, RUNNING);
    expect(after.requirements[0]).toMatchObject({ state: "delivered", delivered: true });
    expect(after.requirements[0]?.tasks[0]).toMatchObject({ id: child.id, status: "done" });
    // The server that can't say what it runs delivers nothing.
    expect((await traceability(f.db, f.owner.id, f.org.id, null)).requirements[0]?.delivered).toBe(false);
  });
});
