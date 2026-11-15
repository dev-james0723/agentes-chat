import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createMachineHub, type MachineHub } from "../src";
import { type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";
import { until } from "./stream-fixtures";

let f: Fixture;
let hub: MachineHub;
afterEach(async () => {
  await hub?.stop();
  await f?.close();
});
test("machine hub sends actual transient pixels and stores only a completed receipt; duplicate call never reruns", async () => {
  f = await setup({ machines: true });
  hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "host-media", rpcPollMs: 10 });
  let executions = 0;
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII=";
  hub.setMissionHooks({
    mcp: async () => {
      executions++;
      return { ok: true, text: "pixels", images: [{ mediaType: "image/png", data }] };
    },
  });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "fixture",
    ...RUNNER,
    exec: false,
  });
  const runner = fakeRunner(hub);
  await runner.hello(paired.token);
  const call = { type: "mcp.call", callId: "pixels", taskId: "fixture", tool: "snapshot_ui", args: {} };
  await runner.frame(call);
  await until(() => runner.sent.some((s) => s.type === "mcp.result"), "pixel result");
  expect(runner.sent.find((s) => s.type === "mcp.result")).toMatchObject({
    ok: true,
    images: [{ mediaType: "image/png", data }],
  });
  const kept = await f.db.select().from(schema.machineMcpCalls);
  expect(JSON.stringify(kept)).not.toContain("iVBOR");
  expect(JSON.stringify(kept)).toContain("completed_media_unavailable");
  await runner.frame(call);
  await until(() => runner.sent.filter((s) => s.type === "mcp.result").length === 2, "completed receipt");
  expect(runner.sent.filter((s) => s.type === "mcp.result")[1]).toMatchObject({
    ok: false,
    error: { code: "bridge.completed_media_unavailable" },
  });
  expect(executions).toBe(1);
});

test("a suspended media result retains suspension on replay without persisting media or rerunning", async () => {
  f = await setup({ machines: true });
  hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "suspended-media", rpcPollMs: 10 });
  let executions = 0;
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2ioAAAAASUVORK5CYII=";
  hub.setMissionHooks({
    mcp: async () => {
      executions++;
      return {
        ok: true,
        text: "Waiting",
        images: [{ mediaType: "image/png", data }],
        runState: "suspended",
        imageOmitted: false,
      };
    },
  });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "fixture",
    ...RUNNER,
    exec: false,
  });
  const runner = fakeRunner(hub);
  await runner.hello(paired.token);
  const call = {
    type: "mcp.call",
    callId: "suspended-pixels",
    taskId: "fixture",
    tool: "snapshot_ui",
    args: {},
    requireComplete: true,
  };
  await runner.frame(call);
  await until(() => runner.sent.filter((s) => s.type === "mcp.result").length === 1, "first suspended result");
  await runner.frame(call);
  await until(() => runner.sent.filter((s) => s.type === "mcp.result").length === 2, "replayed suspended result");
  const answers = runner.sent.filter((s) => s.type === "mcp.result");
  expect(answers[0]).toMatchObject({ ok: true, runState: "suspended" });
  expect(answers[1]).toMatchObject({ ok: true, runState: "suspended", imageOmitted: true });
  expect(JSON.stringify(await f.db.select().from(schema.machineMcpCalls))).not.toContain("iVBOR");
  expect(executions).toBe(1);
});
