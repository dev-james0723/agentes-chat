import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { getAgentBrain, openPersonAgentDm, postPersonMessage, resolveBrain, setAgentBrain } from "../src";
import { machineAgents } from "../src/machines";
import { personalBrain, RIGHT_HAND, thinkingAgent } from "../src/right-hand";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function world() {
  const fx = await setup({ rightHand: true });
  f = fx;
  const other = await addMember(fx.db, fx.org.id, "member", "other");
  const { machineId } = await pairMachine(fx, fx.owner.id, fx.org.id, {
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: true,
  });
  const usage = {
    source: "probe" as const,
    at: new Date().toISOString(),
    windows: [{ kind: "five_hour" as const, usedPercent: 4 }],
  };
  await fx.db
    .update(schema.machines)
    .set({
      online: true,
      lastSeenAt: new Date(),
      executors: {
        claude: { version: "2.1.318", loggedIn: true, authMethod: "claude.ai" },
        codex: { version: "0.170.0" },
        grok: { version: "1.0.70" },
        detectedAt: new Date().toISOString(),
        ownUsage: { codex: usage, claude_code: usage },
      },
    })
    .where(eq(schema.machines.id, machineId));
  const accountId = crypto.randomUUID();
  const otherAccountId = crypto.randomUUID();
  await fx.db.insert(schema.machineAccounts).values(
    [fx.owner.id, other.id].map((createdBy, i) => ({
      id: i ? otherAccountId : accountId,
      orgId: fx.org.id,
      machineId,
      kind: "grok",
      label: "Grok",
      status: "active",
      createdBy,
      shared: true,
      authMethod: "cli_login",
    })),
  );
  const [agent] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!agent) throw new Error("Missing right hand");
  const deps = { db: fx.db };
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, {
    scope: "mine",
    brain: "grok",
    account: accountId,
    model: "auto",
    effort: "high",
  });
  await setAgentBrain(deps, other.id, fx.org.id, agent.id, { scope: "mine", brain: "grok", account: otherAccountId });
  return { fx, deps, other, agent, machineId, accountId, otherAccountId };
}

const codeOf = (p: Promise<unknown>) => p.then(() => null).catch((e: { code?: string }) => e.code);

test("a personal named plan can move to its owner's explicit Codex sign-in and resolve a real run", async () => {
  const { fx, deps, other, agent, machineId, otherAccountId } = await world();
  const otherBefore = await personalBrain(fx.db, fx.org.id, other.id);
  const view = await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, {
    scope: "mine",
    brain: "codex",
    account: null,
    machineId,
    model: "auto",
    fallback: false,
    extraUsage: false,
  });
  expect(view).toMatchObject({
    scope: "mine",
    brain: "codex",
    account: null,
    computer: { machineId },
    ownSignIn: true,
    effort: "high",
    fallback: false,
    extraUsage: false,
  });
  expect(await personalBrain(fx.db, fx.org.id, fx.owner.id)).toMatchObject({
    brain: "codex",
    brainAccountId: null,
    machineId,
    brainEffort: "high",
    brainAccountLentBy: null,
  });
  expect(await personalBrain(fx.db, fx.org.id, other.id)).toEqual(otherBefore);
  const [unchanged] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, agent.id));
  expect(unchanged).toEqual(agent);
  expect(await thinkingAgent(fx.db, agent, fx.owner.id)).toMatchObject({
    brain: "codex",
    machineId,
    brainAccountId: null,
    ownerUserId: fx.owner.id,
    brainFallback: false,
    brainExtraUsage: false,
    planForOthers: false,
  });
  expect(await thinkingAgent(fx.db, agent, other.id)).toMatchObject({
    brain: "grok",
    brainAccountId: otherAccountId,
    ownerUserId: other.id,
  });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  const message = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, {
    body: "Check my model status",
  });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!run) throw new Error("Missing run");
  const [machine] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  if (!machine) throw new Error("Missing machine");
  const plan = await resolveBrain(
    { db: fx.db, machines: { status: async () => ({ ...machine, lastSeenAt: machine.lastSeenAt?.toISOString() ?? null }) } },
    agent,
    run,
    dm.id,
  );
  expect(plan).toMatchObject({ kind: "codex", session: { machineId } });
  expect("account" in plan ? plan.account : undefined).toBeUndefined();
}, 30_000);

test("account null without a machine still resets personal AI, and a named plan clears an old own binding", async () => {
  const { fx, deps, agent, machineId, accountId } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, {
    scope: "mine",
    brain: "codex",
    account: null,
    machineId,
  });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { scope: "mine", effort: "low" });
  expect(await personalBrain(fx.db, fx.org.id, fx.owner.id)).toMatchObject({
    brain: "codex",
    machineId,
    brainEffort: "low",
  });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { scope: "mine", brain: "grok", account: accountId });
  expect(await personalBrain(fx.db, fx.org.id, fx.owner.id)).toMatchObject({
    brainAccountId: accountId,
    machineId: null,
  });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { scope: "mine", account: null });
  expect(await personalBrain(fx.db, fx.org.id, fx.owner.id)).toBeNull();
  expect(await getAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, "mine")).toMatchObject({ brain: "model" });
}, 30_000);

test("personal own routing refuses another person's computer, paid fallback, and unverified subscription auth", async () => {
  const { fx, deps, other, agent, machineId } = await world();
  const input = { scope: "mine", brain: "codex", account: null, machineId };
  expect(await codeOf(setAgentBrain(deps, other.id, fx.org.id, agent.id, input))).toBe("account.not_owner");
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { ...input, fallback: true }))).toBe(
    "brain.personal_subscription",
  );
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { ...input, extraUsage: true }))).toBe(
    "brain.personal_subscription",
  );
  await fx.db
    .update(schema.machines)
    .set({
      executors: {
        claude: { version: "2.1.318", loggedIn: true, authMethod: "api_key" },
        codex: { version: "0.170.0" },
        grok: { version: "1.0.70" },
      },
    })
    .where(eq(schema.machines.id, machineId));
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, input))).toBe("brain.unavailable");
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { ...input, brain: "claude_code" }))).toBe(
    "brain.unavailable",
  );
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { ...input, brain: "grok" }))).toBe(
    "brain.unavailable",
  );
}, 30_000);

test("the resolver rechecks personal own sign-in ownership after the binding was saved", async () => {
  const { fx, deps, other, agent, machineId } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, {
    scope: "mine",
    brain: "claude_code",
    account: null,
    machineId,
  });
  expect(await thinkingAgent(fx.db, agent, fx.owner.id)).toMatchObject({
    brain: "claude_code",
    machineId,
    ownerUserId: fx.owner.id,
  });
  await fx.db.delete(schema.rightHandBrains).where(eq(schema.rightHandBrains.userId, other.id));
  const frame = (await machineAgents(fx.db, fx.org.id, machineId)).find((entry) => entry.id === agent.id);
  expect(frame).toMatchObject({ id: agent.id, handle: agent.handle });
  expect(frame?.account).toBeUndefined();
  expect(frame?.accounts).toBeUndefined();
  expect(frame?.containers).toBeUndefined();
  await fx.db.update(schema.machines).set({ pairedByUserId: other.id }).where(eq(schema.machines.id, machineId));
  expect((await machineAgents(fx.db, fx.org.id, machineId)).some((entry) => entry.id === agent.id)).toBe(false);
  expect(await thinkingAgent(fx.db, agent, fx.owner.id)).toMatchObject({
    brain: "claude_code",
    machineId: null,
    ownerUserId: null,
    brainFallback: false,
  });
}, 30_000);
