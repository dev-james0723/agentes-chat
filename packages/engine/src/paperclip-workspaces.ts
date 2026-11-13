import { randomBytes, randomUUID } from "node:crypto";
import { PAPERCLIP_WORKSPACE_PROTOCOL } from "@agenteschat/adapters/machine-protocol";
import { and, type Database, type Executor, eq, schema } from "@agenteschat/db";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { MachineCaller } from "./machine-hub";
import { requireChangePermission } from "./organizations";

const { paperclipWorkspaceBindings: bindings, agents, machines } = schema;
export type WorkspaceBinding = typeof bindings.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Pin = WorkspaceBinding["agents"][number];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const paperclipWorkspaceRegistrationSchema = z.strictObject({
  id: z.uuid(),
  machineId: z.uuid(),
  generation: z.uuid(),
  sourceCompanyId: z.uuid(),
  sourceProjectId: z.uuid(),
  sourceWorkspaceId: z.uuid(),
  projectDigest: digest,
  snapshotDigest: digest,
  bindingDigest: digest,
  targetCwd: z
    .string()
    .min(2)
    .max(4096)
    .refine((value) => value.startsWith("/") && !value.includes("\0")),
  agentIds: z
    .array(z.uuid())
    .min(1)
    .max(32)
    .refine((a) => new Set(a).size === a.length),
});
type Registration = z.infer<typeof paperclipWorkspaceRegistrationSchema>;
export type PaperclipWorkspaceDeps = { db: Database; hub?: Pick<MachineCaller, "call" | "status">; enabled?: boolean };
const unavailable = (): never => {
  throw new ValidationError("Registered project workspace is unavailable or changed", "paperclip.workspace_changed");
};
const feature = (d: PaperclipWorkspaceDeps) => {
  if (d.enabled !== true) throw new ForbiddenError("Paperclip routine compatibility is disabled");
};
export function workspaceAgentMatches(
  a: Pick<
    Agent,
    "id" | "orgId" | "ownerUserId" | "machineId" | "brain" | "brainModel" | "brainAccountId" | "brainFallback"
  > &
    Partial<Pick<Agent, "archivedAt" | "deletedAt" | "operatorHoldAt">>,
  b: Pick<WorkspaceBinding, "orgId" | "machineId" | "ownerId" | "agents">,
): boolean {
  const pin = b.agents.find((p) => p.id === a.id);
  return Boolean(
    pin &&
      a.orgId === b.orgId &&
      a.machineId === b.machineId &&
      a.ownerUserId === b.ownerId &&
      pin.ownerId === b.ownerId &&
      ["claude_code", "codex"].includes(a.brain) &&
      a.brain === pin.brain &&
      a.brainModel === pin.model &&
      Boolean(pin.model) &&
      a.brainAccountId === pin.accountId &&
      a.brainFallback === false &&
      !a.archivedAt &&
      !a.deletedAt &&
      !a.operatorHoldAt,
  );
}
async function owner(db: Executor, actorId: string, orgId: string) {
  const member = await requireChangePermission(db as Database, actorId, orgId, "manage_routines");
  if (member.role !== "owner") throw new ForbiddenError("Only the workspace owner may register project execution");
}
/** Re-read current server identities; native folder grants and inode identity are checked by the runner. */
export async function assertWorkspaceBinding(
  db: Executor,
  input: {
    orgId: string;
    bindingId: string;
    ownerId: string | null;
    sourceCompanyId: string;
    projectId: string | null;
    workspaceId: string | null;
    agentId: string;
  },
  lock = false,
): Promise<WorkspaceBinding> {
  const query = db
    .select()
    .from(bindings)
    .where(and(eq(bindings.orgId, input.orgId), eq(bindings.id, input.bindingId)));
  const [b] = await (lock ? query.for("share") : query);
  if (
    !b ||
    !b.enabled ||
    !input.ownerId ||
    b.ownerId !== input.ownerId ||
    b.sourceCompanyId !== input.sourceCompanyId ||
    b.sourceProjectId !== input.projectId ||
    b.sourceWorkspaceId !== input.workspaceId
  )
    return unavailable();
  await owner(db, b.ownerId, b.orgId);
  const aq = db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, b.orgId), eq(agents.id, input.agentId)));
  const mq = db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, b.orgId), eq(machines.id, b.machineId)));
  const [a] = await (lock ? aq.for("share") : aq);
  const [m] = await (lock ? mq.for("share") : mq);
  if (
    !a ||
    !workspaceAgentMatches(a, b) ||
    !m ||
    m.pairedByUserId !== b.ownerId ||
    m.os !== "darwin" ||
    m.kind !== "connected" ||
    m.deletedAt
  )
    return unavailable();
  return b;
}
export async function assertMappingWorkspace(
  db: Executor,
  m: typeof schema.paperclipRoutineMappings.$inferSelect,
  lock = false,
) {
  const d = m.definition;
  if (d.projectId === null && d.projectWorkspaceId === null && !d.workspaceBindingId) return null;
  if (!d.workspaceBindingId || !d.projectId || !d.projectWorkspaceId) return unavailable();
  return assertWorkspaceBinding(
    db,
    {
      orgId: m.orgId,
      bindingId: d.workspaceBindingId,
      ownerId: m.createdByUserId,
      sourceCompanyId: m.sourceCompanyId,
      projectId: d.projectId,
      workspaceId: d.projectWorkspaceId,
      agentId: m.agentId,
    },
    lock,
  );
}
/** An immutable server registration succeeds only after every requested agent proves its owner-local record. */
export async function registerPaperclipWorkspace(
  deps: PaperclipWorkspaceDeps,
  actorId: string,
  orgId: string,
  value: unknown,
) {
  feature(deps);
  await owner(deps.db, actorId, orgId);
  const parsed = paperclipWorkspaceRegistrationSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid project workspace registration");
  const input = parsed.data;
  if (!deps.hub) return unavailable();
  const status = await deps.hub.status(input.machineId);
  if (
    !status ||
    !status.online ||
    status.paused ||
    !status.execAllowed ||
    status.orgId !== orgId ||
    status.pairedByUserId !== actorId ||
    status.os !== "darwin" ||
    status.protocol < PAPERCLIP_WORKSPACE_PROTOCOL
  )
    return unavailable();
  const pins: Pin[] = [];
  for (const id of input.agentIds) {
    const [a] = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, id)));
    if (!a || !["claude_code", "codex"].includes(a.brain) || !a.brainModel) return unavailable();
    const pin: Pin = {
      id,
      ownerId: actorId,
      brain: a.brain as Pin["brain"],
      model: a.brainModel,
      accountId: a.brainAccountId,
    };
    if (!workspaceAgentMatches(a, { orgId, ownerId: actorId, machineId: input.machineId, agents: [pin] }))
      return unavailable();
    const probe = await deps.hub.call(input.machineId, { op: "paperclip.workspace.probe" }, { timeoutMs: 5000 });
    const proof = {
      orgId,
      machineId: input.machineId,
      ownerId: actorId,
      bindingId: input.id,
      generation: input.generation,
      agentId: id,
      runId: randomUUID(),
      connectionId: probe.connectionId,
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 15000,
    };
    const got = await deps.hub.call(
      input.machineId,
      { op: "paperclip.workspace.attest", agent: { id, handle: a.handle }, proof },
      { timeoutMs: 10000 },
    );
    if (
      probe.version !== 1 ||
      got.nonce !== proof.nonce ||
      got.runId !== proof.runId ||
      got.bindingId !== input.id ||
      got.generation !== input.generation ||
      !sameRegistration(got, input)
    )
      return unavailable();
    pins.push(pin);
  }
  return deps.db.transaction(async (tx) => {
    await owner(tx, actorId, orgId);
    const [created] = await tx
      .insert(bindings)
      .values({ ...input, orgId, ownerId: actorId, agents: pins })
      .onConflictDoNothing()
      .returning();
    if (!created) throw new ConflictError("Project binding already exists; register a new local UUID instead");
    for (const id of input.agentIds)
      await assertWorkspaceBinding(
        tx,
        {
          orgId,
          bindingId: created.id,
          ownerId: actorId,
          sourceCompanyId: input.sourceCompanyId,
          projectId: input.sourceProjectId,
          workspaceId: input.sourceWorkspaceId,
          agentId: id,
        },
        true,
      );
    return created;
  });
}
function sameRegistration(got: Record<string, unknown>, input: Registration) {
  return (
    [
      "bindingDigest",
      "targetCwd",
      "sourceCompanyId",
      "sourceProjectId",
      "sourceWorkspaceId",
      "projectDigest",
      "snapshotDigest",
    ].every((k) => got[k] === input[k as keyof Registration]) &&
    Array.isArray(got.agentIds) &&
    got.agentIds.length === input.agentIds.length &&
    input.agentIds.every((id) => (got.agentIds as unknown[]).includes(id))
  );
}
export async function listPaperclipWorkspaces(deps: PaperclipWorkspaceDeps, actorId: string, orgId: string) {
  await owner(deps.db, actorId, orgId);
  return deps.db
    .select()
    .from(bindings)
    .where(and(eq(bindings.orgId, orgId), eq(bindings.ownerId, actorId)));
}
/** Revocation is one-way. Its row lock conflicts with routine-start/dispatch share locks. */
export async function disablePaperclipWorkspace(
  deps: PaperclipWorkspaceDeps,
  actorId: string,
  orgId: string,
  id: string,
) {
  await owner(deps.db, actorId, orgId);
  const [b] = await deps.db
    .update(bindings)
    .set({ enabled: false })
    .where(and(eq(bindings.orgId, orgId), eq(bindings.id, id), eq(bindings.ownerId, actorId)))
    .returning();
  if (!b) throw new NotFoundError();
  return b;
}
