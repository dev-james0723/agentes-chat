import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { createFakeProvider } from "@agenteschat/providers/testing";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  createCredential,
  createJobHandlers,
  createModelGateway,
  createQuotaCliQualifier,
  drainOutbox,
  type MachineStatus,
  postPersonMessage,
  rotateCredential,
} from "../src";
import {
  createCreditRouteQualifier,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
} from "../src/credit-ledger";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  clearPlanLimits();
  await f?.close();
  f = undefined as unknown as Fixture;
});

const MODEL = "claude-sonnet-5-5";
const KEY = "sk-ant-synthetic-credit-executor";
const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

type Script = (n: number) => BrainEvent[];
const LIMIT: BrainEvent = {
  type: "error",
  code: "plan_limit",
  message: "synthetic limit",
  retryable: true,
  worked: false,
};

/** A Claude Code stand-in: its limit, or its answer, per turn. */
function claudeCode(script: Script) {
  const turns: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      turns.push(turn);
      yield* script(turns.length - 1);
    },
  };
  return { brain, turns };
}

interface Options {
  /** The route is registered and switched on (default), registered but off, or not registered at all. */
  route?: "on" | "off" | "none";
  provider?: Parameters<typeof createFakeProvider>[0];
  script?: Script;
  codexTarget?: boolean;
  /** Runs after the route qualified and before its first call. */
  afterQualify?: () => Promise<void>;
  creditOff?: boolean;
}

async function fixture(o: Options = {}) {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, { name: "MacBook", ...RUNNER, exec: true });
  const machineId = paired.machineId;
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainExtraUsage: false, brainFallback: true })
    .where(eq(schema.agents.id, f.agent.id));
  let credentialId = "";
  let poolId = "";
  if (o.route !== "none") {
    const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "anthropic",
      label: "credits",
      apiKey: KEY,
    });
    credentialId = credential.id;
    poolId = await registerCreditPool(f.db, f.org.id, {
      upstreamAccount: "console-org-fixture",
      enforcement: "prepaid_grant_only",
      evidenceRef: "fixture-evidence",
      verifiedAt: new Date(Date.now() - 3_600_000),
      validUntil: new Date(Date.now() + 24 * 3_600_000),
      allocationNanoUsd: 50_000_000_000,
    });
    const routeId = await registerCreditRoute(f.db, f.org.id, {
      poolId,
      credentialId,
      model: MODEL,
      supportsTools: true,
      maxPromptBytes: 400_000,
    });
    if (o.route !== "off") await setCreditRouteEnabled(f.db, f.org.id, routeId, true);
  }
  const provider = createFakeProvider(o.provider);
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: { anthropic: provider },
    creditRoutes: true,
  });
  const source = claudeCode(o.script ?? (() => [LIMIT]));
  const target: { turns: BrainTurn[] } = { turns: [] };
  const codex: Brain = {
    kind: "codex",
    async *run(turn) {
      target.turns.push(turn);
      yield { type: "done", text: "Codex continued." };
    },
  };
  if (o.codexTarget) {
    const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
    await f.db
      .update(schema.machines)
      .set({
        executors: {
          ...machine?.executors,
          ownUsage: {
            codex: {
              source: "probe",
              at: new Date().toISOString(),
              windows: [
                { kind: "seven_day", usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
              ],
            },
          },
        },
      })
      .where(eq(schema.machines.id, machineId));
  }
  const status = () =>
    statusOf(machineId, {
      pairedByUserId: f.owner.id,
      executors: {
        claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "ultra" },
        codex: { version: "0.163.0" },
        detectedAt: new Date().toISOString(),
        ...(o.codexTarget ? { ownUsage: { codex: { windows: [{ kind: "seven_day", usedPercent: 10 }] } } } : {}),
      } as MachineStatus["executors"],
    });
  const machines = { status: async () => status() };
  const base = createCreditRouteQualifier(f.db);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    gateway,
    brains: { claude_code: () => source.brain, codex: () => codex },
    machines,
    ...(o.creditOff
      ? {}
      : {
          creditRoute: {
            async qualify(input: Parameters<typeof base.qualify>[0]) {
              const q = await base.qualify(input);
              if (q.ok) await o.afterQualify?.();
              return q;
            },
          },
        }),
    quotaCliContinuation: o.codexTarget
      ? createQuotaCliQualifier({ db: f.db, machines, models: { codex: "gpt-6.1-sol" }, targets: ["codex"] })
      : { qualify: async () => null },
  } as Parameters<typeof createJobHandlers>[0]);
  return { handlers, provider, source, target, credentialId, poolId, machineId };
}

const runOf = async () => {
  const [run] = await f.db.select().from(schema.agentRuns);
  return run;
};
const stepsOf = async (runId: string) =>
  (await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId))).map(
    (s) => s.data as Record<string, unknown>,
  );
const poolOf = async () => (await f.db.select().from(schema.creditPools))[0];
const attempts = () => f.db.select().from(schema.creditAttempts);

test("the subscription answers: no credit route is looked at, no API call, nothing held", async () => {
  const x = await fixture({ script: () => [{ type: "done", text: "Claude kept working." }] });
  await post("@dev hello");
  await drainOutbox(f.db, x.handlers);
  const run = await runOf();
  expect(run?.status).toBe("done");
  expect(run?.brain).toBe("claude_code");
  expect(x.provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
}, 60_000);

test("the subscription's limit with a verified route continues the same run on the Claude API, once, with a notice", async () => {
  const x = await fixture();
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  const run = await runOf();
  expect(run?.status).toBe("done");
  expect(run?.brain).toBe("model");
  expect(run?.transcript).toMatchObject({
    creditRoute: { schema: "credit-route/1", model: MODEL, sourceKind: "claude_code" },
  });
  expect(x.source.turns).toHaveLength(1);
  // The call ran on the route's own key and model, and its cost is held against the pool then settled.
  expect(x.provider.calls).toHaveLength(1);
  expect(x.provider.calls[0]?.apiKey).toBe(KEY);
  expect(x.provider.calls[0]?.request.model).toBe(MODEL);
  const pool = await poolOf();
  expect(pool?.heldNanoUsd).toBe(0);
  expect(pool?.spentNanoUsd).toBeGreaterThan(0);
  expect((await attempts())[0]?.state).toBe("settled");
  const steps = await stepsOf(run?.id ?? "");
  expect(steps.some((s) => JSON.stringify(s).includes('"state":"selected"'))).toBe(true);
  const notes = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta as { creditRoute?: unknown })?.creditRoute,
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]?.body).not.toContain(KEY);
  // No key is in anything the run keeps.
  expect(JSON.stringify(run?.transcript)).not.toContain("sk-ant");
}, 60_000);

test("a route that is off, or none, leaves the existing policy: no paid model, the run waits", async () => {
  for (const route of ["off", "none"] as const) {
    const x = await fixture({ route });
    await post("@dev keep going");
    await drainOutbox(f.db, x.handlers);
    const run = await runOf();
    expect(run?.brain).not.toBe("model");
    expect(run?.status).not.toBe("done");
    expect(x.provider.calls).toHaveLength(0);
    await f.close();
    f = undefined as unknown as Fixture;
    clearPlanLimits();
  }
}, 120_000);

test("a server with credit routes off behaves as before even with a route registered", async () => {
  const x = await fixture({ creditOff: true });
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  const run = await runOf();
  expect(run?.brain).not.toBe("model");
  expect(x.provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
}, 60_000);

test("an empty grant at the provider sends the run back to the subscription's choices, with nothing repeated", async () => {
  const x = await fixture({
    provider: () => new ProviderError("Your credit balance is too low to access the API", false, 400),
  });
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  const run = await runOf();
  // One call was tried, refused and its hold returned; the pool is exhausted; the run waits for its plan.
  expect(x.provider.calls).toHaveLength(1);
  const pool = await poolOf();
  expect([pool?.status, pool?.heldNanoUsd]).toEqual(["exhausted", 0]);
  expect(run?.brain).toBe("claude_code");
  expect(run?.status).not.toBe("done");
  expect(run?.status).not.toBe("failed");
  expect(run?.transcript).toMatchObject({ creditRoute: { ended: "exhausted" } });
  // Later wakes do not come back to the exhausted route in this run.
  for (let i = 1; i <= 2; i++) await drainOutbox(f.db, x.handlers, { now: new Date(Date.now() + i * 90 * 60_000) });
  expect(x.provider.calls).toHaveLength(1);
}, 90_000);

test("an empty grant moves the run to another subscription when one qualifies", async () => {
  const x = await fixture({
    codexTarget: true,
    provider: () => new ProviderError("Your credit balance is too low to access the API", false, 400),
  });
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  const run = await runOf();
  expect(x.provider.calls).toHaveLength(1);
  expect(run?.status).toBe("done");
  expect(run?.brain).toBe("codex");
  expect(x.target.turns).toHaveLength(1);
}, 90_000);

test("a call whose outcome is unknown is never sent again: its hold stays and the run stops with a reason", async () => {
  const x = await fixture({ provider: () => new ProviderError("upstream broke", true, 500) });
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  for (let i = 1; i <= 3; i++) await drainOutbox(f.db, x.handlers, { now: new Date(Date.now() + i * 10 * 60_000) });
  const run = await runOf();
  expect(run?.status).toBe("failed");
  expect(x.provider.calls).toHaveLength(1);
  const [attempt] = await attempts();
  expect(attempt?.state).toBe("unknown");
  expect((await poolOf())?.heldNanoUsd).toBeGreaterThan(0);
  const steps = await stepsOf(run?.id ?? "");
  expect(steps.some((s) => s.reason === "credit_reconciliation_required")).toBe(true);
}, 90_000);

test("a credential rotated after the route qualified is refused before anything is sent", async () => {
  let rotated = false;
  const x = await fixture({
    afterQualify: async () => {
      if (rotated) return;
      rotated = true;
      const [row] = await f.db.select().from(schema.creditRoutes);
      await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, row?.credentialId ?? "", {
        apiKey: "sk-ant-synthetic-rotated",
      });
    },
  });
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  expect(x.provider.calls).toHaveLength(0);
  const run = await runOf();
  expect(run?.brain).toBe("claude_code");
  expect(run?.status).not.toBe("done");
  expect(await attempts()).toHaveLength(0);
}, 90_000);

test("a turn cut after tools already ran never moves to the API", async () => {
  const x = await fixture({
    script: () => [
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" }, executed: { content: "ok" } },
      { type: "error", code: "plan_limit", message: "synthetic limit", retryable: true, worked: true },
    ],
  });
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  expect(x.provider.calls).toHaveLength(0);
  const run = await runOf();
  expect(run?.brain).not.toBe("model");
  expect(run?.status).not.toBe("done");
}, 60_000);

test("a usage warning is not exhaustion: near the limit the run keeps working on its subscription and spends no credit", async () => {
  const x = await fixture({ script: () => [{ type: "done", text: "Claude kept working." }] });
  const at = new Date().toISOString();
  const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, x.machineId));
  await f.db
    .update(schema.machines)
    .set({
      executors: {
        ...machine?.executors,
        ownUsage: {
          claude_code: {
            source: "probe",
            at,
            windows: [{ kind: "seven_day", usedPercent: 94, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
          },
        },
      },
    })
    .where(eq(schema.machines.id, x.machineId));
  await post("@dev keep going");
  await drainOutbox(f.db, x.handlers);
  const run = await runOf();
  expect(run?.status).toBe("done");
  expect(run?.brain).toBe("claude_code");
  expect(x.provider.calls).toHaveLength(0);
  expect(await attempts()).toHaveLength(0);
}, 60_000);

test("the subscription back later: a new message runs on it again, and the route is not touched", async () => {
  const x = await fixture({ script: (n) => (n === 0 ? [LIMIT] : [{ type: "done", text: "Claude is back." }]) });
  await post("@dev first");
  await drainOutbox(f.db, x.handlers);
  expect((await runOf())?.brain).toBe("model");
  const callsAfterFirst = x.provider.calls.length;
  await post("@dev second");
  await drainOutbox(f.db, x.handlers);
  const runs = await f.db.select().from(schema.agentRuns);
  expect(runs).toHaveLength(2);
  expect(runs.filter((r) => r.brain === "claude_code")).toHaveLength(1);
  expect(x.provider.calls).toHaveLength(callsAfterFirst);
}, 90_000);

test("a key reserved for a credit route is refused when an agent uses it as its own", async () => {
  const x = await fixture({ script: () => [{ type: "done", text: "ok" }] });
  await f.db
    .update(schema.agents)
    .set({ brain: "model", credentialId: x.credentialId, model: MODEL })
    .where(eq(schema.agents.id, f.agent.id));
  await post("@dev hello");
  await drainOutbox(f.db, x.handlers);
  expect(x.provider.calls).toHaveLength(0);
  expect((await runOf())?.status).not.toBe("done");
}, 60_000);
