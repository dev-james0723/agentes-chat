import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { consolidateItem, indexSource, postPersonMessage, retrieveForRun } from "../src";
import { type Fixture, setup } from "./fixtures";

/** A35: a pasted secret never reaches memory, the search index or a run's memory pack. */
let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SECRET = "sk-ant-api03-SYNTHETICabcdefghijklmnopqrstuvwxyz0123";

test("a secret pasted in a channel stays out of memory, the search index and the run's pack", async () => {
  f = await setup();
  const said = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: `Remember this, the Orion deploy key is ${SECRET}`,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: said.id });

  await expect(
    consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      content: `The Orion deploy key is ${SECRET}`,
      sourceIds: [said.id],
      channelIds: [f.general.id],
      createdByKind: "agent",
      createdById: f.agent.id,
    }),
  ).rejects.toThrow();
  const items = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.orgId, f.org.id));
  expect(JSON.stringify(items)).not.toContain(SECRET);

  const docs = await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.orgId, f.org.id));
  expect(JSON.stringify(docs)).not.toContain(SECRET);

  const run = await retrieveForRun(f.context, {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    text: "What is the Orion deploy key?",
    personIds: [f.owner.id],
  });
  expect(`${run.text}\n${run.requiredText ?? ""}`).not.toContain(SECRET);
});
