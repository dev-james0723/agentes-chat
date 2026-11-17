import { createHash } from "node:crypto";
import type { BlobStoreResolver } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
import { runPerson } from "../authority";
import { getMembership } from "../organizations";
import { workRefusal } from "../standing";
import { taskSeenSql } from "../task-access";
import type { NativeToolContract, NativeToolReuse, ToolContext } from "../tools/types";
import { assertPackage, canonicalJson, type FrozenPackage } from "./packages";
import { RECEIPT_INPUT_SCHEMA, RECEIPT_OUTPUT_SCHEMA } from "./receipt-contract";

const { foundryCandidates: candidates, foundryVersions: versions } = schema;
export type FoundryCandidate = typeof candidates.$inferSelect;
export type FoundryVersion = typeof versions.$inferSelect;
export const FOUNDRY_CONTRACT = "receipt-normalizer/v1";

/** Reviewed semantics, shared by the native inventory query and an eligible Foundry ToolDefinition. */
export const FOUNDRY_NATIVE_CONTRACT: Readonly<NativeToolContract> = Object.freeze({
  contractId: FOUNDRY_CONTRACT,
  inputDigest: foundryHash(RECEIPT_INPUT_SCHEMA),
  outputDigest: foundryHash(RECEIPT_OUTPUT_SCHEMA),
  effectsDigest: foundryHash({
    network: "none",
    secrets: "none",
    filesystem: "none",
    externalActions: [],
    nestedCapabilities: [],
  }),
});

/** Native durable evaluation recovery only; never populated from tool arguments or a context flag. */
export interface FoundryCheckpoint {
  waitId: string;
  toolUseId: string;
}

export class FoundryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "FoundryError";
  }
}
export function foundryHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).every((k) => keys.includes(k))
  );
}
export async function foundryContext(db: Executor, ctx: ToolContext, checkpoint?: FoundryCheckpoint) {
  if (ctx.signal?.aborted) throw new FoundryError("CANCELLED");
  const [run] = await db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.orgId, ctx.orgId),
        eq(schema.agentRuns.id, ctx.runId),
        eq(schema.agentRuns.agentId, ctx.agentId),
      ),
    );
  const pending = (
    run?.transcript as {
      pending?: { calls?: { waitId?: string; toolUseId?: string; name?: string; result?: unknown }[] };
    } | null
  )?.pending?.calls;
  const checkpointMatches =
    checkpoint &&
    checkpoint.waitId.length > 0 &&
    checkpoint.toolUseId.length > 0 &&
    ["waiting_input", "waiting_approval"].includes(run?.status ?? "") &&
    Array.isArray(pending) &&
    pending.filter((call) => call.waitId === checkpoint.waitId || call.toolUseId === checkpoint.toolUseId).length ===
      1 &&
    pending.some(
      (call) =>
        call.waitId === checkpoint.waitId &&
        call.toolUseId === checkpoint.toolUseId &&
        call.name === "evaluate_foundry_capability" &&
        !call.result,
    );
  if (
    !run ||
    (checkpoint ? !checkpointMatches : run.status !== "running") ||
    !run.issueId ||
    run.background ||
    run.channelId !== ctx.channelId ||
    run.threadRootId !== ctx.threadRootId ||
    run.triggerMessageId !== ctx.triggerMessageId
  )
    throw new FoundryError("AUTHORITY_DENIED");
  const personId = await runPerson(db, ctx.orgId, ctx.runId);
  if (!personId) throw new FoundryError("AUTHORITY_DENIED");
  const membership = await getMembership(db, personId, ctx.orgId);
  if (!membership || workRefusal(membership.standing)) throw new FoundryError("AUTHORITY_DENIED");
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(
      and(eq(schema.agents.id, ctx.agentId), eq(schema.agents.orgId, ctx.orgId), isNull(schema.agents.archivedAt)),
    );
  if (!agent || agent.operatorHoldAt) throw new FoundryError("AUTHORITY_DENIED");
  const [task] = await db
    .select()
    .from(schema.issues)
    .where(
      and(
        eq(schema.issues.id, run.issueId),
        eq(schema.issues.orgId, ctx.orgId),
        taskSeenSql("issues", sql`${personId}`),
      ),
    );
  if (
    !task ||
    !["todo", "in_progress", "in_review"].includes(task.status) ||
    task.assigneeType !== "agent" ||
    task.assigneeId !== ctx.agentId
  )
    throw new FoundryError("AUTHORITY_DENIED");
  const contextRevision = foundryHash({
    taskId: task.id,
    title: task.title,
    description: task.description,
    criteria: task.criteria,
    channelId: task.channelId,
    restricted: task.restricted,
    audience: [...task.audienceUserIds].sort(),
    assigneeType: task.assigneeType,
    assigneeId: task.assigneeId,
    projectId: task.projectId,
  });
  return { task, run, personId, membership, contextRevision };
}
export async function ownedCandidate(db: Executor, ctx: ToolContext, id: string, checkpoint?: FoundryCheckpoint) {
  const current = await foundryContext(db, ctx, checkpoint);
  const [candidate] = await db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.id, id),
        eq(candidates.orgId, ctx.orgId),
        eq(candidates.taskId, current.task.id),
        eq(candidates.agentId, ctx.agentId),
        eq(candidates.personId, current.personId),
      ),
    );
  if (!candidate) throw new FoundryError("NOT_FOUND");
  if (candidate.contextRevision !== current.contextRevision) throw new FoundryError("STALE_CONTEXT");
  return { ...current, candidate };
}

export type FoundryDependencies = {
  db: Database;
  blobs: BlobStoreResolver;
  /** Server-resolved authorized native tool inventory. No candidate-supplied search receipt. */
  nativeReuse?: (ctx: ToolContext, contract: NativeToolContract) => Promise<NativeToolReuse | null>;
};
export type FoundryProposal =
  | { kind: "draft"; candidate: FoundryCandidate }
  | { kind: "reuse"; candidate: null; existing: { kind: "skill" | "tool"; id: string; version: string | number } };

export async function loadFoundryBundle(deps: FoundryDependencies, version: FoundryVersion): Promise<FrozenPackage> {
  const store = await deps.blobs.forConfig(version.orgId, version.storageConfigId);
  const object = await store.get(version.blobKey);
  if (!object || object.body.byteLength !== version.blobBytes || object.body.byteLength > 16 * 1024 * 1024)
    throw new FoundryError("STALE_VERSION");
  let bundle: FrozenPackage;
  try {
    bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.body)) as FrozenPackage;
    assertPackage(bundle);
  } catch {
    throw new FoundryError("STALE_VERSION");
  }
  if (
    bundle.digest !== version.digest ||
    foundryHash(bundle.manifest.contracts) !== version.contractDigest ||
    foundryHash(bundle.manifest.effects) !== version.effectsDigest
  )
    throw new FoundryError("STALE_VERSION");
  return bundle;
}

/** Draft intake only. Generated code remains private inert bytes in the existing blob store. */
export function createFoundryService(deps: FoundryDependencies) {
  const { db } = deps;
  return {
    async propose(ctx: ToolContext, input: { needKey: string }): Promise<FoundryProposal> {
      if (!exactKeys(input, ["needKey"]) || input.needKey !== FOUNDRY_CONTRACT)
        throw new FoundryError("SCHEMA_INVALID");
      const current = await foundryContext(db, ctx);
      const [skill] = await db
        .select({ id: schema.skills.id, version: schema.skills.version })
        .from(schema.skills)
        .innerJoin(
          schema.agentSkills,
          and(
            eq(schema.agentSkills.orgId, schema.skills.orgId),
            eq(schema.agentSkills.skillId, schema.skills.id),
            eq(schema.agentSkills.agentId, ctx.agentId),
            eq(schema.agentSkills.enabled, true),
          ),
        )
        .where(
          and(
            eq(schema.skills.orgId, ctx.orgId),
            isNull(schema.skills.deletedAt),
            sql`${schema.skills.metadata}->>'foundryContract' = ${input.needKey}`,
          ),
        )
        .orderBy(schema.skills.id)
        .limit(1);
      if (skill) return { kind: "reuse", candidate: null, existing: { kind: "skill", ...skill } };
      // A missing or failed server inventory is not an empty completed search. Native Skill reuse above
      // remains available; only new generation needs this additional prerequisite.
      let inventoryAvailable = false;
      let reuse: NativeToolReuse | null = null;
      if (deps.nativeReuse) {
        try {
          const searched = await deps.nativeReuse(ctx, FOUNDRY_NATIVE_CONTRACT);
          if (searched === null) inventoryAvailable = true;
          else if (
            exactKeys(searched, ["kind", "id", "version"]) &&
            searched.kind === "tool" &&
            typeof searched.id === "string" &&
            /^[a-zA-Z0-9_-]{1,64}$/.test(searched.id) &&
            typeof searched.version === "string" &&
            /^[a-f0-9]{64}$/.test(searched.version)
          ) {
            inventoryAvailable = true;
            reuse = searched;
          }
        } catch {
          // Existing native Skill or candidate reuse may still succeed; no new draft is admitted.
        }
      }
      const refreshed = await foundryContext(db, ctx);
      if (refreshed.contextRevision !== current.contextRevision || refreshed.personId !== current.personId)
        throw new FoundryError("STALE_CONTEXT");
      if (reuse) return { kind: "reuse", candidate: null, existing: reuse };
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where org_id=${ctx.orgId}::uuid and id=${current.task.id}::uuid for update`,
        );
        const fresh = await foundryContext(tx, ctx);
        if (fresh.contextRevision !== current.contextRevision) throw new FoundryError("STALE_CONTEXT");
        const needFingerprint = foundryHash({
          needKey: input.needKey,
          personId: current.personId,
          agentId: ctx.agentId,
        });
        const match = and(
          eq(candidates.orgId, ctx.orgId),
          eq(candidates.taskId, current.task.id),
          eq(candidates.needFingerprint, needFingerprint),
          eq(candidates.contextRevision, current.contextRevision),
        );
        const [existing] = await tx.select().from(candidates).where(match);
        if (existing) return { kind: "draft", candidate: existing } as const;
        if (!inventoryAvailable) throw new FoundryError("NATIVE_INVENTORY_UNAVAILABLE");
        const previous = await tx
          .select({ id: candidates.id })
          .from(candidates)
          .where(and(eq(candidates.orgId, ctx.orgId), eq(candidates.taskId, current.task.id)));
        if (previous.length >= 2) throw new FoundryError("BUDGET_EXHAUSTED");
        const [candidate] = await tx
          .insert(candidates)
          .values({
            orgId: ctx.orgId,
            taskId: current.task.id,
            agentId: ctx.agentId,
            personId: current.personId,
            originRunId: ctx.runId,
            needKey: input.needKey,
            needFingerprint,
            contextRevision: current.contextRevision,
          })
          .onConflictDoNothing()
          .returning();
        const result = candidate ?? (await tx.select().from(candidates).where(match))[0];
        if (!result) throw new FoundryError("STALE_CONTEXT");
        return { kind: "draft", candidate: result } as const;
      });
    },
    async list(ctx: ToolContext): Promise<FoundryCandidate[]> {
      let current: Awaited<ReturnType<typeof foundryContext>>;
      try {
        current = await foundryContext(db, ctx);
      } catch {
        return [];
      }
      return db
        .select()
        .from(candidates)
        .where(
          and(
            eq(candidates.orgId, ctx.orgId),
            eq(candidates.taskId, current.task.id),
            eq(candidates.agentId, ctx.agentId),
            eq(candidates.personId, current.personId),
          ),
        );
    },
    async stage(ctx: ToolContext, input: { candidateId: string; revision: number; bundle: FrozenPackage }) {
      const current = await ownedCandidate(db, ctx, input.candidateId);
      assertPackage(input.bundle);
      const manifest = input.bundle.manifest;
      if (
        manifest.kind !== "pure_tool" ||
        manifest.name !== "receipt-normalizer" ||
        manifest.scopeRequest.level !== "task" ||
        manifest.dependencies.length ||
        manifest.provenance.containsPrivateData ||
        manifest.provenance.licenseDisposition !== "original_internal" ||
        manifest.effects.network !== "none" ||
        manifest.effects.secrets !== "none" ||
        manifest.effects.filesystem !== "none" ||
        manifest.effects.externalActions.length ||
        manifest.effects.nestedCapabilities.length ||
        foundryHash(manifest.contracts) !== foundryHash({ input: RECEIPT_INPUT_SCHEMA, output: RECEIPT_OUTPUT_SCHEMA })
      )
        throw new FoundryError("UNSUPPORTED_CAPABILITY");
      const location = await deps.blobs.forOrg(ctx.orgId);
      const blobKey = `${location.prefix}foundry/${ctx.orgId}/${current.candidate.id}/${input.bundle.digest}.json`;
      const bytes = new TextEncoder().encode(canonicalJson(input.bundle));
      if (bytes.byteLength > 16 * 1024 * 1024) throw new FoundryError("SCHEMA_INVALID");
      // Reserve quota and the immutable blob reference BEFORE any upload. A lost
      // upload acknowledgement still has a durable, bounded staging record.
      const reserved = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from foundry_candidates where org_id=${ctx.orgId}::uuid and id=${input.candidateId}::uuid for update`,
        );
        const fresh = await ownedCandidate(tx, ctx, input.candidateId);
        const previous = await tx
          .select()
          .from(versions)
          .where(and(eq(versions.orgId, ctx.orgId), eq(versions.candidateId, input.candidateId)));
        const same = previous.find((v) => v.digest === input.bundle.digest);
        if (same) return { version: same, fresh: false };
        if (fresh.candidate.revision !== input.revision) throw new FoundryError("STALE_VERSION");
        if (previous.length >= 4) throw new FoundryError("REPAIR_LIMIT");
        const [version] = await tx
          .insert(versions)
          .values({
            orgId: ctx.orgId,
            candidateId: input.candidateId,
            digest: input.bundle.digest,
            state: "STAGING",
            contractDigest: foundryHash(manifest.contracts),
            effectsDigest: foundryHash(manifest.effects),
            storageConfigId: location.storageConfigId,
            blobKey,
            blobBytes: bytes.byteLength,
          })
          .returning();
        await tx
          .update(candidates)
          .set({ revision: fresh.candidate.revision + 1, state: "DRAFT", reasonCode: null, updatedAt: new Date() })
          .where(eq(candidates.id, input.candidateId));
        return { version: version!, fresh: true };
      });
      if (!reserved.fresh) return reserved.version;
      try {
        await location.store.put(blobKey, bytes, { contentType: "application/json" });
        await loadFoundryBundle(deps, reserved.version);
        return await db.transaction(async (tx) => {
          await ownedCandidate(tx, ctx, input.candidateId);
          const [ready] = await tx
            .update(versions)
            .set({ state: "DRAFT" })
            .where(
              and(eq(versions.id, reserved.version.id), eq(versions.orgId, ctx.orgId), eq(versions.state, "STAGING")),
            )
            .returning();
          if (!ready) throw new FoundryError("STALE_VERSION");
          return ready;
        });
      } catch {
        await db
          .update(versions)
          .set({ state: "BLOCKED" })
          .where(
            and(eq(versions.id, reserved.version.id), eq(versions.orgId, ctx.orgId), eq(versions.state, "STAGING")),
          );
        throw new FoundryError("STORAGE_UNVERIFIED");
      }
    },
  };
}
