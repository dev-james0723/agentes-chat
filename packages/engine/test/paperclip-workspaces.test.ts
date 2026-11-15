import { expect, test } from "bun:test";
import { paperclipWorkspaceRegistrationSchema, workspaceAgentMatches } from "../src/paperclip-workspaces";

const agent = {
  id: crypto.randomUUID(),
  orgId: crypto.randomUUID(),
  ownerUserId: "owner",
  machineId: crypto.randomUUID(),
  brain: "codex",
  brainModel: "model-a",
  brainAccountId: null,
  brainFallback: false,
  archivedAt: null,
  deletedAt: null,
  operatorHoldAt: null,
};
const pin = { id: agent.id, brain: "codex" as const, model: "model-a", accountId: null, ownerId: "owner" };
const binding = { orgId: agent.orgId, ownerId: "owner", machineId: agent.machineId, agents: [pin] };
test("project authority pins the exact owner, agent, native model, machine and disabled fallback", () => {
  expect(workspaceAgentMatches(agent, binding)).toBe(true);
  for (const change of [
    { orgId: crypto.randomUUID() },
    { id: crypto.randomUUID() },
    { ownerUserId: "other" },
    { machineId: crypto.randomUUID() },
    { brain: "model" },
    { brain: "antigravity" },
    { brainModel: "model-b" },
    { brainAccountId: crypto.randomUUID() },
    { brainFallback: true },
    { archivedAt: new Date() },
  ])
    expect(workspaceAgentMatches({ ...agent, ...change }, binding)).toBe(false);
});
test("registration rejects unreviewed source paths and permits only exact immutable IDs and digests", () => {
  const input = {
    id: crypto.randomUUID(),
    machineId: agent.machineId,
    generation: crypto.randomUUID(),
    sourceCompanyId: crypto.randomUUID(),
    sourceProjectId: crypto.randomUUID(),
    sourceWorkspaceId: crypto.randomUUID(),
    projectDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    bindingDigest: "c".repeat(64),
    targetCwd: "/target/project",
    agentIds: [agent.id],
  };
  expect(paperclipWorkspaceRegistrationSchema.safeParse(input).success).toBe(true);
  expect(paperclipWorkspaceRegistrationSchema.safeParse({ ...input, sourcePath: "/private" }).success).toBe(false);
  expect(paperclipWorkspaceRegistrationSchema.safeParse({ ...input, targetCwd: "/" }).success).toBe(false);
  expect(paperclipWorkspaceRegistrationSchema.safeParse({ ...input, agentIds: [agent.id, agent.id] }).success).toBe(
    false,
  );
  expect(paperclipWorkspaceRegistrationSchema.safeParse({ ...input, bindingDigest: "bad" }).success).toBe(false);
});
