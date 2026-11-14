import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  clearPlanLimits,
  createJobHandlers,
  decideApproval,
  drainOutbox,
  executeToolForRun,
  grantScopes,
  listApprovals,
  type MachineStatus,
  postPersonMessage,
} from "../../../../packages/engine/src";
import { type Fixture, setup } from "../../../../packages/engine/test/fixtures";
import { pairMachine } from "../../../../packages/engine/test/machine-fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "../../../../packages/engine/test/tool-fixtures";
import { ClaudeStreamParser } from "../../runner/brain";

let fixture: Fixture;
afterEach(() => {
  clearPlanLimits();
  return fixture?.close();
});
const statusOf = (id: string): MachineStatus => ({
  id,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

test.each(["done", "error"] as const)(
  "Claude parser bridge approval with %s resumes after decision",
  async (ending) => {
    const gh = fakeGithub();
    fixture = await setup({ toolSources: [gh.source], reply: () => ({ chunks: ["fallback"] }) });
    await grantScopes(fixture.db, fixture.org.id, fixture.agent.id, ALL_GITHUB_SCOPES);
    const paired = await pairMachine(
      { db: fixture.db, pubsub: fixture.pubsub },
      fixture.owner.id,
      fixture.org.id,
      {
        name: "MacBook",
        hostname: "mac",
        os: "darwin",
        arch: "arm64",
        version: "0.8.0",
        protocol: MACHINE_PROTOCOL_VERSION,
        workspace: "/Users/w/agentes",
        exec: true,
      },
    );
    await fixture.db
      .update(schema.agents)
      .set({ machineId: paired.machineId, brain: "claude_code" })
      .where(eq(schema.agents.id, fixture.agent.id));
    let attempts = 0;
    const brain: Brain = {
      kind: "claude_code",
      async *run(turn) {
        attempts++;
        if (attempts > 1) {
          yield { type: "done", text: "merged" };
          return;
        }
        const input = {
          repo: "acme/app",
          pr: 42,
          why: "CI passed on the PR and it was reviewed: merging ships the fix.",
        };
        const parser = new ClaudeStreamParser();
        parser.beginTurn();
        const start = parser.push(
          JSON.stringify({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
              content: [{ type: "tool_use", id: "toolu_native", name: "mcp__agentes__github_merge_pr", input }],
            },
          }),
        );
        yield* start.events;
        // Mcp relay creates its own independent random call ID; it is not the Claude tool_use ID.
        const result = await executeToolForRun(
          fixture.jobDeps,
          { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId: paired.machineId },
          { id: "relay_independent", name: "github_merge_pr", input },
        );
        const parsed = parser.push(
          JSON.stringify({
            type: "user",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_result", tool_use_id: "toolu_native", content: result.content }] },
          }),
        );
        expect(parsed.events).toEqual([
          {
            type: "tool_call",
            id: "toolu_native",
            name: "github_merge_pr",
            input,
            executed: { content: result.content },
          },
        ]);
        yield* parsed.events;
        if (ending === "done") yield { type: "done", text: "waiting for approval" };
        else yield { type: "error", code: "executor_crashed", message: "connection lost", retryable: true };
      },
    };
    const handlers = createJobHandlers({
      ...fixture.jobDeps,
      brains: { claude_code: () => brain },
      machines: { status: async (id) => statusOf(id) },
    });
    await postPersonMessage(
      { db: fixture.db, pubsub: fixture.pubsub },
      fixture.owner.id,
      fixture.org.id,
      fixture.general.id,
      { body: "@dev merge the PR" },
    );
    await drainOutbox(fixture.db, handlers);
    const [run] = await fixture.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("waiting_approval");
    expect((run?.transcript as { effectUncertain?: unknown } | null)?.effectUncertain).toBeUndefined();
    const [approval] = await listApprovals(fixture.db, fixture.owner.id, fixture.org.id, { status: "pending" });
    if (!approval) throw new Error("expected pending approval");
    await decideApproval({ db: fixture.db, pubsub: fixture.pubsub }, fixture.owner.id, fixture.org.id, approval.id, {
      decision: "approve",
    });
    await drainOutbox(fixture.db, handlers);
    const [after] = await fixture.db.select().from(schema.agentRuns);
    expect(after?.status).toBe("done");
    expect(gh.executed).toEqual([{ tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }]);
  },
);
