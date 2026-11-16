import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  consolidateByMeaning,
  consolidateItem,
  consolidateOrg,
  createFakeJudge,
  editContextItem,
  ForbiddenError,
  insertContextItem,
  type NewContextItem,
  ValidationError,
} from "../src";
import { supersede } from "../src/context/items";
import { findCandidates } from "../src/context/judgments";
import { addMember, type Fixture, setup } from "./fixtures";

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
  channelIds: [f.general.id],
  createdByKind: "person",
  createdById: f.owner.id,
  evidence: [{ type: "human", ref: f.owner.id, at: new Date().toISOString() }],
  ...patch,
});
const rows = () => f.db.select().from(schema.contextItems);

describe("native memory revisions", () => {
  test("a stale snapshot cannot fork an already superseded item", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, input("Orion runs in Paris."));
    const current = await f.db.transaction((tx) => supersede(tx, old, input("Orion runs in Tokyo.")));
    await expect(f.db.transaction((tx) => supersede(tx, old, input("Orion runs in Rome.")))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await rows()).filter((r) => r.status === "active").map((r) => r.id)).toEqual([current.id]);
    expect(await rows()).toHaveLength(2);
  });

  test("two writers with one version produce exactly one accepted successor", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, input("Orion runs in Paris."));
    const results = await Promise.allSettled([
      f.db.transaction((tx) => supersede(tx, old, input("Orion runs in Tokyo."))),
      f.db.transaction((tx) => supersede(tx, old, input("Orion runs in Rome."))),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const denied = results.find((r) => r.status === "rejected");
    expect(denied?.status === "rejected" && denied.reason instanceof ConflictError).toBe(true);
    expect((await rows()).filter((r) => r.status === "active")).toHaveLength(1);
    expect(await rows()).toHaveLength(2);
  });

  test("a stale snapshot cannot overwrite a newer in-place revision", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, input("Orion runs in Paris."));
    await f.db
      .update(schema.contextItems)
      .set({ content: "Orion runs in Lima.", updatedAt: new Date(old.updatedAt.getTime() + 1000) })
      .where(eq(schema.contextItems.id, old.id));
    await expect(f.db.transaction((tx) => supersede(tx, old, input("Orion runs in Rome.")))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await rows())[0]?.content).toBe("Orion runs in Lima.");
    expect(await rows()).toHaveLength(1);
  });

  test("supersession refuses another organization before writing", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, input("Orion runs in Paris."));
    const otherOrg = crypto.randomUUID();
    await f.db.insert(schema.organizations).values({ id: otherOrg, name: "Other workspace" });
    await expect(
      f.db.transaction((tx) =>
        supersede(tx, old, input("Other workspace decision.", { orgId: otherOrg, agentId: null })),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await rows()).toHaveLength(1);
  });

  test("native edits reject an unexpected version without leaving an orphan", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, input("Orion runs in Paris."));
    const patch = { content: "Orion runs in Tokyo.", expectedVersion: old.version + 1 };
    await expect(editContextItem(f.db, f.owner.id, f.org.id, old.id, patch)).rejects.toBeInstanceOf(ConflictError);
    expect(await rows()).toHaveLength(1);
  });

  test("a title-only edit is an immutable new version", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, input("Orion runs in Paris.", { title: "Old title" }));
    const next = await editContextItem(f.db, f.owner.id, f.org.id, old.id, { title: "Corrected title" });
    expect(next.id).not.toBe(old.id);
    expect(next.title).toBe("Corrected title");
    expect(next.content).toBe(old.content);
    expect(next.version).toBe(old.version + 1);
    const before = (await rows()).find((r) => r.id === old.id);
    expect(before?.title).toBe("Old title");
    expect(before?.supersededBy).toBe(next.id);
  });

  test("permission checks precede version conflict details", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "member");
    const old = await insertContextItem(f.db, input("Orion runs in Paris."));
    const patch = { content: "Orion runs in Tokyo.", expectedVersion: 999 };
    await expect(editContextItem(f.db, member.id, f.org.id, old.id, patch)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await rows()).toHaveLength(1);
  });
});

describe("consolidation identity and evidence", () => {
  test("same-name entities in different projects never overwrite each other", async () => {
    f = await setup();
    const first = await consolidateItem(
      f.db,
      input("AuthModule uses a local socket.", { scopeType: "entity", scopeId: "repo-a:AuthModule" }),
    );
    const second = await consolidateItem(
      f.db,
      input("AuthModule uses a network API.", { scopeType: "entity", scopeId: "repo-b:AuthModule" }),
    );
    expect(second.action).toBe("created");
    expect((await rows()).find((r) => r.id === first.item.id)?.status).toBe("active");
    expect(second.item.scopeId).toBe("repo-b:AuthModule");
  });

  test("semantic candidate selection does not disclose another entity's memory", async () => {
    f = await setup();
    await insertContextItem(
      f.db,
      input("AuthModule uses a local socket.", { scopeType: "entity", scopeId: "repo-a:AuthModule" }),
    );
    expect(
      await findCandidates(
        f.db,
        input("AuthModule uses a network API.", { scopeType: "entity", scopeId: "repo-b:AuthModule" }),
      ),
    ).toEqual([]);
  });

  test("two equally authoritative agent claims remain disputed", async () => {
    f = await setup();
    const own = {
      createdByKind: "agent" as const,
      createdById: f.agent.id,
      evidence: [{ type: "self" as const, ref: "observation-a", agentId: f.agent.id, at: new Date().toISOString() }],
    };
    const first = await consolidateItem(f.db, input("Orion runs in Paris.", own));
    const second = await consolidateItem(
      f.db,
      input("Orion runs in Tokyo.", { ...own, evidence: [{ ...own.evidence[0], ref: "observation-b" }] }),
    );
    expect(second.action).toBe("disputed");
    expect((await rows()).find((r) => r.id === first.item.id)?.status).toBe("active");
    expect((await rows()).filter((r) => r.disputed)).toHaveLength(2);
  });

  test("a negation is not silently merged by word overlap", async () => {
    f = await setup();
    const first = await consolidateItem(
      f.db,
      input("Orion releases are allowed every Friday after the review completes."),
    );
    const second = await consolidateItem(
      f.db,
      input("Orion releases are not allowed every Friday after the review completes."),
    );
    expect(second.action).toBe("superseded");
    expect(second.item.content).toContain("not allowed");
    expect(second.item.id).not.toBe(first.item.id);
  });

  test("the same owner's explicit correction is accepted and keeps the previous claim", async () => {
    f = await setup();
    const first = await consolidateItem(f.db, input("Orion runs in Paris."));
    const second = await consolidateItem(f.db, input("Orion runs in Tokyo."));
    expect(second.action).toBe("superseded");
    expect(second.item.version).toBe(2);
    expect((await rows()).find((r) => r.id === first.item.id)?.content).toBe("Orion runs in Paris.");
  });
});

describe("maintenance preserves unresolved and separate claims", () => {
  test("periodic duplicate cleanup preserves a negation", async () => {
    f = await setup();
    const yes = await insertContextItem(
      f.db,
      input("Orion releases are allowed every Friday after the review completes."),
    );
    const no = await insertContextItem(
      f.db,
      input("Orion releases are not allowed every Friday after the review completes."),
    );
    await consolidateOrg(f.context, f.org.id);
    const active = (await rows()).filter((r) => r.status === "active").map((r) => r.id);
    expect(active).toContain(yes.id);
    expect(active).toContain(no.id);
  });

  test("periodic duplicate cleanup preserves same text in different project scopes", async () => {
    f = await setup();
    await insertContextItem(
      f.db,
      input("AuthModule uses a local socket.", { scopeType: "entity", scopeId: "repo-a:AuthModule" }),
    );
    await insertContextItem(
      f.db,
      input("AuthModule uses a local socket.", { scopeType: "entity", scopeId: "repo-b:AuthModule" }),
    );
    await consolidateOrg(f.context, f.org.id);
    expect((await rows()).filter((r) => r.status === "active")).toHaveLength(2);
  });

  test("semantic contradictions do not pick the newer of equally supported agent claims", async () => {
    f = await setup();
    const own = {
      createdByKind: "agent" as const,
      createdById: f.agent.id,
      evidence: [{ type: "self" as const, ref: "a", at: new Date().toISOString() }],
    };
    await insertContextItem(f.db, input("Orion runs in Paris.", own));
    const judge = createFakeJudge((kind) => (kind === "memory_relation" ? "contradicts" : undefined));
    const next = await consolidateItem(f.db, input("Orion runs in Tokyo.", own), { judge, semantic: true });
    expect(next.action).toBe("disputed");
    expect((await rows()).filter((r) => r.status === "active")).toHaveLength(2);
  });

  test("daily semantic cleanup preserves equally supported contradictory claims", async () => {
    f = await setup({ judge: (kind) => (kind === "memory_relation" ? "contradicts" : undefined) });
    const own = {
      createdByKind: "agent" as const,
      createdById: f.agent.id,
      evidence: [{ type: "self" as const, ref: "a", at: new Date().toISOString() }],
    };
    await insertContextItem(f.db, input("Orion runs in Paris.", own));
    await insertContextItem(f.db, input("Orion runs in Tokyo.", own));
    await consolidateByMeaning(f.context, f.org.id);
    expect((await rows()).filter((r) => r.status === "active" && r.disputed)).toHaveLength(2);
  });
});
