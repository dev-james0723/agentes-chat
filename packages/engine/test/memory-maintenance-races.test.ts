import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { consolidateByMeaning, consolidateItem, createFakeJudge, insertContextItem } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});
const input = (content: string) => ({
  orgId: f.org.id,
  agentId: f.agent.id,
  kind: "note" as const,
  scopeType: "agent" as const,
  scopeId: f.agent.id,
  subject: "literal output",
  content,
  channelIds: [f.general.id],
  createdByKind: "agent" as const,
  createdById: f.agent.id,
  evidence: [{ type: "self" as const, ref: "a", at: new Date().toISOString() }],
});
test("quoted spaces are data, not automatic duplicate normalization", async () => {
  f = await setup();
  const a = await consolidateItem(f.db, input('printf "a b"'));
  const b = await consolidateItem(f.db, input('printf "a  b"'));
  expect(b.action).toBe("disputed");
  expect(b.item.content).toBe('printf "a  b"');
  expect(b.item.id).not.toBe(a.item.id);
});
test("daily semantic job rechecks the candidate it judged before archiving its target", async () => {
  f = await setup();
  const old = await insertContextItem(f.db, input("The old Orion method."));
  const fresh = await insertContextItem(f.db, input("The new Orion method."));
  await f.db
    .update(schema.contextItems)
    .set({ createdAt: new Date(Date.now() - 60000) })
    .where(eq(schema.contextItems.id, old.id));
  const base = createFakeJudge((kind) => (kind === "memory_relation" ? "updates" : undefined));
  let changed = false;
  const judge = {
    name: "fixture-race",
    ask: async (request: Parameters<typeof base.ask>[0]) => {
      if (request.kind === "memory_relation" && !changed) {
        changed = true;
        await f.db
          .update(schema.contextItems)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(schema.contextItems.id, fresh.id));
      }
      return base.ask(request);
    },
  };
  await consolidateByMeaning({ ...f.context, judge }, f.org.id);
  const rows = await f.db.select().from(schema.contextItems);
  expect(changed).toBe(true);
  expect(rows.find((i) => i.id === old.id)?.status).toBe("active");
  expect(rows.find((i) => i.id === old.id)?.supersededBy).toBeNull();
});
