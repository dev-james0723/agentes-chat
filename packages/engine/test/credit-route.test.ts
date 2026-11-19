import { afterEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database, eq, schema, sql } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { createCredential, revokeCredential, rotateCredential } from "../src";
import {
  admitCreditCall,
  isCreditCredential,
  qualifyCreditRoute,
  registerCreditPool,
  registerCreditRoute,
  setCreditRouteEnabled,
  settleCreditAttempt,
} from "../src/credit-ledger";
import { CreditRouteRefusal, classifyCreditFailure, creditOutcomeOf, noteCreditOutcome } from "../src/credit-route";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const MODEL = "claude-sonnet-5-5";
const need = { tools: true, promptBytes: 1_000 };
const NOW = () => new Date("2026-11-19T12:00:00Z");
const hour = 3_600_000;

/** A pool with a route on a key of its own, registered and (by default) switched on, as an operator would. */
async function creditFixture(o: { enable?: boolean; allocation?: number; account?: string } = {}) {
  const credential = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "credits",
    apiKey: "sk-ant-synthetic-credit-route",
  });
  const poolId = await registerCreditPool(f.db, f.org.id, {
    upstreamAccount: o.account ?? "console-org-fixture",
    enforcement: "prepaid_grant_only",
    evidenceRef: "fixture-evidence-1",
    verifiedAt: new Date(NOW().getTime() - hour),
    validUntil: new Date(NOW().getTime() + 24 * hour),
    allocationNanoUsd: o.allocation ?? 1_000_000_000,
  });
  const routeId = await registerCreditRoute(f.db, f.org.id, {
    poolId,
    credentialId: credential.id,
    model: MODEL,
    supportsTools: true,
    maxPromptBytes: 100_000,
  });
  if (o.enable !== false) await setCreditRouteEnabled(f.db, f.org.id, routeId, true, NOW);
  const [row] = await f.db.select().from(schema.creditRoutes).where(eq(schema.creditRoutes.id, routeId));
  return { credential, poolId, routeId, version: row?.credentialVersion ?? "" };
}

const admit = (c: { credential: { id: string }; version: string }, amount = 100, now = NOW) =>
  admitCreditCall(f.db, {
    orgId: f.org.id,
    credentialId: c.credential.id,
    credentialVersion: c.version,
    model: MODEL,
    need,
    amountNanoUsd: amount,
    now,
  });

const poolOf = async (id: string) => {
  const [row] = await f.db.select().from(schema.creditPools).where(eq(schema.creditPools.id, id));
  if (!row) throw new Error("pool missing");
  return row;
};

test("nothing registered: the credit route is off and says so", async () => {
  f = await setup();
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
    ok: false,
    reason: "disabled",
  });
});

test("a registered route stays disabled until an operator switches it on", async () => {
  f = await setup();
  await creditFixture({ enable: false });
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
    ok: false,
    reason: "disabled",
  });
});

test("a verified, enabled route qualifies with a proof that names no key and no balance", async () => {
  f = await setup();
  const c = await creditFixture();
  const q = await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW });
  expect(q.ok).toBe(true);
  if (!q.ok) return;
  expect(q.proof).toMatchObject({
    routeId: c.routeId,
    poolId: c.poolId,
    credentialId: c.credential.id,
    model: MODEL,
    pool: "anthropic:console-org-fixture",
  });
  expect(q.proof.validUntil - q.proof.observedAt).toBeLessThanOrEqual(300_000);
  expect(JSON.stringify(q.proof)).not.toContain("sk-ant");
});

test("evidence that is stale or an expired grant refuses, with different reasons", async () => {
  f = await setup();
  await creditFixture();
  expect(
    await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: () => new Date(NOW().getTime() + 48 * hour) }),
  ).toEqual({ ok: false, reason: "stale_evidence" });
  await f.db.update(schema.creditPools).set({ grantEnd: new Date(NOW().getTime() - 1000) });
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
    ok: false,
    reason: "grant_expired",
  });
});

test("a pool the provider refused for credit is exhausted until an operator's new evidence", async () => {
  f = await setup();
  const c = await creditFixture();
  await f.db.update(schema.creditPools).set({ status: "exhausted" });
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
    ok: false,
    reason: "exhausted",
  });
  await expect(admit(c)).rejects.toMatchObject({ reason: "exhausted" });
  await f.db.update(schema.creditPools).set({ status: "billing_blocked" });
  await expect(admit(c)).rejects.toMatchObject({ reason: "billing_blocked" });
});

test("only a prepaid grant with nothing purchased may be registered", async () => {
  f = await setup();
  await expect(
    registerCreditPool(f.db, f.org.id, {
      upstreamAccount: "acct",
      enforcement: "mixed" as never,
      evidenceRef: "x",
      verifiedAt: new Date(NOW().getTime() - hour),
      validUntil: new Date(NOW().getTime() + hour),
      allocationNanoUsd: 10,
    }),
  ).rejects.toThrow("evidence incomplete");
});

test("switching a route on with expired evidence is refused", async () => {
  f = await setup();
  const c = await creditFixture({ enable: false });
  await expect(
    setCreditRouteEnabled(f.db, f.org.id, c.routeId, true, () => new Date(NOW().getTime() + 48 * hour)),
  ).rejects.toMatchObject({ reason: "stale_evidence" });
});

test("a credential belongs to one pool and is reserved for its route", async () => {
  f = await setup();
  const c = await creditFixture();
  const other = await registerCreditPool(f.db, f.org.id, {
    upstreamAccount: "another-console-org",
    enforcement: "prepaid_grant_only",
    evidenceRef: "e2",
    verifiedAt: new Date(NOW().getTime() - hour),
    validUntil: new Date(NOW().getTime() + hour),
    allocationNanoUsd: 10,
  });
  await expect(
    registerCreditRoute(f.db, f.org.id, {
      poolId: other,
      credentialId: c.credential.id,
      model: "claude-sonnet-5-5",
      supportsTools: true,
      maxPromptBytes: 10,
    }),
  ).rejects.toMatchObject({ reason: "account_mismatch" });
  expect(await isCreditCredential(f.db, f.org.id, c.credential.id)).toBe(true);
  expect(await isCreditCredential(f.db, f.org.id, f.credential.id)).toBe(false);
});

test("a rotated or revoked credential refuses admission and qualification", async () => {
  f = await setup();
  const c = await creditFixture();
  await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, c.credential.id, { apiKey: "sk-ant-synthetic-new" });
  await expect(admit(c)).rejects.toMatchObject({ reason: "credential_changed" });
  expect(await qualifyCreditRoute(f.db, { orgId: f.org.id, need, now: NOW })).toEqual({
    ok: false,
    reason: "credential_changed",
  });
  expect((await poolOf(c.poolId)).heldNanoUsd).toBe(0);
});

test("a revoked credential is refused", async () => {
  f = await setup();
  const c = await creditFixture();
  await revokeCredential(f.db, f.owner.id, f.org.id, c.credential.id);
  await expect(admit(c)).rejects.toMatchObject({ reason: "credential_changed" });
});

test("a route without tools refuses a call with tools, and a prompt over its limit", async () => {
  f = await setup();
  const c = await creditFixture();
  await f.db.update(schema.creditRoutes).set({ supportsTools: false });
  await expect(admit(c)).rejects.toMatchObject({ reason: "unsupported_capability" });
  await f.db.update(schema.creditRoutes).set({ supportsTools: true, maxPromptBytes: 10 });
  await expect(admit(c)).rejects.toMatchObject({ reason: "unsupported_capability" });
});

test("admission holds the amount, settles it once, and a repeat settles nothing", async () => {
  f = await setup();
  const c = await creditFixture({ allocation: 1_000 });
  const a = await admit(c, 400);
  expect((await poolOf(c.poolId)).heldNanoUsd).toBe(400);
  expect(await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 150 }, NOW)).toEqual({
    changed: true,
    state: "settled",
  });
  expect(await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 150 }, NOW)).toEqual({
    changed: false,
    state: "settled",
  });
  const pool = await poolOf(c.poolId);
  expect([pool.heldNanoUsd, pool.spentNanoUsd]).toEqual([0, 150]);
});

test("a known refusal releases the hold; an unknown outcome keeps it, even for a late release attempt by time", async () => {
  f = await setup();
  const c = await creditFixture({ allocation: 1_000 });
  const a = await admit(c, 300);
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "released", reason: "refused" }, NOW);
  expect((await poolOf(c.poolId)).heldNanoUsd).toBe(0);
  const b = await admit(c, 300);
  await settleCreditAttempt(f.db, f.org.id, b.attemptId, { kind: "unknown", reason: "timeout" }, NOW);
  expect((await poolOf(c.poolId)).heldNanoUsd).toBe(300);
  // The same call cannot be released by a repeat of the unknown outcome, nor does a later admission free it by time.
  expect(
    (await settleCreditAttempt(f.db, f.org.id, b.attemptId, { kind: "unknown", reason: "timeout" }, NOW)).changed,
  ).toBe(false);
  await admit(c, 100, () => new Date(NOW().getTime() + 10 * 60_000));
  expect((await poolOf(c.poolId)).heldNanoUsd).toBe(400);
  // Only a person's reconciliation closes it.
  await settleCreditAttempt(f.db, f.org.id, b.attemptId, { kind: "settled", actualNanoUsd: 0 }, NOW);
  expect((await poolOf(c.poolId)).heldNanoUsd).toBe(100);
});

test("the allocation is a ceiling: a call that does not fit is refused and holds nothing", async () => {
  f = await setup();
  const c = await creditFixture({ allocation: 500 });
  await admit(c, 300);
  await expect(admit(c, 300)).rejects.toMatchObject({ reason: "no_allocation" });
  expect((await poolOf(c.poolId)).heldNanoUsd).toBe(300);
});

test("a call that cost more than its hold pauses the pool", async () => {
  f = await setup();
  const c = await creditFixture({ allocation: 1_000 });
  const a = await admit(c, 100);
  await settleCreditAttempt(f.db, f.org.id, a.attemptId, { kind: "settled", actualNanoUsd: 250 }, NOW);
  expect((await poolOf(c.poolId)).paused).toBe(true);
  await expect(admit(c, 10)).rejects.toMatchObject({ reason: "paused" });
});

test("agents racing for one pool never get more than its allocation", async () => {
  f = await setup();
  const c = await creditFixture({ allocation: 1_000 });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => admit(c, 100)));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  const pool = await poolOf(c.poolId);
  expect(pool.heldNanoUsd).toBe(1_000);
  const rows = await f.db.select().from(schema.creditAttempts);
  expect(rows).toHaveLength(10);
});

test("one upstream account is one pool across workspaces", async () => {
  f = await setup();
  await creditFixture({ account: "shared-console-org" });
  await expect(creditFixture({ account: "shared-console-org" })).rejects.toThrow();
});

test("a 429 is throughput, never exhausted credit; only a known refusal before output is no charge", () => {
  const e = (status: number | undefined, message: string, partial?: ProviderError["partial"]) =>
    new ProviderError(message, false, status, partial);
  expect(classifyCreditFailure(e(429, "rate limit"))).toEqual({ class: "rate_limit", charged: "no" });
  expect(classifyCreditFailure(e(429, "your credit balance is too low"))).toEqual({
    class: "exhausted",
    charged: "no",
  });
  expect(classifyCreditFailure(e(400, "Your credit balance is too low to access the API"))).toEqual({
    class: "exhausted",
    charged: "no",
  });
  expect(classifyCreditFailure(e(402, "billing_error"))).toEqual({ class: "billing_blocked", charged: "no" });
  expect(classifyCreditFailure(e(401, "authentication_error"))).toEqual({ class: "credential", charged: "no" });
  expect(classifyCreditFailure(e(403, "permission_error"))).toEqual({ class: "credential", charged: "no" });
  expect(classifyCreditFailure(e(400, "invalid request"))).toEqual({ class: "rejected", charged: "no" });
  expect(classifyCreditFailure(e(500, "boom"))).toEqual({ class: "unknown", charged: "unknown" });
  expect(classifyCreditFailure(e(529, "overloaded"))).toEqual({ class: "unknown", charged: "unknown" });
  expect(classifyCreditFailure(e(undefined, "could not reach provider"))).toEqual({
    class: "unknown",
    charged: "unknown",
  });
  expect(
    classifyCreditFailure(
      e(400, "x", { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, outputChars: 4 }),
    ),
  ).toEqual({ class: "unknown", charged: "unknown" });
  expect(classifyCreditFailure(new Error("socket closed"))).toEqual({ class: "unknown", charged: "unknown" });
});

test("an outcome travels with the error it belongs to", () => {
  const error = new Error("x");
  expect(creditOutcomeOf(error)).toBeNull();
  noteCreditOutcome(error, { attemptId: "a", class: "unknown", hold: "unknown" });
  expect(creditOutcomeOf(error)).toEqual({ attemptId: "a", class: "unknown", hold: "unknown" });
  expect(new CreditRouteRefusal("paused").reason).toBe("paused");
});

/**
 * Locks between connections. A real server only (`TEST_DATABASE_URL`): PGlite is one connection. Each handle below is
 * its own client with its own pool to the same database, as separate server processes are.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("real PostgreSQL, independent connections", () => {
  const clients: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  async function handles(n: number): Promise<Database[]> {
    const rows = (await f.db.execute(sql`select current_database() as name`)) as unknown as { name: string }[];
    const name = (Array.isArray(rows) ? rows : ((rows as { rows?: { name: string }[] }).rows ?? []))[0]?.name;
    const url = new URL(process.env.TEST_DATABASE_URL as string);
    url.pathname = `/${name}`;
    return Array.from({ length: n }, () => {
      const handle = createDatabase({ url: url.toString(), poolMax: 2 });
      clients.push(handle);
      return handle.db;
    });
  }

  const admitOn = (db: Database, c: { credential: { id: string }; version: string }, amount = 100) =>
    admitCreditCall(db, {
      orgId: f.org.id,
      credentialId: c.credential.id,
      credentialVersion: c.version,
      model: MODEL,
      need,
      amountNanoUsd: amount,
      now: NOW,
    });

  test("four servers racing for one pool never hold more than its allocation", async () => {
    f = await setup();
    const c = await creditFixture({ allocation: 1_000 });
    const dbs = await handles(4);
    const results = await Promise.allSettled(dbs.flatMap((db) => Array.from({ length: 8 }, () => admitOn(db, c))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .every((r) => (r as PromiseRejectedResult).reason?.reason === "no_allocation"),
    ).toBe(true);
    expect((await poolOf(c.poolId)).heldNanoUsd).toBe(1_000);
    expect(await f.db.select().from(schema.creditAttempts)).toHaveLength(10);
  }, 60_000);

  test("two servers settling the same attempt close it once", async () => {
    f = await setup();
    const c = await creditFixture({ allocation: 1_000 });
    const [a, b] = await handles(2);
    const held = await admitOn(a as Database, c, 400);
    const outcomes = await Promise.all([
      settleCreditAttempt(a as Database, f.org.id, held.attemptId, { kind: "settled", actualNanoUsd: 120 }, NOW),
      settleCreditAttempt(b as Database, f.org.id, held.attemptId, { kind: "settled", actualNanoUsd: 120 }, NOW),
    ]);
    expect(outcomes.filter((o) => o.changed)).toHaveLength(1);
    const pool = await poolOf(c.poolId);
    expect([pool.heldNanoUsd, pool.spentNanoUsd]).toEqual([0, 120]);
  }, 60_000);

  test("a rotation on one server refuses the next admission on another", async () => {
    f = await setup();
    const c = await creditFixture({ allocation: 1_000 });
    const [other] = await handles(1);
    await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, c.credential.id, {
      apiKey: "sk-ant-synthetic-rotated-2",
    });
    await expect(admitOn(other as Database, c)).rejects.toMatchObject({ reason: "credential_changed" });
    expect((await poolOf(c.poolId)).heldNanoUsd).toBe(0);
  }, 60_000);

  test("a settlement and an admission racing across servers keep the held amount exact", async () => {
    f = await setup();
    const c = await creditFixture({ allocation: 500 });
    const [a, b] = await handles(2);
    const first = await admitOn(a as Database, c, 300);
    const [settled, second] = await Promise.allSettled([
      settleCreditAttempt(a as Database, f.org.id, first.attemptId, { kind: "released", reason: "refused" }, NOW),
      admitOn(b as Database, c, 300),
    ]);
    expect(settled.status).toBe("fulfilled");
    const pool = await poolOf(c.poolId);
    // The second call either saw the hold (refused) or the release (admitted): never both, never a negative.
    expect(pool.heldNanoUsd).toBe(second.status === "fulfilled" ? 300 : 0);
  }, 60_000);

  test("a pool paused on one server stops admissions on every other", async () => {
    f = await setup();
    const c = await creditFixture({ allocation: 1_000 });
    const [other] = await handles(1);
    await f.db.update(schema.creditPools).set({ paused: true });
    await expect(admitOn(other as Database, c)).rejects.toMatchObject({ reason: "paused" });
  }, 60_000);
});
