/** Per-native-hook unattended ingress. No source identity or authority is accepted from the request. */
import { and, type Database, eq, isNull, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { routineHookToken, sha256 } from "./crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { requirePermission } from "./organizations";
import { nativeHash } from "./paperclip-routine-state";
import {
  assertPaperclipMappingSupported,
  dispatchPaperclipRoutine,
  findPaperclipInvocation,
  type PaperclipRoutineDeps,
} from "./paperclip-routines";
import { paperclipInvocationWorkspaceSchema } from "./paperclip-workspaces";
import {
  ensureRoutineHook,
  HOOK_LIMIT_PER_ROUTINE,
  HOOK_MAX_BYTES,
  type HookAnswer,
  hookMethodsOf,
  newRoutineHookAddress,
  newRoutineHookSecret,
  type RoutineHookDeps,
  removeRoutineHookSecret,
  routineHookSignatureValid,
  routineHookView,
} from "./routine-hooks";
import { closedOrg } from "./standing";

const { paperclipRoutineMappings: mappings, routineHooks, routines, organizations } = schema;
type Mapping = typeof mappings.$inferSelect;
type Receipt = typeof schema.paperclipRoutineReceipts.$inferSelect;
export type PaperclipHookDeps = PaperclipRoutineDeps & RoutineHookDeps;
export const paperclipHookIngressSchema = z.strictObject({
  expectedConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  triggerId: z.uuid(),
  enabled: z.boolean(),
});
const keySchema = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => s.trim().length > 0);
const invocationSchema = z.strictObject({
  expectedConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: keySchema,
  variables: z.record(z.string(), z.unknown()).optional(),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  workspace: paperclipInvocationWorkspaceSchema.optional(),
});
const lookupSchema = z.strictObject({ idempotencyKey: keySchema });
function parsed<T>(s: z.ZodType<T>, value: unknown): T {
  const result = s.safeParse(value);
  if (!result.success)
    throw new ValidationError("Unsupported or invalid Paperclip hook fields", "paperclip.unsupported_input");
  return result.data;
}
function apiTrigger(m: Mapping, triggerId: string) {
  const enabled = m.triggers.filter((t) => t.kind === "api" && t.enabled);
  if (enabled.length !== 1 || enabled[0]?.id !== triggerId)
    throw new ConflictError("Ingress requires the mapping's single enabled API trigger", "paperclip.trigger_inactive");
}

/** Explicit CAS opt-in; it never activates a mapping/native routine or dispatches work. Disable works while global dispatch is off. */
export async function setPaperclipHookIngress(
  deps: PaperclipRoutineDeps,
  actorId: string,
  orgId: string,
  mappingId: string,
  value: z.input<typeof paperclipHookIngressSchema>,
): Promise<Mapping> {
  const input = parsed(paperclipHookIngressSchema, value);
  if (input.enabled && deps.enabled !== true)
    throw new ForbiddenError("Paperclip routine compatibility is disabled", "paperclip.disabled");
  return deps.db.transaction(async (tx) => {
    await requirePermission(tx, actorId, orgId, "manage_routines");
    const [m] = await tx
      .select()
      .from(mappings)
      .where(and(eq(mappings.orgId, orgId), eq(mappings.id, mappingId)))
      .for("update");
    if (!m) throw new NotFoundError();
    if (m.createdByUserId !== actorId)
      throw new ForbiddenError("Only the mapping creator may change hook authority", "paperclip.not_owner");
    if (m.configHash !== input.expectedConfigHash)
      throw new ConflictError("Mapping changed", "paperclip.stale_mapping");
    if (input.enabled) {
      assertPaperclipMappingSupported(m);
      apiTrigger(m, input.triggerId);
      const [native] = await tx
        .select()
        .from(routines)
        .where(and(eq(routines.orgId, orgId), eq(routines.id, m.routineId)))
        .for("update");
      if (
        !native ||
        native.deletedAt ||
        native.event !== "paperclip.received" ||
        native.createdByUserId !== actorId ||
        native.agentId !== m.agentId ||
        nativeHash(native) !== m.nativeConfigHash
      )
        throw new ConflictError("Native routine is unprepared or changed", "paperclip.target_changed");
      if (!deps.hooks) throw new ConflictError("Native hook credentials are unavailable");
      await ensureRoutineHook(tx, deps.hooks, { id: native.id, orgId });
      const [hook] = await tx
        .select()
        .from(routineHooks)
        .where(and(eq(routineHooks.routineId, native.id), eq(routineHooks.orgId, orgId)));
      if (!hook || hook.source) throw new ConflictError("Only a plain native hook can authorize migration ingress");
    } else if (m.hookIngress && m.hookIngress.triggerId !== input.triggerId) {
      throw new ConflictError("Bound hook trigger changed", "paperclip.trigger_inactive");
    }
    const [next] = await tx
      .update(mappings)
      .set({ hookIngress: { enabled: input.enabled, triggerId: input.triggerId, configHash: m.configHash } })
      .where(eq(mappings.id, m.id))
      .returning();
    if (!next) throw new Error("Mapping update missing");
    return next;
  });
}

/** The generic webhook manager remains event-restricted: its test action must never bypass durable receipts. */
export async function managePaperclipHook(
  deps: PaperclipHookDeps,
  actorId: string,
  orgId: string,
  mappingId: string,
  action: "view" | "rotate_address" | "rotate_secret" | "remove_secret",
) {
  return deps.db.transaction(async (tx) => {
    await requirePermission(tx, actorId, orgId, "manage_routines");
    const [m] = await tx
      .select()
      .from(mappings)
      .where(and(eq(mappings.orgId, orgId), eq(mappings.id, mappingId)))
      .for("update");
    if (!m || m.createdByUserId !== actorId) throw new NotFoundError();
    const [native] = await tx
      .select()
      .from(routines)
      .where(and(eq(routines.orgId, orgId), eq(routines.id, m.routineId)))
      .for("share");
    if (
      !native ||
      native.deletedAt ||
      native.event !== "paperclip.received" ||
      native.createdByUserId !== actorId ||
      native.agentId !== m.agentId
    )
      throw new NotFoundError();
    const [hook] = await tx
      .select()
      .from(routineHooks)
      .where(and(eq(routineHooks.routineId, native.id), eq(routineHooks.orgId, orgId)))
      .for("update");
    if (!hook || hook.source) throw new NotFoundError();
    const scoped = { ...deps, db: tx as Database };
    if (action === "rotate_address") return newRoutineHookAddress(scoped, actorId, native);
    if (action === "rotate_secret") return newRoutineHookSecret(scoped, actorId, native);
    if (action === "remove_secret") return removeRoutineHookSecret(scoped, actorId, native);
    return routineHookView(scoped, native);
  });
}

function view(m: Mapping, r: Receipt) {
  const acceptedConfigHash = r.acceptedConfigHash ?? null;
  return {
    backend: "agents_chat" as const,
    receiptId: r.id,
    mappingId: m.id,
    sourceRoutineId: m.sourceRoutineId,
    sourceRevisionId: m.sourceRevisionId,
    configHash: acceptedConfigHash,
    acceptedConfigHash,
    currentConfigHash: m.configHash,
    admissionConfigStatus: acceptedConfigHash === null ? "unknown_legacy" : "recorded",
    status: r.status,
    routineRunId: r.routineRunId,
    issueId: r.issueId,
    workspace: r.workspaceSelection
      ? {
          bindingId: r.workspaceSelection.bindingId,
          projectId: r.workspaceSelection.sourceProjectId,
          projectWorkspaceId: r.workspaceSelection.sourceWorkspaceId,
          generation: r.workspaceSelection.generation,
          bindingDigest: r.workspaceSelection.bindingDigest,
        }
      : null,
  };
}
type Refusal = Exclude<HookAnswer, { status: 202 }>;
type ReceiptView = ReturnType<typeof view>;
export type PaperclipHookAnswer =
  | Refusal
  | { status: 202; receipt: ReceiptView }
  | { status: 200; receipt: ReceiptView | null };

/** No native accept/24-hour merge: the existing durable receipt transaction is the only dispatch path. */
export async function receivePaperclipRoutineHook(
  deps: PaperclipHookDeps,
  operation: "invocations" | "lookup",
  input: { token: string; headers: Headers; method: string; read: (maxBytes: number) => Promise<Uint8Array | null> },
): Promise<PaperclipHookAnswer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) return { status: 404, code: "not_found" };
  // This first lookup selects no authority. Every field and credential is re-read after the source lock below.
  const [candidate] = await deps.db
    .select({ mapping: mappings, hook: routineHooks })
    .from(routineHooks)
    .innerJoin(mappings, and(eq(mappings.routineId, routineHooks.routineId), eq(mappings.orgId, routineHooks.orgId)))
    .where(eq(routineHooks.tokenHash, sha256(input.token)));
  if (
    !candidate?.mapping.hookIngress?.enabled ||
    candidate.hook.source ||
    routineHookToken(deps.hooks.secret, candidate.hook.keyId) !== input.token
  )
    return { status: 404, code: "not_found" };
  if (input.method.toUpperCase() !== "POST") return { status: 405, code: "method_not_allowed", allow: ["POST"] };
  if (!hookMethodsOf(candidate.hook.methods).includes("POST"))
    return { status: 405, code: "method_not_allowed", allow: [] };
  if (!(await deps.rateLimiter.consume(`routine-hook:${candidate.hook.routineId}`, HOOK_LIMIT_PER_ROUTINE)).allowed)
    return { status: 429, code: "rate_limited" };
  // Buffer the bounded network input before taking database locks. HMAC and all authority are checked under the locks.
  const bytes = await input.read(HOOK_MAX_BYTES);
  if (!bytes) return { status: 413, code: "too_large" };
  return deps.db.transaction(async (tx) => {
    const initial = candidate.mapping;
    // Same order as the session dispatch path: source advisory lock, mapping, native, then credential.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${initial.orgId}:${initial.sourceCompanyId}:${initial.sourceRoutineId}`}, 0))`,
    );
    const [m] = await tx
      .select()
      .from(mappings)
      .where(and(eq(mappings.id, initial.id), eq(mappings.orgId, initial.orgId)))
      .for("update");
    if (
      !m ||
      m.sourceCompanyId !== initial.sourceCompanyId ||
      m.sourceRoutineId !== initial.sourceRoutineId ||
      !m.hookIngress?.enabled ||
      m.hookIngress.configHash !== m.configHash ||
      !m.createdByUserId
    )
      return { status: 404, code: "not_found" };
    const [bound] = await tx
      .select({ native: routines })
      .from(routines)
      .innerJoin(organizations, eq(organizations.id, routines.orgId))
      .where(
        and(
          eq(routines.id, m.routineId),
          eq(routines.orgId, m.orgId),
          isNull(routines.deletedAt),
          sql`not ${closedOrg}`,
        ),
      )
      .for("share");
    const native = bound?.native;
    if (
      native?.event !== "paperclip.received" ||
      native.createdByUserId !== m.createdByUserId ||
      native.agentId !== m.agentId
    )
      return { status: 404, code: "not_found" };
    const [hook] = await tx
      .select()
      .from(routineHooks)
      .where(
        and(
          eq(routineHooks.routineId, native.id),
          eq(routineHooks.orgId, m.orgId),
          eq(routineHooks.tokenHash, sha256(input.token)),
        ),
      )
      .for("share");
    if (!hook || hook.source || routineHookToken(deps.hooks.secret, hook.keyId) !== input.token)
      return { status: 404, code: "not_found" };
    await requirePermission(tx, m.createdByUserId, m.orgId, "manage_routines");
    apiTrigger(m, m.hookIngress.triggerId);
    if (input.method.toUpperCase() !== "POST") return { status: 405, code: "method_not_allowed", allow: ["POST"] };
    if (!hookMethodsOf(hook.methods).includes("POST")) return { status: 405, code: "method_not_allowed", allow: [] };
    if (hook.secretCiphertext && !(await routineHookSignatureValid(deps.keyWrappers, hook, bytes, input.headers)))
      return { status: 401, code: "invalid_signature" };
    if (!/^application\/json(?:\s*;|$)/i.test(input.headers.get("content-type") ?? ""))
      throw new ValidationError("Paperclip hook requires application/json");
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ValidationError("Invalid JSON body");
    }
    const value = operation === "invocations" ? parsed(invocationSchema, body) : parsed(lookupSchema, body);
    const headerKey = input.headers.get("idempotency-key");
    if (headerKey !== null && headerKey !== value.idempotencyKey)
      throw new ValidationError("Header and body idempotency keys differ");
    const scoped = { source: "api" as const, triggerId: m.hookIngress.triggerId };
    const scopedDeps = { ...deps, db: tx as Database };
    if (operation === "invocations") {
      const receipt = await dispatchPaperclipRoutine(scopedDeps, m.createdByUserId, m.orgId, m.id, {
        ...scoped,
        ...parsed(invocationSchema, body),
      });
      return { status: 202, receipt: view(m, receipt) };
    }
    const receipt = await findPaperclipInvocation(scopedDeps, m.createdByUserId, m.orgId, m.id, {
      ...scoped,
      idempotencyKey: value.idempotencyKey,
    });
    return { status: 200, receipt: receipt ? view(m, receipt) : null };
  });
}
