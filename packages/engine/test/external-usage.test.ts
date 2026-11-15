import { expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { setup } from "./fixtures";

test("external usage persists a requested alias and incomplete accounting without a schema migration", async () => {
  const f = await setup();
  try {
    const id = await f.gateway.recordExternalUsage({
      orgId: f.org.id,
      provider: "typesafe",
      kind: "router",
      model: "jev-1.14.0",
      requestedModel: "jev-latest",
      inputTokens: 0,
      outputTokens: 0,
      costNanoUsd: 0,
      partial: true,
    });
    if (!id) throw new Error("usage was not persisted");
    const [row] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.id, id));
    expect(row).toMatchObject({ model: "jev-1.14.0", requestedModel: "jev-latest", partial: true });
  } finally {
    await f.close();
  }
});
