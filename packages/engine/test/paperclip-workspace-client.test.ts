import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runOwnerBoundProjectTurn } from "../src/paperclip-workspace-client";

const input = () => ({
  orgId: randomUUID(),
  machineId: randomUUID(),
  ownerId: "owner-auth-string",
  agent: { id: randomUUID(), handle: "worker" },
  bindingId: randomUUID(),
  generation: randomUUID(),
  targetCwd: "/separate/target",
  bindingDigest: "a".repeat(64),
  turn: {
    kind: "codex",
    runId: randomUUID(),
    session: { id: randomUUID(), resume: false },
    cwd: "/separate/target",
    keepAlive: false,
    system: "",
    prompt: "",
    mcp: { token: "synthetic" },
  },
});
test("server probes, verifies machine reply against owner binding, then dispatches only guarded op", async () => {
  const x = input(),
    conn = randomUUID(),
    calls: string[] = [];
  const hub = {
    status: async () => ({
      orgId: x.orgId,
      pairedByUserId: x.ownerId,
      os: "darwin",
      protocol: 66,
      online: true,
      paused: false,
      execAllowed: true,
    }),
    call: async (_id: string, req: any) => {
      calls.push(req.op);
      if (req.op === "paperclip.workspace.probe") return { version: 1, connectionId: conn };
      if (req.op === "paperclip.workspace.attest")
        return { ...req.proof, targetCwd: x.targetCwd, bindingDigest: x.bindingDigest };
      return { runId: x.turn.runId, final: { type: "done" } };
    },
  };
  const result = await runOwnerBoundProjectTurn({ hub: hub as any, assertAuthorized: async () => true }, x as any);
  expect(calls).toEqual(["paperclip.workspace.probe", "paperclip.workspace.attest", "paperclip.brain.turn"]);
  expect(result.runId).toBe(x.turn.runId);
});
test("old runner, mismatched identity or revoked owner refuse before execution without retry", async () => {
  const x = input();
  let calls = 0;
  const hub = {
    status: async () => ({
      orgId: x.orgId,
      pairedByUserId: x.ownerId,
      os: "darwin",
      protocol: 66,
      online: true,
      paused: false,
      execAllowed: true,
    }),
    call: async (_id: string, req: any) => {
      calls++;
      if (req.op === "paperclip.workspace.probe") return { version: 1, connectionId: randomUUID() };
      if (req.op === "paperclip.workspace.attest")
        return { ...req.proof, targetCwd: "/source", bindingDigest: x.bindingDigest };
      throw Error("should not run");
    },
  };
  await expect(
    runOwnerBoundProjectTurn({ hub: hub as any, assertAuthorized: async () => true }, x as any),
  ).rejects.toThrow();
  expect(calls).toBe(2);
  calls = 0;
  await expect(
    runOwnerBoundProjectTurn(
      {
        hub: {
          ...hub,
          call: async () => {
            calls++;
            throw Error("old runner");
          },
        } as any,
        assertAuthorized: async () => true,
      },
      x as any,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  calls = 0;
  await expect(
    runOwnerBoundProjectTurn({ hub: hub as any, assertAuthorized: async () => false }, x as any),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  calls = 0;
  await expect(
    runOwnerBoundProjectTurn(
      {
        hub: {
          ...hub,
          status: async () => ({
            orgId: x.orgId,
            pairedByUserId: "another",
            os: "darwin",
            protocol: 66,
            online: true,
            execAllowed: true,
          }),
        } as any,
        assertAuthorized: async () => true,
      },
      x as any,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
