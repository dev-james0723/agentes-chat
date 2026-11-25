import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { parseOpenRouterModels, setOpenRouterModels } from "@agenteschat/providers";
import fixture from "../../providers/test/fixtures/openrouter-models.json";
import { createAgent, createModelGateway } from "../src";
import { createCredential } from "../src/credentials";
import {
  configureOpenRouterFallback,
  type OpenRouterFallbackRoute,
  openRouterFallbackConfig,
  readOpenRouterFallback,
  reserveOpenRouterFallback,
  settleOpenRouterFallback,
} from "../src/openrouter-fallback-ledger";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  setOpenRouterModels({}, 0);
  await f?.close();
  f = undefined as unknown as Fixture;
});
const USD = 1_000_000_000;
const now = () => new Date("2026-11-23T12:00:00Z");
const policy = {
  allowedModels: ["openai/gpt-6-luna", "anthropic/claude-sonnet-5.5"],
  costTier: "medium" as const,
  monthlyCapUsd: 50,
  maxPromptUsdPerMillion: 4,
  maxCompletionUsdPerMillion: 20,
};
async function configured() {
  f = await setup();
  const credential = await createCredential(
    f.db,
    f.keyWrapper,
    f.owner.id,
    f.org.id,
    {
      provider: "openrouter",
      label: "dedicated test fallback",
      apiKey: `sk-or-v1-${"a".repeat(64)}`,
    },
    { fetch: (async () => Response.json({ data: { is_management_key: false } })) as unknown as typeof fetch },
  );
  await configureOpenRouterFallback(f.db, f.org.id, f.owner.id, { enabled: true, credentialId: credential.id, policy });
  const config = await openRouterFallbackConfig(f.db, f.org.id);
  if (!config?.credentialId || !config.credentialVersion) throw new Error("missing test config");
  const route: OpenRouterFallbackRoute = {
    schema: "openrouter-fallback/1",
    router: "openrouter/auto-code",
    revision: config.revision,
    credentialId: config.credentialId,
    credentialVersion: config.credentialVersion,
  };
  return { credential, route };
}
async function runClaim(route: OpenRouterFallbackRoute, agentId = f.agent.id) {
  const runId = crypto.randomUUID();
  const ownerJobId = crypto.randomUUID();
  await f.db.insert(schema.agentRuns).values({
    id: runId,
    orgId: f.org.id,
    agentId,
    channelId: f.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 1,
    status: "running",
    brain: "model",
    transcript: { openRouterFallback: route },
  });
  await f.db.insert(schema.outbox).values({
    id: ownerJobId,
    orgId: f.org.id,
    kind: "agent_run.execute",
    payload: { runId },
    status: "processing",
    lockedBy: "worker-fixture",
    lockedUntil: new Date("2027-01-01T00:00:00Z"),
    attempts: 1,
  });
  return {
    orgId: f.org.id,
    agentId,
    runId,
    turn: 1,
    route,
    claim: { ownerJobId, ownerWorkerId: "worker-fixture", ownerEpoch: 1 },
    now,
  };
}

test("disabled by default; non-owners and unauthorized budget increases cannot configure", async () => {
  f = await setup();
  const initial = await readOpenRouterFallback(f.db, f.org.id, now());
  expect(initial).toMatchObject({ enabled: false, monthlyCapNanoUsd: 50 * USD, spentNanoUsd: 0 });
  const admin = await addMember(f.db, f.org.id, "admin");
  await expect(configureOpenRouterFallback(f.db, f.org.id, admin.id, { enabled: false })).rejects.toThrow();
  await expect(
    configureOpenRouterFallback(f.db, f.org.id, f.owner.id, {
      enabled: true,
      credentialId: f.credential.id,
      policy: { ...policy, monthlyCapUsd: 51 },
    }),
  ).rejects.toThrow("US$50");
});

test("concurrent runs share one monthly cap; actual settlement releases only the reserved difference", async () => {
  const { route } = await configured();
  const a = await runClaim(route);
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Second agent",
      handle: "second-agent",
      role: "Engineering",
      instructions: "Test only.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
  const b = await runClaim(route, other.id);
  const results = await Promise.allSettled([
    reserveOpenRouterFallback(f.db, { ...a, boundNanoUsd: 30 * USD }),
    reserveOpenRouterFallback(f.db, { ...b, boundNanoUsd: 30 * USD }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  expect(ok).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const first = ok[0];
  if (first?.status !== "fulfilled") throw new Error("no admitted attempt");
  expect(await readOpenRouterFallback(f.db, f.org.id, now())).toMatchObject({ heldNanoUsd: 30 * USD, spentNanoUsd: 0 });
  await settleOpenRouterFallback(
    f.db,
    f.org.id,
    first.value.attemptId,
    { model: policy.allowedModels[0] ?? "", costNanoUsd: 10 * USD },
    now(),
  );
  expect(await readOpenRouterFallback(f.db, f.org.id, now())).toMatchObject({ heldNanoUsd: 0, spentNanoUsd: 10 * USD });
  await expect(
    settleOpenRouterFallback(
      f.db,
      f.org.id,
      first.value.attemptId,
      { model: policy.allowedModels[0] ?? "", costNanoUsd: USD },
      now(),
    ),
  ).rejects.toThrow("duplicate_or_unknown_receipt");
});

test("a duplicate turn or stale native claim cannot reserve again", async () => {
  const { route } = await configured();
  const a = await runClaim(route);
  await reserveOpenRouterFallback(f.db, { ...a, boundNanoUsd: USD });
  await expect(reserveOpenRouterFallback(f.db, { ...a, boundNanoUsd: USD })).rejects.toThrow("duplicate_attempt");
  const b = await runClaim(route);
  await expect(
    reserveOpenRouterFallback(f.db, { ...b, boundNanoUsd: USD, claim: { ...b.claim, ownerEpoch: 99 } }),
  ).rejects.toThrow();
});

test("unknown receipt retains the liability, pauses, and prevents spending after rollover", async () => {
  const { route } = await configured();
  const a = await runClaim(route);
  const held = await reserveOpenRouterFallback(f.db, { ...a, boundNanoUsd: 2 * USD });
  await expect(settleOpenRouterFallback(f.db, f.org.id, held.attemptId, null, now())).rejects.toThrow(
    "reconciliation_required",
  );
  expect(await readOpenRouterFallback(f.db, f.org.id, now())).toMatchObject({ blocked: true, heldNanoUsd: 2 * USD });
  const b = await runClaim(route);
  await expect(
    reserveOpenRouterFallback(f.db, { ...b, now: () => new Date("2026-12-01T12:00:00Z"), boundNanoUsd: USD }),
  ).rejects.toThrow("reconciliation_required");
});

test("overbound actual cost is recorded and pauses the pool; key rotation or owner disable rejects stale routes", async () => {
  const { route, credential } = await configured();
  const a = await runClaim(route);
  const held = await reserveOpenRouterFallback(f.db, { ...a, boundNanoUsd: USD });
  await expect(
    settleOpenRouterFallback(
      f.db,
      f.org.id,
      held.attemptId,
      { model: "openai/gpt-6-luna", costNanoUsd: 2 * USD },
      now(),
    ),
  ).rejects.toThrow("cost_bound_exceeded");
  expect(await readOpenRouterFallback(f.db, f.org.id, now())).toMatchObject({
    blocked: true,
    spentNanoUsd: 2 * USD,
    heldNanoUsd: 0,
  });
  await f.db
    .update(schema.providerCredentials)
    .set({ secretFingerprint: "b".repeat(64) })
    .where(eq(schema.providerCredentials.id, credential.id));
  const b = await runClaim(route);
  await expect(reserveOpenRouterFallback(f.db, { ...b, boundNanoUsd: USD })).rejects.toThrow("credential_changed");
  await configureOpenRouterFallback(f.db, f.org.id, f.owner.id, { enabled: false });
  await expect(reserveOpenRouterFallback(f.db, { ...b, boundNanoUsd: USD })).rejects.toThrow("policy_changed");
});

test("the actual gateway reserves then records the resolved model and paid cost, preserving ordinary usage", async () => {
  const { route } = await configured();
  setOpenRouterModels(parseOpenRouterModels(fixture));
  const a = await runClaim(route);
  let calls = 0;
  const deltas: string[] = [];
  const gateway = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    openRouterFallbackEnabled: true,
    providers: {
      openrouter: {
        id: "openrouter",
        async stream(request, opts) {
          calls++;
          expect(request.model).toBe("openrouter/auto-code");
          expect(request.openRouterAuto?.monthlyCapUsd).toBe(50);
          expect((await readOpenRouterFallback(f.db, f.org.id)).heldNanoUsd).toBeGreaterThan(0);
          opts.onDelta("mock routed");
          expect(deltas).toHaveLength(0);
          return {
            text: "mock routed",
            content: [{ type: "text", text: "mock routed" }],
            model: "openai/gpt-6-luna",
            stopReason: "end_turn",
            usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costNanoUsd: 100_000,
            usageVerified: true,
          };
        },
      },
    },
  });
  const result = await gateway.stream({
    orgId: a.orgId,
    agentId: a.agentId,
    runId: a.runId,
    system: "test",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
    openRouterFallback: { route, claim: a.claim, turn: a.turn },
    onDelta: (v) => deltas.push(v),
  });
  expect(result.model).toBe("openai/gpt-6-luna");
  expect(result.costNanoUsd).toBe(100_000);
  expect(calls).toBe(1);
  expect(deltas).toEqual(["mock routed"]);
  const [row] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.runId, a.runId));
  expect(row).toMatchObject({ requestedModel: route.router, model: "openai/gpt-6-luna", costNanoUsd: 100_000 });
  expect(await readOpenRouterFallback(f.db, f.org.id)).toMatchObject({ heldNanoUsd: 0, spentNanoUsd: 100_000 });
});
