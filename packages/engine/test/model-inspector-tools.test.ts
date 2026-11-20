import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createAgentRuns, insertMessage, type ToolContext } from "../src";
import type { ModelInspectorReport } from "../src/model-inspector";
import { createModelInspectorToolSource, MODEL_INSPECTOR_TOOL } from "../src/model-inspector-tools";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function fixture() {
  const current = await setup();
  f = current;
  await current.db
    .update(schema.agents)
    .set({ handle: "model-inspector" })
    .where(eq(schema.agents.id, current.agent.id));
  const reads: string[] = [];
  let report: ModelInspectorReport | null = null;
  const source = createModelInspectorToolSource({
    enabled: (orgId) => orgId === current.org.id,
    report: async (orgId) => {
      reads.push(orgId);
      return report;
    },
  });
  const context = async (userId = current.owner.id, background = false): Promise<ToolContext> => {
    const message = await insertMessage(current.db, {
      orgId: current.org.id,
      channelId: current.general.id,
      author: { type: "person", userId },
      body: "Show the model inspection status.",
    });
    const [run] = await current.db.transaction((tx) =>
      createAgentRuns(tx, message, [current.agent.id], "mention", { background }),
    );
    if (!run) throw new Error("fixture run was not created");
    return {
      db: current.db,
      orgId: current.org.id,
      agentId: current.agent.id,
      runId: run.id,
      channelId: current.general.id,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
    };
  };
  return {
    ...current,
    reads,
    source,
    context,
    setReport: (value: ModelInspectorReport) => {
      report = value;
    },
  };
}

test("the configured inspector can read status for its authorized caller; an absent report is not invented usage", async () => {
  const t = await fixture();
  const ctx = await t.context();
  const tools = await t.source.tools(ctx);
  expect(tools.map((tool) => tool.name)).toEqual([MODEL_INSPECTOR_TOOL]);
  expect(t.reads).toEqual([]);
  const tool = tools[0];
  if (!tool) throw new Error("inspector tool was not listed");
  const out = await tool.execute({}, ctx);
  expect(out.data).toEqual({ enabled: true, report: null });
  expect(out.content).toContain("no inspection report is available");
  expect(out.content).not.toContain("0%");
  expect(t.reads).toEqual([t.org.id]);
});

test("the tool is absent from other agents and workspaces, even when the person is an owner", async () => {
  const t = await fixture();
  const ctx = await t.context();
  expect(await t.source.tools({ ...ctx, orgId: crypto.randomUUID() })).toEqual([]);
  await t.db.update(schema.agents).set({ handle: "another-agent" }).where(eq(schema.agents.id, t.agent.id));
  expect(await t.source.tools(ctx)).toEqual([]);
  expect(t.reads).toEqual([]);
});

test("status preserves unknown quota, observation time and the actual decision without rewriting them", async () => {
  const t = await fixture();
  const report: ModelInspectorReport = {
    orgId: t.org.id,
    checkedAt: "2026-11-20T08:00:00.000Z",
    mode: "snapshot",
    lastSweepAt: null,
    stale: true,
    policy: { thresholdPercent: 95, maxAgeMs: 300_000, cooldownMs: 900_000, maxSwitches: 4, intervalMs: 60_000 },
    agents: [
      {
        id: t.agent.id,
        name: "Model Inspector",
        brain: "grok",
        model: "grok-4.7",
        state: "unknown",
        usedPercent: null,
        observedAt: null,
        resetsAt: null,
        pool: "grok:machine:account",
        activeRunIds: [],
        activeMissionIds: [],
        activeTaskIds: [],
        activeWork: [],
        routineIds: [],
        decision: "kept",
        reason: "No quota observation is available.",
      },
    ],
    counts: { inspected: 1, switched: 0, boundary: 0, blocked: 0, unknown: 1 },
  };
  t.setReport(report);
  const ctx = await t.context();
  const [tool] = await t.source.tools(ctx);
  if (!tool) throw new Error("inspector tool was not listed");
  const output = await tool.execute({}, ctx);
  expect(JSON.parse(output.content)).toEqual({ enabled: true, report });
  expect(output.data).toEqual({ enabled: true, report });
});

test("a member and an unattended run cannot borrow the inspector owner's access", async () => {
  const t = await fixture();
  const member = await addMember(t.db, t.org.id, "member", "Reader");
  expect(await t.source.tools(await t.context(member.id))).toEqual([]);
  const ctx = await t.context();
  expect(await t.source.tools({ ...ctx, runId: "", triggerMessageId: "" })).toEqual([]);
  expect(t.reads).toEqual([]);
});

test("a previously listed status tool rechecks revocation before reading the report", async () => {
  const t = await fixture();
  const ctx = await t.context();
  const [tool] = await t.source.tools(ctx);
  if (!tool) throw new Error("inspector tool was not listed");
  await t.db
    .update(schema.organizationMembers)
    .set({ role: "member" })
    .where(and(eq(schema.organizationMembers.orgId, t.org.id), eq(schema.organizationMembers.userId, t.owner.id)));
  await expect(tool.execute({}, ctx)).rejects.toThrow(/authorized person/);
  expect(t.reads).toEqual([]);
});
