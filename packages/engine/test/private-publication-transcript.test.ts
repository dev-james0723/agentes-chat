import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { capturePublicationContext } from "../src/private-skill-publication";
import { storedTranscript } from "../src/run-tools";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const fresh = () =>
  capturePublicationContext({
    complete: true,
    channelId: "c",
    triggerMessageId: "m",
    configurationHash: "h",
    sources: [{ id: "m", hash: "h" }],
  });
async function save(current: Record<string, unknown> | null, incoming: object) {
  f = await setup();
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: f.general.id,
      triggerMessageId: f.general.id,
      trigger: "mention",
      hop: 1,
      transcript: current,
    })
    .returning();
  const [updated] = await f.db
    .update(schema.agentRuns)
    .set({ transcript: storedTranscript(incoming) })
    .where(eq(schema.agentRuns.id, run!.id))
    .returning();
  return updated!.transcript;
}
test("ordinary saves preserve current source capture and quota metadata instead of stale memory", async () => {
  const current = { version: 2, complete: false, changed: "current" };
  const result = await save(
    { system: [], publicationCapture: current, metadata: { quotaContinuity: { version: 2 }, other: "current" } },
    {
      system: [],
      messages: [],
      publicationCapture: fresh(),
      metadata: { quotaContinuity: { version: 1 }, other: "stale" },
    },
  );
  expect(result?.publicationCapture).toEqual(current);
  expect(result?.metadata).toEqual({ quotaContinuity: { version: 2 }, other: "current" });
});
test("a current explicit capture invalidation cannot be replaced by an old native object", async () => {
  const result = await save(
    { system: [], publicationCapture: null },
    { system: [], messages: [], publicationCapture: fresh() },
  );
  expect(result?.publicationCapture).toBeUndefined();
});
test("fresh native context may initialize capture before the first transcript is stored", async () => {
  const capture = fresh();
  const result = await save(null, { system: [], messages: [], publicationCapture: capture });
  expect(result?.publicationCapture).toEqual(capture);
});
test("persisted or forged JSON cannot manufacture capture for an unknown legacy transcript", async () => {
  const copied = JSON.parse(JSON.stringify(fresh()));
  const result = await save(
    { system: [] },
    { system: [], messages: [], publicationCapture: copied, metadata: { quotaContinuity: { forged: true } } },
  );
  expect(result?.publicationCapture).toBeUndefined();
  expect(result?.metadata).toBeUndefined();
});
test("an in-place fresh object cannot restore capture removed from an already stored context", async () => {
  const result = await save({ system: [], messages: [] }, { system: [], messages: [], publicationCapture: fresh() });
  expect(result?.publicationCapture).toBeUndefined();
});
