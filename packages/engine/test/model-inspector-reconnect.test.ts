import { afterEach, expect, test } from "bun:test";
import type { OwnPlanUsage, PlanUsage } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { storeOwnUsage } from "../src/machine-accounts";
import { type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
  f = undefined;
});

async function fixture() {
  const fx = await setup({ machines: true });
  f = fx;
  const hub = fx.machineHub;
  if (!hub) throw new Error("Missing machine hub");
  const { machineId, token } = await pairMachine(fx, fx.owner.id, fx.org.id);
  const now = Date.now();
  const refused: PlanUsage = {
    source: "turn",
    limited: true,
    windows: [],
    at: new Date(now - 10 * 60_000).toISOString(),
  };
  const codex: PlanUsage = {
    source: "probe",
    at: new Date(now - 60_000).toISOString(),
    windows: [{ kind: "five_hour", usedPercent: 4 }],
  };
  await storeOwnUsage(fx, fx.org.id, machineId, { grok: refused, codex });
  const hello = async (ownUsage?: OwnPlanUsage) => {
    const runner = fakeRunner(hub);
    await runner.hello(token, {
      executors: { grok: { version: "1.0.70" } },
      ...(ownUsage ? { ownUsage } : {}),
    });
    expect(runner.sent.some((frame) => frame.type === "welcome")).toBe(true);
  };
  const stored = async () => {
    const [row] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
    return row?.executors.ownUsage;
  };
  return { fx, machineId, now, refused, codex, hello, stored };
}

test("reconnect hello preserves an own Grok refusal until strictly newer measured availability", async () => {
  const { now, refused, codex, hello, stored } = await fixture();
  await hello();
  expect(await stored()).toEqual({ grok: refused, codex });
  const measured: PlanUsage = {
    source: "probe",
    at: new Date(now - 60_000).toISOString(),
    windows: [{ kind: "other", usedPercent: 20 }],
  };
  for (const usage of [
    { source: "probe" as const, at: measured.at, windows: [] },
    { source: "turn" as const, at: measured.at, windows: [] },
    { ...measured, at: refused.at },
    { ...measured, at: new Date(now - 11 * 60_000).toISOString() },
    { ...measured, at: new Date(now + 60_000).toISOString() },
  ]) {
    await hello({ grok: usage });
    expect(await stored()).toEqual({ grok: refused, codex });
  }
  await hello({ grok: measured });
  expect(await stored()).toEqual({ grok: measured, codex });
}, 30_000);

test("reconnect metadata cannot overwrite a newer own Grok refusal after authentication", async () => {
  const { fx, machineId, now, refused, codex, hello, stored } = await fixture();
  const newest: PlanUsage = { ...refused, at: new Date(now - 1_000).toISOString() };
  const staleRoom: PlanUsage = {
    source: "probe",
    at: new Date(now - 60_000).toISOString(),
    windows: [{ kind: "other", usedPercent: 20 }],
  };
  // PGlite uses one connection. Capture authentication's old row, then commit a real
  // newer usage report before hello writes its executor metadata.
  type Client = { query: (text: string, ...args: unknown[]) => Promise<unknown> };
  const client = (fx.db as unknown as { $client: Client }).$client;
  const query = client.query;
  let injected = false;
  client.query = async (text, ...args) => {
    const result = await query.call(client, text, ...args);
    if (!injected && text.startsWith("select") && text.includes('from "machines"') && text.includes('"token_hash"')) {
      injected = true;
      await query.call(client, "update machines set executors = executors || $1::jsonb where id = $2::uuid", [
        JSON.stringify({ ownUsage: { grok: newest, codex } }),
        machineId,
      ]);
    }
    return result;
  };
  try {
    await hello({ grok: staleRoom });
  } finally {
    client.query = query;
  }
  expect(injected).toBe(true);
  expect(await stored()).toEqual({ grok: newest, codex });
}, 30_000);
