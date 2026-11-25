import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createCredential, credentialVersion, creditPricingProfile } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const USD = 1_000_000_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

function evidence(provider: "openai" | "anthropic" = "anthropic") {
  return {
    provider,
    upstreamAccount: provider === "openai" ? "org-openai-fixture" : "org-anthropic-fixture",
    product: provider === "openai" ? "openai_pro_api" : "claude_ultra_api",
    cycleKey: "fixture-cycle-1",
    grantId: "fixture-grant-1",
    grantStart: iso(-7 * 86_400_000),
    grantEnd: iso(23 * 86_400_000),
    eligibleSince: iso(-40 * 86_400_000),
    activatedAt: iso(-7 * 86_400_000),
    enforcement: "prepaid_grant_only",
    externalSpendCoverage: "exclusive",
    externalSpendBoundNanoUsd: 0,
    evidenceRef: "official-billing-fixture-1",
    verifiedAt: iso(-60_000),
    validUntil: iso(3_600_000),
    grantAmountNanoUsd: 200 * USD,
    observedRemainingNanoUsd: 200 * USD,
  };
}
function pricingEvidence(model: string) {
  return {
    evidenceRef: "official-standard-pricing-fixture",
    verifiedAt: iso(-60_000),
    validUntil: iso(3_600_000),
    profileHash: creditPricingProfile(model).profileHash,
  };
}
async function fixture(enabled = false) {
  const server = await createTestServer({
    env: { ALLOW_SIGNUP: "true", CREDIT_FALLBACK_ENABLED: String(enabled) },
  });
  t = server;
  const owner = browser(server);
  const signed = await signUp(owner, "credit-owner@example.com");
  const { user } = (await signed.json()) as { user: { id: string } };
  const created = await owner("/api/app/organizations", { json: { name: "Credit continuity fixture" } });
  const { organization } = (await created.json()) as { organization: { id: string } };
  return {
    ...server,
    owner,
    ownerId: user.id,
    orgId: organization.id,
    path: `/api/app/organizations/${organization.id}/credit-continuity`,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function expectJson<T>(response: Response, status: number): Promise<T> {
  const data = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { data }) }).toEqual({ status });
  return data as T;
}
async function prepared(f: Fixture, provider: "openai" | "anthropic" = "anthropic", legacyIdentity = false) {
  const proof = evidence(provider);
  const { poolId } = await expectJson<{ poolId: string }>(
    await f.owner(`${f.path}/pools`, { json: { evidence: proof } }),
    201,
  );
  const key = await createCredential(f.db, f.adapters.keyWrapper, f.ownerId, f.orgId, {
    provider,
    label: "Synthetic grant route",
    apiKey: "sk-synthetic-test-only",
    ...(provider === "openai" ? { organization: proof.upstreamAccount } : {}),
  });
  if (legacyIdentity)
    await f.db
      .update(schema.providerCredentials)
      .set({ secretFingerprint: null })
      .where(eq(schema.providerCredentials.id, key.id));
  const registration = {
    poolId,
    credentialId: key.id,
    model: provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5",
    supportsTools: true,
    maxPromptBytes: 100_000,
    routeKind: provider === "openai" ? "openai_responses" : "anthropic_messages",
    accountEvidenceRef: "credential-account-fixture",
    pricingEvidence: pricingEvidence(provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5"),
    capabilities: ["text", "client_tools"],
  };
  const { routeId } = await expectJson<{ routeId: string }>(
    await f.owner(`${f.path}/routes`, { json: registration }),
    201,
  );
  const [pool] = await f.db.select().from(schema.creditPools).where(eq(schema.creditPools.id, poolId));
  if (!pool?.currentCycleId) throw new Error("missing fixture cycle");
  return { poolId, routeId, cycleId: pool.currentCycleId, proof, registration };
}
type Prepared = Awaited<ReturnType<typeof prepared>>;
function reserveInput(r: Prepared) {
  return {
    cycleId: r.cycleId,
    amountNanoUsd: 10 * USD,
    validUntil: iso(1_800_000),
    decisionKey: "owner-decision-fixture-1",
    evidenceRef: "owner-approval-fixture",
  };
}
async function attempt(f: Fixture, r: Prepared) {
  const id = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await f.db.insert(schema.creditAttempts).values({
    id,
    orgId: f.orgId,
    poolId: r.poolId,
    cycleId: r.cycleId,
    routeId: r.routeId,
    runId,
    workUnitKey: `fixture-unit:${id}`,
    attemptKey: `fixture-attempt:${id}`,
    ownerEpoch: 1,
    ownerJobId: crypto.randomUUID(),
    ownerWorkerId: "fixture-worker",
    bucket: "automatic",
    reservationNeed: { tools: false, promptBytes: 1000 },
    pricingSnapshot: creditPricingProfile(r.registration.model),
    pricingProfileHash: r.registration.pricingEvidence.profileHash,
    cacheTtl: "default",
    amountNanoUsd: 4 * USD,
    state: "unknown",
  });
  await f.db
    .update(schema.creditGrantCycles)
    .set({ heldAutomaticNanoUsd: 4 * USD })
    .where(eq(schema.creditGrantCycles.id, r.cycleId));
  await f.db
    .update(schema.creditPools)
    .set({ status: "reconciliation_required" })
    .where(eq(schema.creditPools.id, r.poolId));
  return { id, runId };
}

test("every mutation requires a current owner, not an administrator or another signed-in person", async () => {
  const f = await fixture(true);
  const r = await prepared(f);
  const a = await attempt(f, r);
  const admin = await joinByInvitation(f, f.owner, f.orgId, "credit-admin@example.com", { role: "admin" });
  const stranger = browser(f);
  await signUp(stranger, "credit-stranger@example.com");
  const inputs = [
    { path: "/pools", json: { evidence: r.proof } },
    { path: `/runs/${a.runId}/resume`, json: { evidenceRef: "owner-recovery-fixture" } },
    { path: `/pools/${r.poolId}/evidence`, method: "PATCH", json: { evidence: r.proof } },
    { path: `/pools/${r.poolId}/cycles`, json: { evidence: r.proof } },
    { path: "/routes", json: r.registration },
    {
      path: `/routes/${r.routeId}/pricing-evidence`,
      method: "PATCH",
      json: { pricingEvidence: r.registration.pricingEvidence },
    },
    { path: `/routes/${r.routeId}`, method: "PATCH", json: { enabled: true } },
    { path: `/pools/${r.poolId}/emergency-approvals`, json: reserveInput(r) },
    {
      path: `/attempts/${a.id}/reconcile`,
      json: { outcome: "released", evidenceRef: "provider-no-charge", reason: "confirmed_not_charged" },
    },
  ];
  for (const input of inputs) {
    const { path, ...options } = input;
    expect((await browser(f)(f.path + path, options)).status).toBe(401);
    expect((await stranger(f.path + path, options)).status).toBe(403);
    expect((await admin(f.path + path, options)).status).toBe(403);
  }
  expect(await f.db.select().from(schema.creditReserveApprovals)).toHaveLength(0);
  expect(await f.db.select().from(schema.creditPools)).toHaveLength(1);
  expect(await f.db.select().from(schema.creditRoutes)).toHaveLength(1);
  expect((await f.db.select().from(schema.creditAttempts))[0]?.state).toBe("unknown");
});

test("actor and verifier cannot be spoofed and owner membership is checked on every request", async () => {
  const f = await fixture();
  const proof = evidence();
  expect(
    (
      await f.owner(`${f.path}/pools`, {
        json: { actorUserId: "another-user", evidence: proof },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.owner(`${f.path}/pools`, {
        json: { evidence: { ...proof, verifiedByUserId: "another-user" } },
      })
    ).status,
  ).toBe(400);
  const r = await prepared(f);
  const [cycle] = await f.db.select().from(schema.creditGrantCycles);
  expect(cycle?.verifiedByUserId).toBe(f.ownerId);
  await f.db
    .update(schema.organizationMembers)
    .set({ role: "member" })
    .where(and(eq(schema.organizationMembers.orgId, f.orgId), eq(schema.organizationMembers.userId, f.ownerId)));
  expect((await f.owner(`${f.path}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: false } })).status).toBe(
    403,
  );
});

test("feature-off preparation cannot activate spending, while an owner can always disable", async () => {
  const f = await fixture();
  const r = await prepared(f);
  const [pool] = await f.db.select().from(schema.creditPools);
  const [route] = await f.db.select().from(schema.creditRoutes);
  expect(pool?.enabled).toBe(false);
  expect(route?.enabled).toBe(false);
  const enable = await f.owner(`${f.path}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: true } });
  expect(await expectJson(enable, 409)).toMatchObject({ error: { code: "credit.disabled" } });
  expect((await f.owner(`${f.path}/pools/${r.poolId}/emergency-approvals`, { json: reserveInput(r) })).status).toBe(
    409,
  );
  await f.db.update(schema.creditRoutes).set({ enabled: true }).where(eq(schema.creditRoutes.id, r.routeId));
  expect((await f.owner(`${f.path}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: false } })).status).toBe(
    200,
  );
  expect((await f.db.select().from(schema.creditRoutes))[0]?.enabled).toBe(false);
  expect(await f.db.select().from(schema.creditReserveApprovals)).toHaveLength(0);
});

test("grant inputs reject purchased funding, unsafe amounts, missing evidence and arbitrary route controls", async () => {
  const f = await fixture();
  const proof = evidence();
  for (const invalid of [
    { ...proof, enforcement: "auto_reload" },
    { ...proof, grantAmountNanoUsd: Number.MAX_SAFE_INTEGER + 1 },
    { ...proof, observedRemainingNanoUsd: -1 },
    { ...proof, grantEnd: "not-a-date" },
    { ...proof, apiKey: "never-accepted" },
  ])
    expect((await f.owner(`${f.path}/pools`, { json: { evidence: invalid } })).status).toBe(400);
  expect((await f.owner(`${f.path}/pools`, { json: { subscription: "Pro" } })).status).toBe(400);
  for (const invalid of [
    { ...proof, provider: "openai" },
    { ...proof, eligibleSince: iso(-86_400_000) },
    { ...proof, validUntil: iso(2 * 86_400_000) },
    { ...proof, observedRemainingNanoUsd: 201 * USD },
  ])
    expect((await f.owner(`${f.path}/pools`, { json: { evidence: invalid } })).status).toBe(409);
  expect(await f.db.select().from(schema.creditPools)).toHaveLength(0);
  const r = await prepared(f);
  for (const override of [{ enabled: true }, { routeId: crypto.randomUUID() }, { endpoint: "https://other.test" }]) {
    expect((await f.owner(`${f.path}/routes`, { json: { ...r.registration, ...override } })).status).toBe(400);
  }
  expect((await f.owner(`${f.path}/routes`, { json: { ...r.registration, routeKind: "codex_api_key" } })).status).toBe(
    400,
  );
  expect(
    (await f.owner(`${f.path}/routes`, { json: { ...r.registration, routeKind: "claude_agent_sdk" } })).status,
  ).toBe(409);
  expect((await f.owner(`${f.path}/pools`, { json: { evidence: r.proof } })).status).toBe(409);
  expect((await f.owner(`${f.path}/routes`, { json: r.registration })).status).toBe(409);
  expect(await f.db.select().from(schema.creditRoutes)).toHaveLength(1);
});

test("explicit emergency approval is cycle-bound, amount-bounded, audited and idempotent without spending", async () => {
  const f = await fixture(true);
  const r = await prepared(f);
  expect((await f.owner(`${f.path}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: true } })).status).toBe(
    200,
  );
  const path = `${f.path}/pools/${r.poolId}/emergency-approvals`;
  const input = reserveInput(r);
  const first = await expectJson<{ approvalId: string }>(await f.owner(path, { json: input }), 201);
  expect(await expectJson(await f.owner(path, { json: input }), 201)).toEqual(first);
  for (const invalid of [
    { ...input, amountNanoUsd: 61 * USD },
    { ...input, cycleId: crypto.randomUUID() },
    { ...input, validUntil: iso(-1) },
    { ...input, validUntil: iso(40 * 86_400_000) },
    { ...input, amountNanoUsd: 11 * USD },
  ])
    expect((await f.owner(path, { json: invalid })).status).toBe(409);
  const approvals = await f.db.select().from(schema.creditReserveApprovals);
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({
    actorUserId: f.ownerId,
    poolId: r.poolId,
    cycleId: r.cycleId,
    amountNanoUsd: 10 * USD,
    evidenceRef: "owner-approval-fixture",
    heldNanoUsd: 0,
    spentNanoUsd: 0,
  });
  expect(await f.db.select().from(schema.creditAttempts)).toHaveLength(0);
});

test("org-scoped routes and credentials cannot be used from another workspace", async () => {
  const f = await fixture(true);
  const r = await prepared(f);
  const a = await attempt(f, r);
  const otherId = crypto.randomUUID();
  await f.db.insert(schema.organizations).values({ id: otherId, name: "Other workspace" });
  await f.db.insert(schema.organizationMembers).values({ orgId: otherId, userId: f.ownerId, role: "owner" });
  const otherPath = `/api/app/organizations/${otherId}/credit-continuity`;
  expect(
    (await f.owner(`${otherPath}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: false } })).status,
  ).toBe(409);
  expect(
    (
      await f.owner(`${otherPath}/pools/${r.poolId}/evidence`, {
        method: "PATCH",
        json: { evidence: r.proof },
      })
    ).status,
  ).toBe(409);
  expect((await f.owner(`${otherPath}/pools/${r.poolId}/emergency-approvals`, { json: reserveInput(r) })).status).toBe(
    409,
  );
  expect(
    (
      await f.owner(`${otherPath}/attempts/${a.id}/reconcile`, {
        json: { outcome: "released", evidenceRef: "provider-no-charge", reason: "confirmed_not_charged" },
      })
    ).status,
  ).toBe(404);
  const { poolId } = await expectJson<{ poolId: string }>(
    await f.owner(`${otherPath}/pools`, { json: { evidence: { ...r.proof, upstreamAccount: "org-other-fixture" } } }),
    201,
  );
  expect((await f.owner(`${otherPath}/routes`, { json: { ...r.registration, poolId } })).status).toBe(404);
  expect((await f.db.select().from(schema.creditAttempts))[0]?.state).toBe("unknown");
});

test("reconciliation needs an explicit outcome and evidence, survives feature-off and never creates a run", async () => {
  const f = await fixture();
  const r = await prepared(f);
  const a = await attempt(f, r);
  const path = `${f.path}/attempts/${a.id}/reconcile`;
  const beforeRuns = await f.db
    .select({ id: schema.agentRuns.id, status: schema.agentRuns.status })
    .from(schema.agentRuns);
  const beforeJobs = await f.db.select({ id: schema.outbox.id }).from(schema.outbox);
  const input = { evidenceRef: "provider-final-receipt", reason: "receipt_verified" };
  for (const invalid of [
    input,
    { ...input, outcome: "settled" },
    { ...input, outcome: "released", actualNanoUsd: 0 },
    { ...input, outcome: "settled", actualNanoUsd: -1 },
  ]) {
    expect((await f.owner(path, { json: invalid })).status).toBe(400);
  }
  const settled = { ...input, outcome: "settled", actualNanoUsd: 2 * USD };
  expect(await expectJson(await f.owner(path, { json: settled }), 200)).toEqual({ changed: true, state: "settled" });
  expect(await expectJson(await f.owner(path, { json: settled }), 200)).toEqual({ changed: false, state: "settled" });
  const [cycle] = await f.db.select().from(schema.creditGrantCycles).where(eq(schema.creditGrantCycles.id, r.cycleId));
  expect(cycle).toMatchObject({ heldAutomaticNanoUsd: 0, spentAutomaticNanoUsd: 2 * USD });
  const logs = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "credit.reconciled"));
  expect(logs).toHaveLength(1);
  expect(logs[0]?.actorId).toBe(f.ownerId);
  expect(logs[0]?.details).toMatchObject({ evidenceRef: "provider-final-receipt" });
  expect(
    await f.db.select({ id: schema.agentRuns.id, status: schema.agentRuns.status }).from(schema.agentRuns),
  ).toEqual(beforeRuns);
  expect(await f.db.select({ id: schema.outbox.id }).from(schema.outbox)).toEqual(beforeJobs);
});

test("refresh can only lower budget and a verified later cycle resets activation", async () => {
  const f = await fixture(true);
  const r = await prepared(f);
  expect((await f.owner(`${f.path}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: true } })).status).toBe(
    200,
  );
  const reduced = {
    ...r.proof,
    grantAmountNanoUsd: 100 * USD,
    observedRemainingNanoUsd: 100 * USD,
    evidenceRef: "official-billing-fixture-2",
    verifiedAt: iso(-30_000),
  };
  expect(
    (await f.owner(`${f.path}/pools/${r.poolId}/evidence`, { method: "PATCH", json: { evidence: reduced } })).status,
  ).toBe(200);
  const [cycle] = await f.db.select().from(schema.creditGrantCycles).where(eq(schema.creditGrantCycles.id, r.cycleId));
  expect(cycle).toMatchObject({
    automaticLimitNanoUsd: 20 * USD,
    emergencyLimitNanoUsd: 60 * USD,
    safetyBufferNanoUsd: 20 * USD,
  });
  expect(
    (
      await f.owner(`${f.path}/pools/${r.poolId}/evidence`, {
        method: "PATCH",
        json: { evidence: { ...reduced, grantAmountNanoUsd: 200 * USD } },
      })
    ).status,
  ).toBe(409);
  // Move the old fixture cycle into the past; no clock wait or production row is involved.
  const previousEnd = iso(-60_000);
  await f.db
    .update(schema.creditGrantCycles)
    .set({
      grantEnd: new Date(previousEnd),
      validUntil: new Date(previousEnd),
      verifiedAt: new Date(iso(-3_600_000)),
    })
    .where(eq(schema.creditGrantCycles.id, r.cycleId));
  const next = {
    ...r.proof,
    cycleKey: "fixture-cycle-2",
    grantId: "fixture-grant-2",
    grantStart: previousEnd,
    grantEnd: iso(30 * 86_400_000),
    activatedAt: previousEnd,
    verifiedAt: iso(-30_000),
    validUntil: iso(3_600_000),
  };
  f.config.CREDIT_FALLBACK_ENABLED = false;
  const started = await expectJson<{ cycleId: string; enabled: boolean }>(
    await f.owner(`${f.path}/pools/${r.poolId}/cycles`, { json: { evidence: next } }),
    201,
  );
  expect(started.enabled).toBe(false);
  expect(started.cycleId).not.toBe(r.cycleId);
  expect(await f.db.select().from(schema.creditGrantCycles)).toHaveLength(2);
  expect((await f.db.select().from(schema.creditPools))[0]?.enabled).toBe(false);
});

test("OpenAI registration binds the official Responses route to the verified API organization", async () => {
  const f = await fixture(true);
  const r = await prepared(f, "openai");
  expect((await f.owner(`${f.path}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: true } })).status).toBe(
    200,
  );
  const wrong = await createCredential(f.db, f.adapters.keyWrapper, f.ownerId, f.orgId, {
    provider: "openai",
    label: "Other synthetic account",
    apiKey: "sk-synthetic-test-only",
    organization: "org-other",
  });
  const refused = await f.owner(`${f.path}/routes`, { json: { ...r.registration, credentialId: wrong.id } });
  expect(await expectJson(refused, 409)).toMatchObject({ error: { code: "credit.account_mismatch" } });
  const [route] = await f.db.select().from(schema.creditRoutes);
  expect(route).toMatchObject({ routeKind: "openai_responses", credentialId: r.registration.credentialId });
});

test("owner recovery remains available while disabled and queues exactly one existing run", async () => {
  const f = await fixture();
  const [agent] = await f.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.orgId, f.orgId));
  const [channel] = await f.db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.orgId, f.orgId));
  if (!agent || !channel) throw new Error("missing isolated workspace fixtures");
  const runId = crypto.randomUUID();
  await f.db.insert(schema.agentRuns).values({
    id: runId,
    orgId: f.orgId,
    agentId: agent.id,
    channelId: channel.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
    trigger: "mention",
    hop: 1,
    status: "waiting_input",
    transcript: {
      messages: [{ role: "user", content: "Retained task" }],
      creditHold: {
        schema: "credit-reconciliation/1",
        reason: "provider_refusal",
        heldAt: iso(-60_000),
        nextSafeAction: "reconcile_usage_and_action_receipts",
      },
    },
  });
  const path = `${f.path}/runs/${runId}/resume`;
  expect((await f.owner(path, { json: { evidenceRef: "owner-recovery", actorUserId: "another-user" } })).status).toBe(
    403,
  );
  expect((await f.owner(path, { json: { evidenceRef: "owner-recovery", force: true } })).status).toBe(400);
  const responses = await Promise.all([
    f.owner(path, { json: { evidenceRef: "owner-recovery" } }),
    f.owner(path, { json: { evidenceRef: "owner-recovery" } }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  expect(run?.status).toBe("queued");
  expect(run?.transcript).toEqual({ messages: [{ role: "user", content: "Retained task" }] });
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect(jobs.filter((job) => job.payload.runId === runId)).toHaveLength(1);
  const [step] = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId));
  expect(step?.data).toMatchObject({ creditReconciliation: { actorUserId: f.ownerId, evidenceRef: "owner-recovery" } });
});

test("route pricing proof is required, fresh and bound to the exact standard tariff", async () => {
  const f = await fixture();
  const r = await prepared(f);
  const { pricingEvidence: proof, ...missing } = r.registration;
  expect((await f.owner(`${f.path}/routes`, { json: missing })).status).toBe(400);
  for (const invalid of [
    { ...proof, profileHash: "unverified" },
    { ...proof, apiKey: "never-accepted" },
    { ...proof, verifiedAt: "not-a-date" },
  ]) {
    expect((await f.owner(`${f.path}/routes`, { json: { ...r.registration, pricingEvidence: invalid } })).status).toBe(
      400,
    );
  }
  for (const invalid of [
    { ...proof, profileHash: `sha256:${"0".repeat(64)}` },
    { ...proof, verifiedAt: iso(-2 * 86_400_000), validUntil: iso(-86_400_000) },
    { ...proof, verifiedAt: iso(60_000), validUntil: iso(3_600_000) },
    { ...proof, validUntil: iso(2 * 86_400_000) },
  ]) {
    expect(
      (
        await f.owner(`${f.path}/routes/${r.routeId}/pricing-evidence`, {
          method: "PATCH",
          json: { pricingEvidence: invalid },
        })
      ).status,
    ).toBe(409);
  }
  const [route] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, r.routeId));
  expect(route?.pricingProfileHash).toBe(proof.profileHash);
  expect(route?.pricingEvidenceRef).toBe(proof.evidenceRef);
  expect(route?.enabled).toBe(false);
});

test("pricing renewal while feature-off requires an owner and disables an existing route", async () => {
  const f = await fixture();
  const r = await prepared(f);
  await f.db.update(schema.creditRoutes).set({ enabled: true }).where(eq(schema.creditRoutes.id, r.routeId));
  const path = `${f.path}/routes/${r.routeId}/pricing-evidence`;
  const proof = {
    ...r.registration.pricingEvidence,
    evidenceRef: "renewed-official-pricing-fixture",
    verifiedAt: iso(0),
    validUntil: iso(3_600_000),
  };
  expect(
    (await f.owner(path, { method: "PATCH", json: { actorUserId: "another-user", pricingEvidence: proof } })).status,
  ).toBe(403);
  expect(await expectJson(await f.owner(path, { method: "PATCH", json: { pricingEvidence: proof } }), 200)).toEqual({
    updated: true,
    enabled: false,
  });
  const [route] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, r.routeId));
  expect(route).toMatchObject({
    enabled: false,
    pricingProfileHash: proof.profileHash,
    pricingEvidenceRef: proof.evidenceRef,
  });
  expect((await f.owner(`${f.path}/routes/${r.routeId}`, { method: "PATCH", json: { enabled: true } })).status).toBe(
    409,
  );
  expect(await f.db.select().from(schema.creditAttempts)).toHaveLength(0);
});

test("registration migrates only the existing credential identity and never returns its fingerprint", async () => {
  const f = await fixture();
  const before = await f.db.select({ id: schema.providerCredentials.id }).from(schema.providerCredentials);
  const r = await prepared(f, "anthropic", true);
  const rows = await f.db.select().from(schema.providerCredentials);
  expect(rows).toHaveLength(before.length + 1);
  const key = rows.find((row) => row.id === r.registration.credentialId);
  if (!key?.secretFingerprint) throw new Error("missing verified fixture fingerprint");
  expect(key.secretFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const [route] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, r.routeId));
  expect(route?.credentialFingerprint).toBe(key.secretFingerprint);
  expect(route?.credentialVersion).toBe(credentialVersion(key));
  const response = await f.owner(`${f.path}/routes/${r.routeId}/pricing-evidence`, {
    method: "PATCH",
    json: { pricingEvidence: r.registration.pricingEvidence },
  });
  const data = await expectJson(response, 200);
  expect(JSON.stringify(data)).not.toContain("sha256:");
  expect(JSON.stringify(data)).not.toContain("synthetic");
  expect(await f.db.select().from(schema.creditAttempts)).toHaveLength(0);
});
