import { afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createChallengeGate } from "../../runner/paperclip-challenge";

const ids = () => ({
  bindingId: randomUUID(),
  orgId: randomUUID(),
  machineId: randomUUID(),
  ownerId: "owner-auth-id_Ab12",
  agentId: randomUUID(),
  generation: randomUUID(),
  runId: randomUUID(),
  connectionId: randomUUID(),
});
const nonce = () => randomBytes(32).toString("base64url");
test("a one-shot nonce binds a reviewed local binding to one agent, cwd and run", () => {
  const i = ids(),
    now = Date.now(),
    registered = { id: i.bindingId, version: 1, ...i, target: { real: "/target" } };
  const gate = createChallengeGate({
    paired: { orgId: i.orgId, machineId: i.machineId, ownerId: i.ownerId, connectionId: i.connectionId },
    read: () => registered,
    verify: () => true,
    now: () => now,
  });
  const request = { ...i, nonce: nonce(), expiresAt: now + 10000 };
  const reply = gate.attest(request);
  expect(reply.nonce).toBe(request.nonce);
  expect(reply.targetCwd).toBe("/target");
  expect(reply.runId).toBe(i.runId);
  expect(() => gate.attest(request)).toThrow();
  expect(() => gate.consume({ ...request, runId: randomUUID(), cwd: "/target" })).toThrow();
  expect(() => gate.consume({ ...request, cwd: "/wrong" })).toThrow();
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  expect(gate.consume({ ...reordered, cwd: "/target" } as any)).toBe(true);
  expect(() => gate.consume({ ...request, cwd: "/target" })).toThrow();
  expect(gate.recheck({ ...request, cwd: "/target" })).toBe(true);
  gate.finish(request.nonce);
  expect(() => gate.recheck({ ...request, cwd: "/target" })).toThrow();
});
test("fails closed on remote path injection, mismatch, stale nonce and grant revocation", () => {
  const i = ids(),
    now = Date.now(),
    binding = { id: i.bindingId, version: 1, ...i, target: { real: "/target" } };
  let granted = true;
  const gate = createChallengeGate({
    paired: { orgId: i.orgId, machineId: i.machineId, ownerId: i.ownerId, connectionId: i.connectionId },
    read: () => binding,
    verify: () => {
      if (!granted) throw Error();
      return true;
    },
    now: () => now,
  });
  expect(() => gate.attest({ ...i, nonce: nonce(), expiresAt: now + 10000, sourcePath: "/secrets" } as any)).toThrow();
  expect(() => gate.attest({ ...i, machineId: randomUUID(), nonce: nonce(), expiresAt: now + 10000 })).toThrow();
  expect(() => gate.attest({ ...i, connectionId: randomUUID(), nonce: nonce(), expiresAt: now + 10000 })).toThrow();
  expect(() => gate.attest({ ...i, nonce: nonce(), expiresAt: now - 1 })).toThrow();
  const request = { ...i, nonce: nonce(), expiresAt: now + 10000 };
  gate.attest(request);
  granted = false;
  expect(() => gate.consume({ ...request, cwd: "/target" })).toThrow();
});
test("connection loss invalidates outstanding authority", () => {
  const i = ids(),
    now = Date.now(),
    binding = { id: i.bindingId, version: 1, ...i, target: { real: "/target" } };
  const gate = createChallengeGate({
    paired: { orgId: i.orgId, machineId: i.machineId, ownerId: i.ownerId, connectionId: i.connectionId },
    read: () => binding,
    verify: () => true,
    now: () => now,
  });
  const request = { ...i, nonce: nonce(), expiresAt: now + 10000 };
  gate.attest(request);
  gate.clear();
  expect(() => gate.consume({ ...request, cwd: "/target" })).toThrow();
});
