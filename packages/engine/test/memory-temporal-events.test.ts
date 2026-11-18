import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  consolidateItem,
  insertContextItem,
  memoryViewAt,
  type NewContextItem,
  toMemoryEnvelope,
  ValidationError,
} from "../src";
import { supersede } from "../src/context/items";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const input = (content: string, patch: Partial<NewContextItem> = {}): NewContextItem => ({
  orgId: f.org.id,
  kind: "fact",
  scopeType: "agent",
  scopeId: f.agent.id,
  agentId: f.agent.id,
  subject: "Orion release region",
  content,
  sourceIds: [f.general.id],
  channelIds: [f.general.id],
  createdByKind: "person",
  createdById: f.owner.id,
  evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
  ...patch,
});
const rows = () => f.db.select().from(schema.contextItems);
const tick = () => Bun.sleep(5);

describe("validity and source revision are stored natively (A07)", () => {
  test("validity, source revision and supersession time round-trip and reach the envelope", async () => {
    f = await setup();
    const validFrom = new Date("2026-01-01T00:00:00.000Z");
    const validTo = new Date("2026-03-01T00:00:00.000Z");
    const old = await insertContextItem(
      f.db,
      input("Orion runs in Paris.", { validFrom, validTo, sourceRevision: "msg@3" }),
    );
    expect(old.validFrom?.toISOString()).toBe(validFrom.toISOString());
    expect(old.validTo?.toISOString()).toBe(validTo.toISOString());
    expect(old.sourceRevision).toBe("msg@3");
    expect(old.supersededAt).toBeNull();
    const env = toMemoryEnvelope(old);
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.value.validFrom).toBe(validFrom.toISOString());
    expect(env.value.validTo).toBe(validTo.toISOString());
    expect(env.value.sourceRevision).toBe("msg@3");
    expect(env.value.unmappedFields).not.toContain("validFrom");
    expect(env.value.unmappedFields).not.toContain("sourceRevision");

    await tick();
    const next = await f.db.transaction((tx) => supersede(tx, old, input("Orion runs in Tokyo.")));
    const [archived] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, old.id));
    expect(archived?.supersededBy).toBe(next.id);
    expect(archived?.supersededAt).toBeInstanceOf(Date);
    // One clock: the database's transaction time for both the successor's record and the supersession.
    expect(archived?.supersededAt?.getTime()).toBe(next.createdAt.getTime());
  });

  test("a validity window that ends before it starts is refused", async () => {
    f = await setup();
    await expect(
      insertContextItem(
        f.db,
        input("Orion runs in Paris.", {
          validFrom: new Date("2026-03-01T00:00:00Z"),
          validTo: new Date("2026-01-01T00:00:00Z"),
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await rows()).toHaveLength(0);
  });
});

describe("historical views keep valid time and known time apart (A07)", () => {
  test("a late-arriving correction changes today's view but not the earlier audit view", async () => {
    f = await setup();
    const v1 = await insertContextItem(
      f.db,
      input("Orion runs in Paris.", { validFrom: new Date("2026-01-01T00:00:00Z") }),
    );
    await tick();
    const knownBefore = new Date();
    await tick();
    const v2 = await f.db.transaction((tx) =>
      supersede(tx, v1, input("Orion runs in Tokyo.", { validFrom: new Date("2026-02-01T00:00:00Z") })),
    );
    const all = await rows();

    const then = memoryViewAt(all, { knownAt: knownBefore });
    expect(then.map((i) => i.id)).toEqual([v1.id]);
    expect(then[0]?.content).toBe("Orion runs in Paris.");

    const now = memoryViewAt(all, { knownAt: new Date() });
    expect(now.map((i) => i.id)).toEqual([v2.id]);

    // What we know now about mid-January: the corrected row only starts in February.
    expect(memoryViewAt(all, { knownAt: new Date(), asOf: new Date("2026-01-15T00:00:00Z") })).toEqual([]);
    // What we knew then about mid-January: Paris.
    expect(
      memoryViewAt(all, { knownAt: knownBefore, asOf: new Date("2026-01-15T00:00:00Z") }).map((i) => i.id),
    ).toEqual([v1.id]);
  });

  test("validity bounds are half-open and unknown bounds are unbounded", async () => {
    f = await setup();
    const bounded = await insertContextItem(
      f.db,
      input("Orion runs in Paris.", {
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validTo: new Date("2026-02-01T00:00:00Z"),
      }),
    );
    const open = await insertContextItem(f.db, input("Orion's owner is Mason.", { subject: "Orion owner" }));
    const all = await rows();
    const at = (iso: string) =>
      memoryViewAt(all, { asOf: new Date(iso) })
        .map((i) => i.id)
        .sort();
    expect(at("2026-01-01T00:00:00Z")).toEqual([bounded.id, open.id].sort());
    expect(at("2026-02-01T00:00:00Z")).toEqual([open.id]);
    expect(at("2025-12-31T23:59:59Z")).toEqual([open.id]);
  });

  test("a superseded row without a recorded supersession time is left out of every known-time view", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, input("Orion runs in Paris."));
    await tick();
    const next = await f.db.transaction((tx) => supersede(tx, old, input("Orion runs in Tokyo.")));
    await f.db.update(schema.contextItems).set({ supersededAt: null }).where(eq(schema.contextItems.id, old.id));
    const all = await rows();
    expect(memoryViewAt(all, { knownAt: old.createdAt }).map((i) => i.id)).toEqual([]);
    expect(memoryViewAt(all, { knownAt: new Date() }).map((i) => i.id)).toEqual([next.id]);
  });
});

describe("a producer event has one receipt and one effect (A15)", () => {
  test("a repeated event returns the same receipt without touching memory again", async () => {
    f = await setup();
    const first = await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "learn:run-1:0" }));
    const before = await rows();
    const again = await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "learn:run-1:0" }));
    expect(again.replayed).toBe(true);
    expect(again.action).toBe(first.action);
    expect(again.item.id).toBe(first.item.id);
    const after = await rows();
    expect(after).toEqual(before);
    expect(after[0]?.recurrence).toBe(1);
  });

  test("a replay delivered after a later event keeps the first receipt and changes nothing", async () => {
    f = await setup();
    const a = await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "evt-a" }));
    await tick();
    const b = await consolidateItem(
      f.db,
      input("Orion's owner is Mason.", { subject: "Orion owner", eventKey: "evt-b" }),
    );
    const before = await rows();
    const replay = await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "evt-a" }));
    expect(replay).toMatchObject({ replayed: true, action: a.action, item: { id: a.item.id } });
    expect(b.item.id).not.toBe(a.item.id);
    expect(await rows()).toEqual(before);
  });

  test("simultaneous deliveries of one event apply once", async () => {
    f = await setup();
    const results = await Promise.all([
      consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "evt-race" })),
      consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "evt-race" })),
    ]);
    expect(new Set(results.map((r) => r.item.id)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.recurrence).toBe(1);
  });

  test("the same event key in another organization is a different event", async () => {
    f = await setup();
    const other = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
    const otherOrg = other[0];
    if (!otherOrg) throw new Error("no org");
    await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "shared-key" }));
    const res = await consolidateItem(f.db, {
      orgId: otherOrg.id,
      kind: "fact",
      scopeType: "org",
      subject: "Orion release region",
      content: "Orion runs in Paris.",
      createdByKind: "job",
      eventKey: "shared-key",
    });
    expect(res.replayed).toBeUndefined();
    expect(res.item.orgId).toBe(otherOrg.id);
  });

  test("an event key reused for another scope or other content is refused, not answered with someone else's memory", async () => {
    f = await setup();
    await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "msg-1" }));
    await expect(
      consolidateItem(
        f.db,
        input("Orion runs in Paris.", { eventKey: "msg-1", scopeId: f.owner.id, scopeType: "person", agentId: null }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(consolidateItem(f.db, input("Orion runs in Rome.", { eventKey: "msg-1" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await rows()).toHaveLength(1);
  });

  test("a replay after the memory was replaced returns the current version", async () => {
    f = await setup();
    const first = await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "evt-c" }));
    await tick();
    const next = await f.db.transaction((tx) => supersede(tx, first.item, input("Orion runs in Tokyo.")));
    const replay = await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "evt-c" }));
    expect(replay.replayed).toBe(true);
    expect(replay.item.id).toBe(next.id);
    expect(replay.item.status).toBe("active");
  });

  test("a rejected write leaves no receipt, so a corrected retry still applies", async () => {
    f = await setup();
    await expect(consolidateItem(f.db, input("password: hunter2hunter2", { eventKey: "evt-x" }))).rejects.toThrow();
    expect(await f.db.select().from(schema.contextItemEvents)).toHaveLength(0);
    const ok = await consolidateItem(f.db, input("Orion runs in Paris.", { eventKey: "evt-x" }));
    expect(ok.replayed).toBeUndefined();
    expect(ok.action).toBe("created");
  });
});
