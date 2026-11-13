import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPaperclipGateway } from "../../runner/paperclip-gateway";

test("unregistered bindings are refused and reconnect changes the capability session", async () => {
  const gateway = createPaperclipGateway({
    runnerHome: "/nonexistent",
    workspaceReal: "/nonexistent",
    orgId: randomUUID(),
    machineId: randomUUID(),
    access: () => ({ tools: { commands: true }, folders: [] }) as any,
  });
  const before = gateway.probe();
  expect(before.version).toBe(1);
  gateway.reset();
  expect(gateway.probe().connectionId).not.toBe(before.connectionId);
  const a = { id: randomUUID(), handle: "a" };
  const proof = {
    bindingId: randomUUID(),
    orgId: randomUUID(),
    machineId: randomUUID(),
    ownerId: randomUUID(),
    agentId: a.id,
    generation: randomUUID(),
    runId: randomUUID(),
    connectionId: gateway.probe().connectionId,
    nonce: "a".repeat(43),
    expiresAt: Date.now() + 10000,
  };
  await expect(gateway.attest({ op: "paperclip.workspace.attest", agent: a, proof })).rejects.toThrow();
});
