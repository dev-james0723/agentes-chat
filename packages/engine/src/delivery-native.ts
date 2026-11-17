import { createHash } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, schema } from "@agenteschat/db";
import { z } from "zod";
import { activeCoversTo } from "./approval-covers";
import { coveredFor, decides } from "./approvals";
import type { ConnectorDeps } from "./connectors/connections";
import { createNativeDeliveryGuard, type DeliveryRequest, type NativeDeliveryProof } from "./connectors/delivery-guard";
import { ConflictError, ForbiddenError, ValidationError } from "./errors";
import { githubToken } from "./git/branches";
import {
  DeliveryObservationError,
  type DeliveryRepositoryIdentity,
  observeGithubPull,
  observeGithubRepository,
} from "./git/delivery-observation";
import type { AppPermissions } from "./git/github-app";
import type { GitHubAppAccess } from "./git/github-call";
import { agentRepositoryList, repoInList } from "./git/repos";
import { findVisible, getIssue, type IssueActor, publishToTaskReaders } from "./issues";
import { assertActiveMembership, getMembership, requireChangePermission, requirePermission } from "./organizations";
import { canonicalJson } from "./tools/json-schema";
import { freshGrantedKeys, isAllowed, toolAccess } from "./tools/scopes";

const { issues, issueProjects, issueActivity, organizationMembers, agents, agentRuns, connectorConnections } = schema;
const EVENT = "delivery_binding_changed";
const POLICY = "delivery-native-binding/v1";
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const Target = z.strictObject({
  id: z.string().regex(REF),
  kind: z.enum(["agent_chats_local", "macos_app"]),
  environment: z.string().regex(REF),
});
const RepositorySelection = z.strictObject({
  connectionId: z.uuid(),
  owner: z.string().regex(NAME),
  repo: z.string().regex(NAME),
});

/** An authenticated owner selects configuration. No issuer, provider ID, policy or grant can come from this body. */
export const nativeDeliveryBindingChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("set"),
    expectedRevision: z.uuid().nullable(),
    repository: RepositorySelection,
    releaseOwnerId: z.uuid().nullable(),
    targets: z
      .array(Target)
      .min(1)
      .max(8)
      .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length),
  }),
  z.strictObject({
    action: z.literal("revoke"),
    expectedRevision: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  }),
]);
export type NativeDeliveryBindingChange = z.infer<typeof nativeDeliveryBindingChangeSchema>;

const Repository = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  host: z.literal("github.com"),
  owner: z.string().regex(NAME),
  repo: z.string().regex(NAME),
  defaultBranch: z.string().min(1).max(255),
  connectionId: z.uuid(),
  observedAt: z.string().datetime(),
});
const RecordedTarget = Target.extend({ verificationState: z.literal("unknown") });
const Common = {
  schema: z.literal(POLICY),
  policyVersion: z.literal(POLICY),
  orgId: z.uuid(),
  taskId: z.uuid(),
  projectId: z.uuid().nullable(),
  issuerUserId: z.string().min(1).max(200),
  writtenAt: z.string().datetime(),
  previousRevision: z.uuid().nullable(),
  authorityGranted: z.literal(false),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
};
const RecordSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...Common,
    action: z.literal("set"),
    projectId: z.uuid(),
    repository: Repository,
    releaseOwnerId: z.uuid().nullable(),
    targets: z.array(RecordedTarget).min(1).max(8),
  }),
  z.strictObject({ ...Common, action: z.literal("revoke"), reason: z.string().min(1).max(500) }),
]);
type BindingRecord = z.infer<typeof RecordSchema>;
type IssueRow = typeof issues.$inferSelect;
type EventRow = typeof issueActivity.$inferSelect;
type NativeSnapshot =
  | { reason: string }
  | { issue: IssueRow; binding: Extract<BindingRecord, { action: "set" }>; revision: string };

export interface NativeDeliveryBindingView {
  state: "missing" | "configured" | "revoked" | "untrusted" | "conflict";
  revision: string | null;
  taskId: string;
  projectId: string | null;
  authorityGranted: false;
  reasonCodes: string[];
  repository?: DeliveryRepositoryIdentity & { connectionId: string; observedAt: string };
  releaseOwnerId?: string | null;
  targets?: (z.infer<typeof Target> & { verificationState: "unknown" })[];
}

export interface NativeDeliveryDeps {
  connectors: ConnectorDeps;
  github?: GitHubAppAccess;
  pubsub?: PubSub;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("Non-JSON native binding value");
  return text;
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const block = (...reasonCodes: string[]): NativeDeliveryProof => ({ decision: "blocked", reasonCodes });
const currentOwner = async (db: Executor, userId: string, orgId: string) => {
  const member = await getMembership(db, userId, orgId);
  if (member?.role !== "owner") return false;
  try {
    assertActiveMembership(member);
    return true;
  } catch {
    return false;
  }
};

async function requireOwner(db: Executor, actor: IssueActor, orgId: string) {
  if (actor.type !== "person" || !(await currentOwner(db, actor.userId, orgId)))
    throw new ForbiddenError(
      "Only a current organization owner can configure a delivery relation.",
      "delivery_binding.owner_required",
    );
  await requireChangePermission(db as Database, actor.userId, orgId, "manage_connectors");
  return actor.userId;
}

async function latest(db: Executor, orgId: string, taskId: string): Promise<EventRow | undefined> {
  const [row] = await db
    .select()
    .from(issueActivity)
    .where(and(eq(issueActivity.orgId, orgId), eq(issueActivity.issueId, taskId), eq(issueActivity.event, EVENT)))
    .orderBy(desc(issueActivity.createdAt), desc(issueActivity.id))
    .limit(1);
  return row;
}

function revisionMatches(row: EventRow | undefined, expected: string | null) {
  if ((row?.id ?? null) !== expected)
    throw new ConflictError(
      "The delivery relation changed. Read its current revision first.",
      "delivery_binding.revision_conflict",
    );
}

async function interpreted(
  db: Executor,
  issue: IssueRow,
  row: EventRow | undefined,
): Promise<{ view: NativeDeliveryBindingView; record?: BindingRecord }> {
  const view: NativeDeliveryBindingView = {
    state: "missing",
    revision: row?.id ?? null,
    taskId: issue.id,
    projectId: issue.projectId,
    authorityGranted: false,
    reasonCodes: ["native_binding_missing"],
  };
  if (!row) return { view };
  const invalid = () => ({ view: { ...view, state: "untrusted" as const, reasonCodes: ["native_binding_untrusted"] } });
  const parsed = RecordSchema.safeParse(row.data);
  if (!parsed.success || row.kind !== "event" || row.authorType !== "person") return invalid();
  const record = parsed.data;
  const { payloadDigest, ...payload } = record;
  if (
    record.orgId !== issue.orgId ||
    record.taskId !== issue.id ||
    record.issuerUserId !== row.authorId ||
    Date.parse(record.writtenAt) !== row.createdAt.getTime() ||
    row.createdAt.getTime() > Date.now() ||
    payloadDigest !== digest(payload) ||
    !(await currentOwner(db, row.authorId, issue.orgId))
  )
    return invalid();
  if (record.action === "revoke")
    return { record, view: { ...view, state: "revoked", reasonCodes: ["native_binding_revoked"] } };
  const [project] = await db
    .select({ id: issueProjects.id, archivedAt: issueProjects.archivedAt })
    .from(issueProjects)
    .where(and(eq(issueProjects.orgId, issue.orgId), eq(issueProjects.id, record.projectId)));
  if (issue.projectId !== record.projectId || !project || project.archivedAt)
    return { view: { ...view, state: "conflict", reasonCodes: ["native_binding_subject_changed"] } };
  return {
    record,
    view: {
      ...view,
      state: "configured",
      reasonCodes: [],
      repository: record.repository,
      releaseOwnerId: record.releaseOwnerId,
      targets: record.targets,
    },
  };
}

async function connectionFor(db: Executor, orgId: string, id: string) {
  const [connection] = await db
    .select()
    .from(connectorConnections)
    .where(and(eq(connectorConnections.orgId, orgId), eq(connectorConnections.id, id)));
  if (connection?.connector !== "github" || connection.status !== "active" || connection.revokedAt)
    throw new ValidationError(
      "The selected GitHub connection is unavailable.",
      "delivery_binding.connection_unavailable",
    );
  return connection;
}

async function observe(
  deps: NativeDeliveryDeps,
  orgId: string,
  selection: z.infer<typeof RepositorySelection>,
  signal?: AbortSignal,
  pull = false,
) {
  const connection = await connectionFor(deps.connectors.db, orgId, selection.connectionId);
  const http = deps.github?.http ?? { apiUrl: "https://api.github.com", fetch: deps.connectors.http ?? fetch };
  if (http.apiUrl.replace(/\/$/, "") !== "https://api.github.com")
    throw new DeliveryObservationError("delivery_provider_host_unavailable");
  const permissions: AppPermissions = { metadata: "read" };
  if (pull) permissions.pull_requests = "read";
  const token = await githubToken(
    { connectors: deps.connectors, app: deps.github?.app() },
    http,
    { db: deps.connectors.db, orgId },
    connection,
    selection,
    permissions,
  );
  if (!token) throw new DeliveryObservationError("delivery_provider_credential_unavailable");
  const readDeps = { http: http.fetch, headers: { authorization: `Bearer ${token}` }, signal };
  const repository = await observeGithubRepository(readDeps, selection);
  return { repository, readDeps };
}

/**
 * Native task metadata and current provider reads, composed by the server. Configuration remains non-authorizing.
 * A real publisher lease/operation adapter is still required; this increment intentionally cannot admit a release.
 */
export function createNativeDeliveryService(deps: NativeDeliveryDeps) {
  const db = deps.connectors.db;

  async function approvalReason(request: DeliveryRequest): Promise<string | null> {
    const reference = request.approval;
    if (!reference) return request.phase === "execute" ? "native_release_authority_unavailable" : null;
    const [row] = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.orgId, request.ctx.orgId), eq(schema.approvals.id, reference.id)));
    if (!row || row.status !== "approved") return "native_approval_not_approved";
    const at = new Date();
    if (row.expiresAt <= at) return "native_approval_expired";
    const hash = createHash("sha256")
      .update(
        canonicalJson({
          tool: row.tool,
          scope: row.scope,
          connectionId: row.connectionId,
          params: row.params,
        }),
      )
      .digest("hex");
    if (
      row.agentId !== request.ctx.agentId ||
      row.runId !== request.ctx.runId ||
      row.toolUseId !== request.ctx.toolUseId ||
      row.tool !== reference.tool ||
      row.scope !== reference.scope ||
      row.scope !== `github:${request.scope}` ||
      row.connectionId !== request.connectionId ||
      row.actionHash !== reference.actionHash ||
      hash !== reference.actionHash ||
      canonicalJson(row.params) !== canonicalJson(request.input) ||
      row.missionId ||
      row.missionTaskId ||
      row.runAt ||
      row.routineId
    )
      return "native_approval_subject_mismatch";
    if (
      reference.stage === "checking"
        ? row.executedAt !== null || reference.executedAt !== null
        : !row.executedAt || row.executedAt.toISOString() !== reference.executedAt
    )
      return "native_approval_claim_mismatch";
    if (request.phase === "execute" && reference.stage !== "claimed") return "native_approval_claim_missing";
    if (!row.decidedByUserId || !row.decidedAt || row.decidedAt > at) return "native_approval_issuer_revoked";
    try {
      const membership = await requirePermission(db, row.decidedByUserId, request.ctx.orgId, "read");
      const [agent] = await db
        .select({ ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(and(eq(agents.orgId, request.ctx.orgId), eq(agents.id, request.ctx.agentId)));
      if (!agent) return "native_approval_issuer_revoked";
      // Ordinary cards name the agent's current owner. Preserve native role, named-person and cover semantics.
      const current = { ...row, ownerUserId: agent.ownerUserId };
      if (!decides(current, row.decidedByUserId, membership)) {
        const covered = coveredFor(
          current,
          row.decidedByUserId,
          await activeCoversTo(db, request.ctx.orgId, row.decidedByUserId, at),
        );
        if (!row.decidedForUserId || covered !== row.decidedForUserId) return "native_approval_issuer_revoked";
      }
    } catch {
      return "native_approval_issuer_revoked";
    }
    return null;
  }

  async function readBinding(actor: IssueActor, orgId: string, taskId: string): Promise<NativeDeliveryBindingView> {
    const issue = await findVisible(db, actor, orgId, { id: taskId });
    return (await interpreted(db, issue, await latest(db, orgId, taskId))).view;
  }

  async function changeBinding(
    actor: IssueActor,
    orgId: string,
    taskId: string,
    input: unknown,
  ): Promise<NativeDeliveryBindingView> {
    const change = nativeDeliveryBindingChangeSchema.safeParse(input);
    if (!change.success)
      throw new ValidationError("Invalid delivery relation change.", "delivery_binding.invalid_input");
    const selected = change.data;
    const issuer = await requireOwner(db, actor, orgId);
    const before = await findVisible(db, actor, orgId, { id: taskId });
    revisionMatches(await latest(db, orgId, taskId), selected.expectedRevision);
    if (selected.action === "set" && !before.projectId)
      throw new ValidationError("The task needs an existing project.", "delivery_binding.project_required");
    const observed =
      selected.action === "set"
        ? await observe(deps, orgId, selected.repository).catch((error: unknown) => {
            if (error instanceof DeliveryObservationError)
              throw new ValidationError(
                "The repository could not be verified through the selected native GitHub connection.",
                error.code,
              );
            throw error;
          })
        : null;
    const observedAt = new Date();
    await db.transaction(async (tx) => {
      // Lock the native owner and subject rows; concurrent revocation, archive, move and binding writes recheck here.
      await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, issuer)))
        .for("update");
      await requireOwner(tx, actor, orgId);
      if (selected.action === "set" && before.projectId) {
        const [project] = await tx
          .select()
          .from(issueProjects)
          .where(and(eq(issueProjects.orgId, orgId), eq(issueProjects.id, before.projectId)))
          .for("update");
        if (!project || project.archivedAt)
          throw new ConflictError("The selected project is unavailable.", "delivery_binding.subject_changed");
      }
      const [issue] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.orgId, orgId), eq(issues.id, taskId)))
        .for("update");
      if (!issue || issue.projectId !== before.projectId)
        throw new ConflictError("The task's project changed.", "delivery_binding.subject_changed");
      revisionMatches(await latest(tx, orgId, taskId), selected.expectedRevision);
      const writtenAt = new Date();
      const common = {
        schema: POLICY,
        policyVersion: POLICY,
        orgId,
        taskId,
        projectId: issue.projectId,
        issuerUserId: issuer,
        writtenAt: writtenAt.toISOString(),
        previousRevision: selected.expectedRevision,
        authorityGranted: false,
      };
      let payload: Record<string, unknown>;
      if (selected.action === "set") {
        if (!observed || writtenAt.getTime() - observedAt.getTime() > 10_000)
          throw new ConflictError("The provider observation is no longer fresh.", "delivery_binding.observation_stale");
        await connectionFor(tx, orgId, selected.repository.connectionId);
        if (selected.releaseOwnerId) {
          const [publisher] = await tx
            .select({
              archivedAt: agents.archivedAt,
              deletedAt: agents.deletedAt,
              operatorHoldAt: agents.operatorHoldAt,
            })
            .from(agents)
            .where(and(eq(agents.orgId, orgId), eq(agents.id, selected.releaseOwnerId)));
          if (!publisher || publisher.archivedAt || publisher.deletedAt || publisher.operatorHoldAt)
            throw new ValidationError(
              "The selected release owner is unavailable.",
              "delivery_binding.release_owner_unavailable",
            );
        }
        payload = {
          ...common,
          action: "set",
          repository: {
            ...observed.repository,
            connectionId: selected.repository.connectionId,
            observedAt: observedAt.toISOString(),
          },
          releaseOwnerId: selected.releaseOwnerId,
          targets: selected.targets.map((target) => ({ ...target, verificationState: "unknown" })),
        };
      } else payload = { ...common, action: "revoke", reason: selected.reason };
      const data = RecordSchema.parse({ ...payload, payloadDigest: digest(payload) });
      await tx.insert(issueActivity).values({
        orgId,
        issueId: taskId,
        kind: "event",
        event: EVENT,
        authorType: "person",
        authorId: issuer,
        text:
          selected.action === "set"
            ? "Configured this task's repository and selected delivery targets; release gates still apply."
            : "Revoked this task's delivery configuration.",
        data,
        createdAt: writtenAt,
      });
      await tx.update(issues).set({ updatedAt: writtenAt }).where(eq(issues.id, taskId));
    });
    const issue = await getIssue(db, actor, orgId, { id: taskId });
    await publishToTaskReaders({ db, pubsub: deps.pubsub }, orgId, issue, { type: "issue.updated", issue });
    return readBinding(actor, orgId, taskId);
  }

  async function nativeSnapshot(request: DeliveryRequest): Promise<NativeSnapshot> {
    const { ctx } = request;
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.id, ctx.runId)));
    if (
      !run ||
      run.agentId !== ctx.agentId ||
      run.channelId !== ctx.channelId ||
      run.threadRootId !== ctx.threadRootId ||
      run.triggerMessageId !== ctx.triggerMessageId
    )
      return { reason: "native_delivery_run_missing" } as const;
    if (["done", "failed", "canceled"].includes(run.status)) return { reason: "native_delivery_run_inactive" } as const;
    const [agent] = await db
      .select({ archivedAt: agents.archivedAt, deletedAt: agents.deletedAt, operatorHoldAt: agents.operatorHoldAt })
      .from(agents)
      .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
    if (!agent || agent.archivedAt || agent.deletedAt || agent.operatorHoldAt)
      return { reason: "native_delivery_actor_inactive" } as const;
    const taskId = run.issueId;
    if (!taskId) return { reason: "native_delivery_task_missing" } as const;
    let issue: IssueRow;
    try {
      issue = await findVisible(
        db,
        { type: "agent", agentId: ctx.agentId, channelId: ctx.channelId, runId: run.id },
        ctx.orgId,
        { id: taskId },
      );
    } catch {
      return { reason: "native_delivery_task_unavailable" } as const;
    }
    if (issue.status === "done" || issue.status === "canceled")
      return { reason: "native_delivery_task_inactive" } as const;
    const observed = await interpreted(db, issue, await latest(db, ctx.orgId, taskId));
    if (observed.view.state !== "configured" || observed.record?.action !== "set" || !observed.view.revision)
      return { reason: observed.view.reasonCodes[0] ?? "native_binding_untrusted" } as const;
    const binding = observed.record;
    if (!binding.releaseOwnerId) return { reason: "native_release_owner_unset" } as const;
    if (binding.releaseOwnerId !== ctx.agentId) return { reason: "native_release_owner_mismatch" } as const;
    if (binding.repository.connectionId !== request.connectionId)
      return { reason: "native_delivery_connection_mismatch" } as const;
    try {
      await connectionFor(db, ctx.orgId, request.connectionId);
    } catch {
      return { reason: "native_delivery_connection_unavailable" } as const;
    }
    if (
      !isAllowed(
        toolAccess(await freshGrantedKeys(db, ctx.orgId, ctx.agentId), {
          name: request.approval?.tool ?? `github_${request.tool}`,
          scope: `github:${request.scope}`,
          connectionId: request.connectionId,
        }),
      )
    )
      return { reason: "native_delivery_scope_revoked" } as const;
    const owner = request.input.owner;
    const repo = request.input.repo;
    if (
      typeof owner !== "string" ||
      typeof repo !== "string" ||
      `${owner}/${repo}`.toLowerCase() !== `${binding.repository.owner}/${binding.repository.repo}`.toLowerCase()
    )
      return { reason: "native_delivery_repository_mismatch" } as const;
    if (!repoInList(await agentRepositoryList(db, ctx.orgId, ctx.agentId), owner, repo))
      return { reason: "native_delivery_repository_revoked" } as const;
    return { issue, binding, revision: observed.view.revision };
  }

  async function verify(request: DeliveryRequest): Promise<NativeDeliveryProof> {
    const before = await nativeSnapshot(request);
    if ("reason" in before) return block(before.reason);
    try {
      const authorityBefore = await approvalReason(request);
      if (authorityBefore) return block(authorityBefore);
      const remote = await observe(deps, request.ctx.orgId, before.binding.repository, request.ctx.signal, true);
      if (remote.repository.id !== before.binding.repository.id) return block("native_repository_identity_changed");
      if (remote.repository.defaultBranch !== before.binding.repository.defaultBranch)
        return block("native_integration_target_changed");
      const pull = await observeGithubPull(remote.readDeps, remote.repository, request.input.pullNumber as number);
      if (pull.headSha !== request.input.sha) return block("native_candidate_head_changed");
      if (pull.baseRef !== remote.repository.defaultBranch) return block("native_integration_target_changed");
      if (pull.merged || pull.state !== "open" || pull.draft) return block("native_candidate_not_open_for_merge");
      if ((await latest(db, request.ctx.orgId, before.issue.id))?.id !== before.revision)
        return block("native_binding_changed_during_observation");
      const after = await nativeSnapshot(request);
      if ("reason" in after) return block(after.reason);
      const authorityAfter = await approvalReason(request);
      if (authorityAfter) return block(authorityAfter);
      // Provider identity is a real observation, not a checks/review attestation, target lease or release grant.
      // Keep the existing publisher responsible; never synthesize operation IDs/fencing from a task or approval ID.
      return block(
        "native_target_unverified",
        "trusted_check_policy_unavailable",
        ...(!request.approval ? ["native_release_authority_unavailable"] : []),
        "native_release_operation_unavailable",
        "native_release_lease_unavailable",
      );
    } catch (error) {
      return block(error instanceof DeliveryObservationError ? error.code : "native_delivery_observation_unavailable");
    }
  }

  return { changeBinding, readBinding, guard: createNativeDeliveryGuard({ verify }) };
}
