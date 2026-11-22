import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { and, type Database, desc, eq, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  askAgentToImplement,
  createAgent,
  createIssue,
  getIssue,
  grantScopes,
  NEW_AGENT_DEFAULTS,
  postPersonMessage,
  setAgentAudience,
  setCriterion,
  setIssueAudience,
  updateIssue,
} from "../src";
import {
  applyIssueDelivery,
  deliveryAllowsDone,
  issueDeliveryBrief,
  missionDeliveryReadiness,
} from "../src/issue-delivery";
import { issueWorkBrief } from "../src/issue-work";
import { acceptDelivery, completeMission } from "../src/mission-delivery";
import type { ToolContext } from "../src/tools/types";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);
let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const owner = () => ({ type: "person" as const, userId: f.owner.id });
const revisionA = "a".repeat(40);
const revisionB = "b".repeat(40);
const submitted = (revision = revisionA) => ({
  action: "submit",
  revision,
  preview: "http://localhost:4173/preview",
  paths: ["/workspace/preview/manifest-v1.json", "/workspace/preview/preview.html"],
  checks: ["Empty, draft and submitted actions verified; submitted is not accepted"],
  summary: "Implemented the reviewable local preview.",
});
const row = async (id: string) => (await f.db.select().from(schema.issues).where(eq(schema.issues.id, id)))[0]!;
const events = (id: string, event: string) =>
  f.db
    .select()
    .from(schema.issueActivity)
    .where(and(eq(schema.issueActivity.issueId, id), eq(schema.issueActivity.event, event)))
    .orderBy(desc(schema.issueActivity.id));
const ctx = (r: typeof schema.agentRuns.$inferSelect): ToolContext => ({
  db: f.db,
  orgId: r.orgId,
  agentId: r.agentId,
  runId: r.id,
  channelId: r.channelId,
  threadRootId: r.threadRootId,
  triggerMessageId: r.triggerMessageId,
});
async function taskRun(id: string, agentId: string) {
  const [r] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.issueId, id), eq(schema.agentRuns.agentId, agentId)))
    .orderBy(desc(schema.agentRuns.createdAt))
    .limit(1);
  if (!r) throw new Error("Expected a real queued task run");
  return ctx(r);
}

async function prepare(bindMission = false, privateTasks = false) {
  f = await setup({ issueTools: true });
  const implAgent = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Builder", handle: "builder" },
    NEW_AGENT_DEFAULTS,
  );
  const qaAgent = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Independent QA", handle: "qa" },
    NEW_AGENT_DEFAULTS,
  );
  for (const agent of [implAgent, qaAgent])
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: agent.id });
  const parent = await createIssue(deps(), owner(), f.org.id, {
    title: "Preview delivery",
    criteria: ["Owner reviewed product"],
    assignee: { type: "agent", id: f.agent.id },
    channelId: f.general.id,
    ...(privateTasks ? { audience: { mode: "people" as const, userIds: [f.owner.id] } } : {}),
  });
  const implementation = await createIssue(deps(), owner(), f.org.id, {
    title: "Existing implementation",
    criteria: ["Preview works", "Artifacts checked"],
    parentIssueId: parent.id,
    assignee: { type: "agent", id: implAgent.id },
    channelId: f.general.id,
    ...(privateTasks ? { audience: { mode: "people" as const, userIds: [f.owner.id] } } : {}),
  });
  const qa = await createIssue(deps(), owner(), f.org.id, {
    title: "Existing independent QA",
    criteria: ["Functional and accessibility checks"],
    parentIssueId: parent.id,
    assignee: { type: "agent", id: qaAgent.id },
    channelId: f.general.id,
    ...(privateTasks ? { audience: { mode: "people" as const, userIds: [f.owner.id] } } : {}),
  });
  const message = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
    body: "@dev deliver this implementation and independent QA before my review.",
  });
  const [managerRun] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!managerRun) throw new Error("Manager run missing");
  const manager = ctx(managerRun);
  let mission: typeof schema.missions.$inferSelect | null = null;
  if (bindMission) {
    const [createdMission] = await f.db
      .insert(schema.missions)
      .values({
        orgId: f.org.id,
        threadRootId: manager.threadRootId,
        channelId: f.general.id,
        agentId: f.agent.id,
        ownerId: f.owner.id,
        mainSessionId: crypto.randomUUID(),
        title: "Product preview",
        goal: "Review the working product",
        executor: "agent",
        status: "active",
      })
      .returning();
    if (!createdMission) throw new Error("Mission fixture missing");
    mission = createdMission;
  }
  const configure = {
    action: "configure",
    implementation_issue: `#${implementation.number}`,
    review_issue: `#${qa.number}`,
  };
  await applyIssueDelivery(deps(), manager, parent.id, configure);
  await askAgentToImplement(deps(), f.owner.id, f.org.id, implementation.id, implAgent.id);
  const builder = await taskRun(implementation.id, implAgent.id);
  const submit = (revision = revisionA, extra: Record<string, unknown> = {}) =>
    applyIssueDelivery(deps(), builder, implementation.id, { ...submitted(revision), ...extra }, [1, 2]);
  const review = async (verdict: "passed" | "changes_requested" = "passed", extra: Record<string, unknown> = {}) => {
    const [receipt] = await events(implementation.id, "delivery_submitted");
    return applyIssueDelivery(
      deps(),
      await taskRun(qa.id, qaAgent.id),
      qa.id,
      {
        action: "review",
        revision: receipt?.data.revision,
        submission_id: receipt?.data.id,
        verdict,
        summary:
          verdict === "passed"
            ? "Independently exercised the actual preview and assets."
            : "The restricted-access action is broken.",
        evidence: [
          "/workspace/preview/qa/independent-report.json",
          "Keyboard, reduced-motion and restricted-access checks observed",
        ],
        ...extra,
      },
      verdict === "passed" ? [1] : [],
    );
  };
  return { parent, implementation, qa, implAgent, qaAgent, manager, builder, configure, submit, review, mission };
}

test("configuration and exact submission are idempotent; the existing QA task gets a real linked run", async () => {
  const p = await prepare();
  await applyIssueDelivery(deps(), p.manager, p.parent.id, p.configure);
  expect(await events(p.parent.id, "delivery_contract")).toHaveLength(1);
  await p.submit();
  const before = await f.db.select().from(schema.agentConsultations);
  expect(await row(p.implementation.id)).toMatchObject({ status: "in_review" });
  expect(await taskRun(p.qa.id, p.qaAgent.id)).toMatchObject({ agentId: p.qaAgent.id });
  await p.submit();
  expect(await events(p.implementation.id, "delivery_submitted")).toHaveLength(1);
  expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(before.length);
  expect(await f.db.select().from(schema.issues)).toHaveLength(3);
});

test("delivery handoff publishes only after its outer transaction commits", async () => {
  const p = await prepare();
  const original = f.db.transaction;
  let rootTransactionActive = false;
  let publishedInside = 0;
  let publishedAfter = 0;
  const publish = f.pubsub.publish.bind(f.pubsub);
  f.pubsub.publish = async (topic, payload) => {
    if (rootTransactionActive) publishedInside++;
    else publishedAfter++;
    await publish(topic, payload);
  };
  expect(
    Reflect.set(f.db, "transaction", async (...args: unknown[]) => {
      rootTransactionActive = true;
      try {
        return await Reflect.apply(original, f.db, args);
      } finally {
        rootTransactionActive = false;
      }
    }),
  ).toBe(true);
  try {
    await p.submit();
    expect(publishedInside).toBe(0);
    expect(publishedAfter).toBeGreaterThan(0);
    expect(await events(p.implementation.id, "delivery_submitted")).toHaveLength(1);
    expect(await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.issueId, p.qa.id))).toHaveLength(1);
  } finally {
    Reflect.set(f.db, "transaction", original);
  }
});

test("aborted delivery handoff does not publish phantom notifications or QA work", async () => {
  const p = await prepare();
  const original = f.db.transaction;
  const publish = f.pubsub.publish.bind(f.pubsub);
  const published: string[] = [];
  f.pubsub.publish = async (topic, payload) => {
    published.push(payload.type);
    await publish(topic, payload);
  };
  expect(
    Reflect.set(f.db, "transaction", async (callback: (tx: Database) => Promise<unknown>) =>
      Reflect.apply(original, f.db, [
        async (tx: Database) => {
          await callback(tx);
          throw new Error("forced outer delivery rollback");
        },
      ]),
    ),
  ).toBe(true);
  try {
    await expect(p.submit()).rejects.toThrow("forced outer delivery rollback");
    expect(published).toHaveLength(0);
    expect(await events(p.implementation.id, "delivery_submitted")).toHaveLength(0);
    expect(await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.issueId, p.qa.id))).toHaveLength(0);
  } finally {
    Reflect.set(f.db, "transaction", original);
  }
});

test("agent status and background completion cannot bypass the configured review gate", async () => {
  const p = await prepare();
  expect(await deliveryAllowsDone(f.db, f.org.id, p.implementation.id)).toBe(false);
  await expect(
    updateIssue(
      deps(),
      { type: "agent", agentId: p.implAgent.id, channelId: p.builder.channelId, runId: p.builder.runId },
      f.org.id,
      p.implementation.id,
      { status: "done" },
    ),
  ).rejects.toThrow("independent QA");
  await p.submit();
  await expect(
    updateIssue(
      deps(),
      { type: "agent", agentId: p.implAgent.id, channelId: p.builder.channelId, runId: p.builder.runId },
      f.org.id,
      p.implementation.id,
      { status: "done" },
    ),
  ).rejects.toThrow("independent QA");
});

test("submission requires actual references, immutable revision and checked criteria", async () => {
  const p = await prepare();
  await expect(applyIssueDelivery(deps(), p.builder, p.implementation.id, submitted())).rejects.toThrow(
    "checked acceptance criteria",
  );
  await expect(p.submit("main")).rejects.toThrow("full Git SHA");
  await expect(p.submit(revisionA, { paths: [] })).rejects.toThrow("artifact paths");
  await expect(p.submit(revisionA, { preview: "javascript:alert(1)" })).rejects.toThrow("http(s)");
  expect(await events(p.implementation.id, "delivery_submitted")).toHaveLength(0);
  expect((await row(p.implementation.id)).criteria.every((c) => !c.done)).toBe(true); // failed call rolls checks back
});

test("self-review and changed ownership are rejected before a new handoff", async () => {
  const p = await prepare();
  await p.submit();
  await expect(
    applyIssueDelivery(deps(), p.builder, p.qa.id, { action: "review", revision: revisionA }),
  ).rejects.toThrow("assigned agent");
  await updateIssue(deps(), owner(), f.org.id, p.qa.id, { assignee: { type: "agent", id: p.implAgent.id } });
  await expect(applyIssueDelivery(deps(), p.manager, p.parent.id, p.configure)).rejects.toThrow(
    "different named agent",
  );
  await expect(p.submit(revisionB)).rejects.toThrow("assigned agent");
});

test("stale revision or submission receipt cannot pass independent QA", async () => {
  const p = await prepare();
  await p.submit();
  const [old] = await events(p.implementation.id, "delivery_submitted");
  await p.submit(revisionB);
  await expect(p.review("passed", { revision: revisionA, submission_id: old!.data.id })).rejects.toThrow("stale");
  expect(await row(p.implementation.id)).toMatchObject({ status: "in_review" });
  expect(await events(p.implementation.id, "delivery_reviewed")).toHaveLength(0);
});

test("QA failure hands back scoped work once, and unchanged content can be retried explicitly", async () => {
  const p = await prepare();
  await p.submit();
  await p.review("changes_requested");
  expect(await row(p.implementation.id)).toMatchObject({ status: "in_progress" });
  const before = await f.db.select().from(schema.agentConsultations);
  await p.review("changes_requested");
  expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(before.length);
  await p.submit(revisionA, { retry_reason: "Preview access restored; recheck the identical snapshot." });
  expect(await events(p.implementation.id, "delivery_submitted")).toHaveLength(2);
  expect(await deliveryAllowsDone(f.db, f.org.id, p.implementation.id)).toBe(false);
});

test("QA pass finishes children and sends the manager a final packet; parent stays In review", async () => {
  const p = await prepare();
  await p.submit();
  await p.review();
  expect(await row(p.implementation.id)).toMatchObject({ status: "done" });
  expect(await row(p.qa.id)).toMatchObject({ status: "done" });
  expect(await row(p.parent.id)).toMatchObject({ status: "in_review" });
  expect(await taskRun(p.parent.id, f.agent.id)).toMatchObject({ agentId: f.agent.id });
  expect(await deliveryAllowsDone(f.db, f.org.id, p.parent.id)).toBe(false);
  const before = await f.db.select().from(schema.agentConsultations);
  await p.review();
  expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(before.length);
});

test("changing acceptance criteria invalidates a prior QA pass", async () => {
  const p = await prepare();
  await p.submit();
  await p.review();
  await updateIssue(deps(), owner(), f.org.id, p.implementation.id, { criteria: [{ text: "New requirement" }] });
  expect(await deliveryAllowsDone(f.db, f.org.id, p.implementation.id)).toBe(false);
});

test("Mission delivery blocks missing QA, returns to canonical main session, and owner acceptance closes parent", async () => {
  const p = await prepare(true);
  const mission = p.mission!;
  await expect(completeMission(f.missionDeps, mission, null, { summary: "Done" })).rejects.toThrow("independent QA");
  await p.submit();
  await p.review();
  expect((await missionDeliveryReadiness(f.db, f.org.id, mission.id))?.ready).toBe(true);
  expect((await row(p.parent.id)).conversationChannelId).toBeNull(); // no competing manager task thread
  const delivery = await completeMission(f.missionDeps, mission, null, {
    summary: "Review the actual Product preview product.",
  });
  expect(delivery.status).toBe("pending");
  expect(delivery.summary).toContain(revisionA);
  expect((await row(p.parent.id)).status).toBe("in_review");
  await acceptDelivery(f.missionDeps, f.owner.id, f.org.id, mission.id, delivery.id);
  expect((await row(p.parent.id)).status).toBe("done");
  expect((await f.db.select().from(schema.missions).where(eq(schema.missions.id, mission.id)))[0]?.status).toBe("done");
});

test("an earlier delivery card cannot accept a newer independently reviewed submission", async () => {
  const p = await prepare(true);
  await p.submit();
  await p.review();
  const old = await completeMission(f.missionDeps, p.mission!, null, { summary: "Review revision A." });
  await p.submit(revisionB);
  await expect(acceptDelivery(f.missionDeps, f.owner.id, f.org.id, p.mission!.id, old.id)).rejects.toThrow(
    "reviewed revision",
  );
  expect((await row(p.parent.id)).status).toBe("in_progress");
});

test("a canceled parent cannot be resurrected by accepting an earlier Mission card", async () => {
  const p = await prepare(true);
  await p.submit();
  await p.review();
  const delivery = await completeMission(f.missionDeps, p.mission!, null, { summary: "Review this product." });
  await updateIssue(deps(), owner(), f.org.id, p.parent.id, { status: "canceled" });
  await expect(acceptDelivery(f.missionDeps, f.owner.id, f.org.id, p.mission!.id, delivery.id)).rejects.toThrow(
    "reviewed revision",
  );
  expect((await row(p.parent.id)).status).toBe("canceled");
});

test("private tasks cannot be bound to a public canonical Mission", async () => {
  await expect(prepare(true, true)).rejects.toThrow("canonical Mission audience");
  expect(
    await f.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.event, "delivery_contract")),
  ).toHaveLength(0);
});

test("narrowing task access prevents a new card or acceptance from disclosing its evidence", async () => {
  const p = await prepare(true);
  await p.submit();
  await p.review();
  const delivery = await completeMission(f.missionDeps, p.mission!, null, { summary: "Public preview review." });
  for (const task of [p.parent, p.implementation, p.qa])
    await setIssueAudience(deps(), owner(), f.org.id, task.id, { mode: "people", userIds: [f.owner.id] });
  const readiness = await missionDeliveryReadiness(f.db, f.org.id, p.mission!.id);
  expect(readiness).toMatchObject({ ready: false });
  expect(readiness?.summary).not.toContain("localhost");
  await expect(completeMission(f.missionDeps, p.mission!, null, { summary: "Share again." })).rejects.toThrow(
    "no longer visible",
  );
  await expect(acceptDelivery(f.missionDeps, f.owner.id, f.org.id, p.mission!.id, delivery.id)).rejects.toThrow(
    "reviewed revision",
  );
});

test("unchecked independent QA invalidates a child's later Done transition", async () => {
  const p = await prepare();
  await p.submit();
  await p.review();
  await setCriterion(deps(), owner(), f.org.id, p.qa.id, p.qa.criteria[0]!.id, false);
  await updateIssue(deps(), owner(), f.org.id, p.implementation.id, { status: "in_progress" });
  await expect(
    updateIssue(
      deps(),
      { type: "agent", agentId: p.implAgent.id, channelId: p.builder.channelId, runId: p.builder.runId },
      f.org.id,
      p.implementation.id,
      { status: "done" },
    ),
  ).rejects.toThrow("independent QA");
  expect((await row(p.implementation.id)).status).toBe("in_progress");
});

test("receipts use statement time after locks, not an outer transaction's start time", async () => {
  const p = await prepare();
  await f.db.transaction(async (tx) => {
    await tx.execute(sql`select now()`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const before = new Date();
    const db = tx as unknown as Database;
    await applyIssueDelivery({ ...deps(), db }, { ...p.builder, db }, p.implementation.id, submitted(), [1, 2]);
    const [receipt] = await tx
      .select()
      .from(schema.issueActivity)
      .where(
        and(
          eq(schema.issueActivity.issueId, p.implementation.id),
          eq(schema.issueActivity.event, "delivery_submitted"),
        ),
      );
    expect(receipt!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

test("the actual update_issue schema and gateway expose delivery without a release approval", async () => {
  const p = await prepare();
  const scopes = ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope }));
  await grantScopes(f.db, f.org.id, f.agent.id, scopes);
  await grantScopes(f.db, f.org.id, p.implAgent.id, scopes);
  const configured = await f.tools!.invoke(p.manager, {
    toolUseId: crypto.randomUUID(),
    name: "update_issue",
    input: { issue: p.parent.id, delivery: p.configure },
  });
  expect(configured).toMatchObject({
    type: "result",
    output: { content: expect.stringContaining("already configured") },
  });
  const delivered = await f.tools!.invoke(p.builder, {
    toolUseId: crypto.randomUUID(),
    name: "update_issue",
    input: { issue: p.implementation.id, done_criteria: [1, 2], delivery: submitted() },
  });
  expect(delivered).toMatchObject({ type: "result", output: { content: expect.stringContaining("existing QA task") } });
  expect((await row(p.implementation.id)).status).toBe("in_review");
  expect(await f.db.select().from(schema.approvals)).toHaveLength(0);
});

test("a failed task-board publication cannot strand an accepted Mission", async () => {
  const p = await prepare(true);
  await p.submit();
  await p.review();
  const delivery = await completeMission(f.missionDeps, p.mission!, null, { summary: "Review the product." });
  const original = f.pubsub.publish.bind(f.pubsub);
  let rejected = false;
  const publish: typeof f.pubsub.publish = async (...args) => {
    const message = args[1] as { type?: string; event?: { type?: string } };
    if (message.type === "issue.updated" || message.event?.type === "issue.updated") {
      rejected = true;
      throw new Error("Test: task board temporarily unavailable");
    }
    return original(...args);
  };
  await acceptDelivery(
    { ...f.missionDeps, pubsub: { ...f.pubsub, publish } },
    f.owner.id,
    f.org.id,
    p.mission!.id,
    delivery.id,
  );
  expect(rejected).toBe(true);
  expect((await row(p.parent.id)).status).toBe("done");
  expect((await f.db.select().from(schema.missions).where(eq(schema.missions.id, p.mission!.id)))[0]?.status).toBe(
    "done",
  );
});

test("a public parent cannot reveal private child receipts through task tools or worker briefs", async () => {
  const p = await prepare(false, true);
  await p.submit();
  const before = await issueDeliveryBrief(f.db, f.org.id, p.parent.id);
  expect(before).toContain(revisionA);
  expect(before).toContain(submitted().paths[0]!);

  await setIssueAudience(deps(), owner(), f.org.id, p.parent.id, { mode: "everyone" });
  const reader = await addMember(f.db, f.org.id, "member", "public-reader");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: reader.id });
  expect((await getIssue(f.db, { type: "person", userId: reader.id }, f.org.id, { id: p.parent.id })).id).toBe(
    p.parent.id,
  );
  await expect(
    getIssue(f.db, { type: "person", userId: reader.id }, f.org.id, { id: p.implementation.id }),
  ).rejects.toThrow();
  await expect(getIssue(f.db, { type: "person", userId: reader.id }, f.org.id, { id: p.qa.id })).rejects.toThrow();

  await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "everyone", userIds: [] });
  // As in the audience fixtures, finish the setup turn so this person's mention starts their own run
  // instead of joining the manager's queued channel turn.
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, p.manager.runId));
  const message = await postPersonMessage(deps(), reader.id, f.org.id, f.general.id, {
    body: "@dev show the shared parent task.",
  });
  const [readerRun] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!readerRun) throw new Error("Public reader's delegated run missing");
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  const answer = await f.tools!.invoke(ctx(readerRun), {
    toolUseId: crypto.randomUUID(),
    name: "list_issues",
    input: { issue: p.parent.id },
  });
  if (answer.type !== "result") throw new Error("Expected the ordinary task detail result");
  const brief = await issueDeliveryBrief(f.db, f.org.id, p.parent.id);
  const work = await issueWorkBrief(f.db, f.org.id, p.parent.id);
  const [receipt] = await events(p.implementation.id, "delivery_submitted");
  for (const output of [brief, work ?? "", answer.output.content]) {
    expect(output).toContain("linked tasks' visibility changed");
    for (const secret of [
      p.implementation.id,
      p.qa.id,
      String(receipt?.data.id),
      revisionA,
      submitted().preview,
      ...submitted().paths,
    ])
      expect(output).not.toContain(secret);
  }

  // Sharing every linked task restores ordinary detail; the guard follows current visibility.
  for (const task of [p.implementation, p.qa])
    await setIssueAudience(deps(), owner(), f.org.id, task.id, { mode: "everyone" });
  expect(await issueDeliveryBrief(f.db, f.org.id, p.parent.id)).toContain(revisionA);
});

test("a missing linked task hides receipt details from the delivery and worker briefs", async () => {
  const p = await prepare();
  await p.submit();
  await f.db.delete(schema.issues).where(eq(schema.issues.id, p.qa.id));
  for (const output of [
    await issueDeliveryBrief(f.db, f.org.id, p.parent.id),
    (await issueWorkBrief(f.db, f.org.id, p.parent.id)) ?? "",
  ]) {
    expect(output).toContain("a task is missing");
    for (const secret of [p.implementation.id, p.qa.id, revisionA, submitted().preview, ...submitted().paths])
      expect(output).not.toContain(secret);
  }
});

function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function postgresPid(db: Database) {
  const result = (await db.execute(sql`select pg_backend_pid() as pid`)) as unknown as { pid: number }[];
  if (!result[0]) throw new Error("PostgreSQL connection missing");
  return result[0].pid;
}

/** Observe real database contention; a timer alone cannot prove that the contender reached a lock. */
async function waitForLockWaiters(holder: number, count: number, completed: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = (await f.db.execute(sql`select count(*)::integer as count,
      coalesce(bool_or(${holder} = any(pg_blocking_pids(pid))), false) as held
      from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`)) as unknown as {
      count: number;
      held: boolean;
    }[];
    if (rows[0]?.held && rows[0].count >= count) return;
    if (completed()) throw new Error("A contender finished before the required PostgreSQL row lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The PostgreSQL contenders never reached the expected row locks");
}

test.skipIf(!process.env.TEST_DATABASE_URL)(
  "PostgreSQL: reversed transaction starts retain the last committed submission for independent QA",
  async () => {
    const p = await prepare();
    const started = signal<number>();
    const release = signal();
    const earlier = f.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      started.resolve(await postgresPid(db)); // fixes this transaction's now() before the other one starts
      await release.promise;
      await applyIssueDelivery(
        { ...deps(), db },
        { ...p.builder, db },
        p.implementation.id,
        submitted(revisionB),
        [1, 2],
      );
    });
    try {
      const earlierPid = await Promise.race([
        started.promise,
        earlier.then(() => {
          throw new Error("Earlier transaction ended before its barrier");
        }),
      ]);
      const laterPid = await f.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const pid = await postgresPid(db);
        await applyIssueDelivery(
          { ...deps(), db },
          { ...p.builder, db },
          p.implementation.id,
          submitted(revisionA),
          [1, 2],
        );
        return pid;
      });
      expect(laterPid).not.toBe(earlierPid);
      release.resolve();
      await earlier;
      const receipts = await f.db
        .select()
        .from(schema.issueActivity)
        .where(
          and(
            eq(schema.issueActivity.issueId, p.implementation.id),
            eq(schema.issueActivity.event, "delivery_submitted"),
          ),
        )
        .orderBy(desc(schema.issueActivity.createdAt), desc(schema.issueActivity.id));
      expect(receipts.map((receipt) => receipt.data.revision)).toEqual([revisionB, revisionA]);
      await p.review("passed", { revision: revisionB }); // production latest() must select B, not the later-start transaction
      expect(await deliveryAllowsDone(f.db, f.org.id, p.implementation.id)).toBe(true);
      expect((await row(p.parent.id)).status).toBe("in_review");
    } finally {
      release.resolve();
      await Promise.allSettled([earlier]);
    }
  },
);

test.skipIf(!process.env.TEST_DATABASE_URL)(
  "PostgreSQL: concurrent identical submissions commit one receipt and one independent QA handoff",
  async () => {
    const p = await prepare();
    const before = (await f.db.select().from(schema.agentConsultations)).length;
    const locked = signal<number>();
    const release = signal();
    const holder = f.db.transaction(async (tx) => {
      await tx.select().from(schema.issues).where(eq(schema.issues.id, p.implementation.id)).for("update");
      locked.resolve(await postgresPid(tx as unknown as Database));
      await release.promise;
    });
    let contenders: Promise<PromiseSettledResult<string>[]> | undefined;
    let completed = 0;
    try {
      const pid = await Promise.race([
        locked.promise,
        holder.then(() => {
          throw new Error("Holder ended before acquiring its row");
        }),
      ]);
      contenders = Promise.allSettled([p.submit().finally(() => completed++), p.submit().finally(() => completed++)]);
      await waitForLockWaiters(pid, 2, () => completed > 0);
      release.resolve();
      const results = await contenders;
      await holder;
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await events(p.implementation.id, "delivery_submitted")).toHaveLength(1);
      expect(await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.issueId, p.qa.id))).toHaveLength(1);
      expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(before + 1);
      expect((await row(p.implementation.id)).status).toBe("in_review");
      expect(await f.db.select().from(schema.issues)).toHaveLength(3);
    } finally {
      release.resolve();
      await Promise.allSettled([holder, ...(contenders ? [contenders] : [])]);
    }
  },
);

for (const first of ["configure", "accept"] as const) {
  test.skipIf(!process.env.TEST_DATABASE_URL)(
    `PostgreSQL: ${first} wins the Mission binding-set lock without closing unreviewed work`,
    async () => {
      const p = await prepare(true);
      await p.submit();
      await p.review();
      const mission = p.mission!;
      const card = await completeMission(f.missionDeps, mission, null, { summary: "Review the existing product." });
      const parent = await createIssue(deps(), owner(), f.org.id, {
        title: "Additional existing work package",
        criteria: ["Owner reviewed the additional package"],
        assignee: { type: "agent", id: f.agent.id },
        channelId: f.general.id,
      });
      const implementation = await createIssue(deps(), owner(), f.org.id, {
        title: "Additional existing implementation",
        criteria: ["Additional artifacts verified"],
        parentIssueId: parent.id,
        assignee: { type: "agent", id: p.implAgent.id },
        channelId: f.general.id,
      });
      const qa = await createIssue(deps(), owner(), f.org.id, {
        title: "Additional existing independent QA",
        criteria: ["Additional preview independently checked"],
        parentIssueId: parent.id,
        assignee: { type: "agent", id: p.qaAgent.id },
        channelId: f.general.id,
      });
      const configure = (db: Database) =>
        applyIssueDelivery({ ...deps(), db }, { ...p.manager, db }, parent.id, {
          action: "configure",
          implementation_issue: implementation.id,
          review_issue: qa.id,
        });
      const accept = (db: Database) =>
        acceptDelivery({ ...f.missionDeps, db }, f.owner.id, f.org.id, mission.id, card.id);
      const locked = signal<number>();
      const release = signal();
      const winner = f.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        await (first === "configure" ? configure(db) : accept(db));
        locked.resolve(await postgresPid(db));
        await release.promise; // retain the actual operation's locks until the other operation demonstrably waits
      });
      let contender: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let completed = false;
      try {
        const pid = await Promise.race([
          locked.promise,
          winner.then(() => {
            throw new Error("Winning transaction ended before its barrier");
          }),
        ]);
        contender = Promise.allSettled([
          (first === "configure" ? accept(f.db) : configure(f.db)).finally(() => {
            completed = true;
          }),
        ]);
        await waitForLockWaiters(pid, 1, () => completed);
        release.resolve();
        await winner;
        const [outcome] = await contender;
        expect(outcome?.status).toBe("rejected");
        if (outcome?.status !== "rejected") throw new Error("Competing delivery operation unexpectedly succeeded");
        expect(String(outcome.reason)).toContain(first === "configure" ? "reviewed revision" : "not open");
        const [savedCard] = await f.db
          .select()
          .from(schema.missionDeliveries)
          .where(eq(schema.missionDeliveries.id, card.id));
        const [savedMission] = await f.db.select().from(schema.missions).where(eq(schema.missions.id, mission.id));
        expect(savedCard?.status).toBe(first === "configure" ? "pending" : "accepted");
        expect(savedMission?.status).toBe(first === "configure" ? "awaiting_close" : "done");
        expect((await row(p.parent.id)).status).toBe(first === "configure" ? "in_review" : "done");
        for (const task of [parent, implementation, qa])
          expect(await events(task.id, "delivery_contract")).toHaveLength(first === "configure" ? 1 : 0);
        expect(await events(implementation.id, "delivery_submitted")).toHaveLength(0);
        expect((await row(parent.id)).status).toBe("todo");
        expect(await f.db.select().from(schema.issues)).toHaveLength(6);
      } finally {
        release.resolve();
        await Promise.allSettled([winner, ...(contender ? [contender] : [])]);
      }
    },
  );
}
