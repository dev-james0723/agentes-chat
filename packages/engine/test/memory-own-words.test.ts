import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertContextItem, type NewContextItem, openDm, postPersonMessage } from "../src";
import { personsOwnWords } from "../src/context/memory-visibility";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const said = async (userId: string, body: string) => {
  const dm = await openDm(f.db, userId, f.org.id, { agentId: f.agent.id });
  return postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, dm.id, { body });
};

const pref = (person: string, sourceId: string, patch: Partial<NewContextItem> = {}): NewContextItem => ({
  orgId: f.org.id,
  kind: "preference",
  scopeType: "person",
  scopeId: person,
  agentId: f.agent.id,
  content: "A viagem de outubro não pode chegar à equipe.",
  sourceIds: [sourceId],
  channelIds: [],
  trust: "high",
  createdByKind: "agent",
  createdById: f.agent.id,
  ...patch,
});

describe("a person's own everywhere preference follows only their runs", () => {
  test("their own live message: kept for their runs, never for someone else's", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const msg = await said(f.owner.id, "guarda isso: a viagem fica entre a gente");
    const item = await insertContextItem(f.db, pref(f.owner.id, msg.id));
    expect([...(await personsOwnWords(f.db, f.org.id, [f.owner.id], [item]))]).toEqual([item.id]);
    expect((await personsOwnWords(f.db, f.org.id, [bob.id], [item])).size).toBe(0);
  });

  test("words someone else wrote, a deleted source, a channel-bound or low-trust item never pass", async () => {
    f = await setup();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const bobs = await said(bob.id, "a viagem do dono fica entre a gente");
    const notTheirs = await insertContextItem(f.db, pref(f.owner.id, bobs.id));

    const mine = await said(f.owner.id, "guarda isso");
    const deleted = await insertContextItem(f.db, pref(f.owner.id, mine.id, { subject: "deleted source" }));
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, mine.id));

    const live = await said(f.owner.id, "guarda isso também");
    const bound = await insertContextItem(
      f.db,
      pref(f.owner.id, live.id, { subject: "bound", channelIds: [f.general.id] }),
    );
    const low = await insertContextItem(f.db, pref(f.owner.id, live.id, { subject: "low", trust: "low" }));

    const kept = await personsOwnWords(f.db, f.org.id, [f.owner.id], [notTheirs, deleted, bound, low]);
    expect(kept.size).toBe(0);
  });
});
