import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  clearPlanLimits,
  createJobHandlers,
  drainOutbox,
  listMessages,
  type MachineStatus,
  postPersonMessage,
} from "@agenteschat/engine";
import { type Fixture, setup } from "../../../../packages/engine/test/fixtures";
import { pairMachine } from "../../../../packages/engine/test/machine-fixtures";
import { CodexThreads } from "../../runner/brain-codex";
import { runGrokTurn } from "../../runner/brain-grok";
import type { Spawn } from "../../runner/scope-gate";

let fixture: Fixture;
afterEach(() => {
  clearPlanLimits();
  return fixture?.close();
});

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

test.each(["ERRORLIMIT", "PENDINGLIMIT"] as const)(
  "real Grok adapter events reach executor: %s remains unknown",
  async (prompt) => {
    const root = mkdtempSync(path.join(tmpdir(), "grok-engine-integration-"));
    try {
      writeFileSync(path.join(root, "auth.json"), "{}");
      let fallbackCalls = 0;
      fixture = await setup({
        reply: () => {
          fallbackCalls++;
          return { chunks: ["fallback"] };
        },
      });
      const deps = { db: fixture.db, pubsub: fixture.pubsub, publicUrl: "https://agentes.chat" };
      const paired = await pairMachine(deps, fixture.owner.id, fixture.org.id, {
        name: "MacBook",
        hostname: "mac",
        os: "darwin",
        arch: "arm64",
        version: "0.8.0",
        protocol: MACHINE_PROTOCOL_VERSION,
        workspace: "/Users/w/agentes",
        exec: true,
      });
      await fixture.db
        .update(schema.agents)
        .set({ machineId: paired.machineId, brain: "claude_code" })
        .where(eq(schema.agents.id, fixture.agent.id));
      const emitted: BrainEvent[] = [];
      let attempts = 0;
      const fake = path.join(import.meta.dir, "fake-grok.mjs");
      const brain: Brain = {
        kind: "claude_code",
        async *run(turn) {
          attempts++;
          await runGrokTurn(
            {
              runId: turn.runId,
              sessionId: "0193cccc-0000-7000-8000-0000000000a1",
              cwd: root,
              account: { id: "0193eeee-0000-7000-8000-0000000000a1", home: root },
              system: "Test",
              prompt,
              mcp: { token: "synthetic" },
            },
            {
              chats: new CodexThreads(path.join(root, "chats.json")),
              signal: new AbortController().signal,
              emit: (event) => emitted.push(event as BrainEvent),
              spawn: ((_cmd, args, options) => spawn(process.execPath, [fake, ...args], options)) as Spawn,
            },
          );
          yield* emitted;
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
        { body: "@dev do the test write" },
      );
      await drainOutbox(fixture.db, handlers);
      expect(attempts).toBe(1);
      expect(emitted.some((e) => e.type === "tool_started")).toBe(true);
      expect(emitted.some((e) => e.type === "tool_call" && e.executed?.isError === true)).toBe(prompt === "ERRORLIMIT");
      expect(emitted.some((e) => e.type === "limit")).toBe(false);
      expect(fallbackCalls).toBe(0);
      const [run] = await fixture.db.select().from(schema.agentRuns);
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/outcome unknown|effect uncertain/);
      const last = (await listMessages(fixture.db, fixture.owner.id, fixture.org.id, fixture.general.id)).at(-1);
      expect(last?.meta.brainInterrupted).toMatchObject({ outcomeUnknown: true, tools: ["run_terminal_command"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
