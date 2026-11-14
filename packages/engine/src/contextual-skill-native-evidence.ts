import { and, eq, inArray, isNull, schema } from "@agenteschat/db";
import { seesAgentDetails } from "./audience";
import { runAuthority } from "./authority";
import { requireChannelAccess } from "./channels";
import { sha256 } from "./crypto";
import { requireActiveMembership } from "./organizations";
import { routineCreatorOf } from "./requester";
import { taskReadersAmong } from "./task-access";
import { canonicalJson } from "./tools/json-schema";
import { accessWithNeeds, freshGrantedKeys, isAllowed } from "./tools/scopes";
import type { ToolContext, ToolDefinition } from "./tools/types";

const VERSION = "native-skill-preview/1";
const OBSERVATION_MS = 5000;
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const plain = (v: unknown): v is Record<string, unknown> =>
  Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) &&
      Object.values(Object.getOwnPropertyDescriptors(v)).every((d) => "value" in d),
  );
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  plain(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

/** Captured by the native caller, never accepted as a tool argument or inferred from model/profile JSON. */
export type NativeSkillPreviewContext = ToolContext & {
  originalActor: { kind: "person"; personId: string } | { kind: "routine" | "unattended"; personId: null };
};
export interface NativeSkillPreviewDeps {
  /** Server-owned current gateway listing, preferably already loaded native facts. No model/profile call or write. */
  readCurrentTools?: (ctx: ToolContext) => Promise<readonly ToolDefinition[]>;
  now?: () => number;
}
export interface NativeSkillPreview {
  version: typeof VERSION;
  status: "preview_only" | "unavailable";
  reason: string;
  skills: { id: string; version: number }[];
  activation: "unverified";
  authority: false;
  canExecute: false;
  readiness: "metadata_only";
  visibilityEvidence: "unverified" | "native_assignment_and_caller_reach";
  sourceContextPrivacy: "unverified";
  modelCalls: 0;
  capturedAt: number | null;
  expiresAt: number | null;
  fingerprint: string | null;
}

/**
 * Explicit, unregistered read-only preview. No hook, activation issuer/store/CAS/use claim, model or skill load.
 * Native assignment/caller reach is observed; source-context audience/provenance safety remains unverified.
 * A result is not a permission grant, private-source disclosure verdict or atomic snapshot.
 * Native DB/listing IO retains its existing driver/caller cancellation/timeout contracts; no global IO bound claimed.
 */
export async function previewNativeSkills(
  ctx: NativeSkillPreviewContext,
  input: unknown,
  deps: NativeSkillPreviewDeps,
): Promise<NativeSkillPreview> {
  const unavailable = (reason: string): NativeSkillPreview => ({
    version: VERSION,
    status: "unavailable",
    reason,
    skills: [],
    activation: "unverified",
    authority: false,
    canExecute: false,
    readiness: "metadata_only",
    visibilityEvidence: "unverified",
    sourceContextPrivacy: "unverified",
    modelCalls: 0,
    capturedAt: null,
    expiresAt: null,
    fingerprint: null,
  });
  try {
    if (
      !exact(input, ["skills"]) ||
      !Array.isArray(input.skills) ||
      !input.skills.length ||
      input.skills.length > 3 ||
      !input.skills.every(
        (r) =>
          exact(r, ["id", "version"]) &&
          uuid(r.id) &&
          typeof r.version === "number" &&
          Number.isSafeInteger(r.version) &&
          r.version > 0,
      )
    )
      return unavailable("invalid_input");
    const refs = (input.skills as { id: string; version: number }[]).map((r) => ({ ...r }));
    if (new Set(refs.map((r) => r.id)).size !== refs.length) return unavailable("invalid_input");
    if (
      ![ctx.orgId, ctx.agentId, ctx.runId, ctx.channelId, ctx.threadRootId, ctx.triggerMessageId].every(uuid) ||
      !exact(ctx.originalActor, ["kind", "personId"]) ||
      !["person", "routine", "unattended"].includes(ctx.originalActor.kind) ||
      (ctx.originalActor.kind === "person"
        ? typeof ctx.originalActor.personId !== "string" || !ctx.originalActor.personId
        : ctx.originalActor.personId !== null)
    )
      return unavailable("native_binding_unqualified");
    if (typeof deps.readCurrentTools !== "function") return unavailable("capability_unobserved");
    if (ctx.signal?.aborted) return unavailable("canceled");
    const now = deps.now ?? Date.now;
    const started = now();
    if (!Number.isSafeInteger(started) || started < 0) return unavailable("clock_unqualified");
    const { agentRuns: runs, agents, skills, agentSkills, issues } = schema;
    // Freeze identity across the async listing; listing data is never authority for the original actor.
    ctx = { ...ctx, originalActor: { ...ctx.originalActor } };
    const readBinding = async () => {
      const [native] = await ctx.db
        .select({ run: runs, agent: agents })
        .from(runs)
        .innerJoin(agents, and(eq(agents.id, runs.agentId), eq(agents.orgId, runs.orgId)))
        .where(and(eq(runs.id, ctx.runId), eq(runs.orgId, ctx.orgId), eq(runs.agentId, ctx.agentId)));
      if (
        !native ||
        native.agent.archivedAt ||
        native.run.status !== "running" ||
        native.run.channelId !== ctx.channelId ||
        native.run.threadRootId !== ctx.threadRootId ||
        native.run.triggerMessageId !== ctx.triggerMessageId
      )
        return null;
      const authority = await runAuthority(ctx.db, native.run);
      if (authority.kind !== ctx.originalActor.kind || authority.personId !== ctx.originalActor.personId) return null;
      // Routine creator supplies visibility reach only. It never becomes the acting person or a permission issuer.
      const reader = authority.personId ?? routineCreatorOf(authority);
      if (!reader) return null;
      const membership = await requireActiveMembership(ctx.db, reader, ctx.orgId);
      if (!seesAgentDetails(native.agent, reader, membership)) return null;
      await requireChannelAccess(ctx.db, reader, ctx.orgId, ctx.channelId);
      if (native.run.issueId) {
        const [task] = await ctx.db
          .select({ id: issues.id, status: issues.status })
          .from(issues)
          .where(and(eq(issues.orgId, ctx.orgId), eq(issues.id, native.run.issueId)));
        if (
          !task ||
          ["done", "canceled"].includes(task.status) ||
          !(await taskReadersAmong(ctx.db, task.id, [reader])).includes(reader)
        )
          return null;
      }
      return { native, authority, reader };
    };
    const initial = await readBinding();
    if (!initial) return unavailable("native_binding_unqualified");
    const listed = await deps.readCurrentTools({ ...ctx, loadedGroups: undefined });
    const load = Array.isArray(listed)
      ? listed.find((t) => t.name === "load_skill" && t.scope === "skills:read" && !t.connectionId)
      : undefined;
    if (!load) return unavailable("capability_unobserved");
    if (now() < started || now() >= started + OBSERVATION_MS) return unavailable("observation_expired");
    const final = await readBinding();
    if (!final || final.native.run.issueId !== initial.native.run.issueId || final.reader !== initial.reader)
      return unavailable("native_binding_changed");
    const { native, authority, reader } = final;
    const keys = await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId);
    if (!isAllowed(accessWithNeeds(keys, load).state)) return unavailable("capability_denied");
    const current = await ctx.db
      .select({ id: skills.id, version: skills.version })
      .from(agentSkills)
      .innerJoin(skills, eq(skills.id, agentSkills.skillId))
      .where(
        and(
          eq(agentSkills.orgId, ctx.orgId),
          eq(agentSkills.agentId, ctx.agentId),
          eq(agentSkills.enabled, true),
          eq(skills.orgId, ctx.orgId),
          inArray(
            skills.id,
            refs.map((r) => r.id),
          ),
          isNull(skills.deletedAt),
        ),
      );
    if (
      current.length !== refs.length ||
      refs.some((r) => !current.some((s) => s.id === r.id && s.version === r.version))
    )
      return unavailable("assignment_or_version_changed");
    if (ctx.signal?.aborted) return unavailable("canceled");
    const finished = now();
    if (!Number.isSafeInteger(finished) || finished < started || finished >= started + OBSERVATION_MS)
      return unavailable("observation_expired");
    const selected = current.sort((a, b) => a.id.localeCompare(b.id));
    return {
      version: VERSION,
      status: "preview_only",
      reason: "activation_unverified",
      skills: selected,
      activation: "unverified",
      authority: false,
      canExecute: false,
      readiness: "metadata_only",
      visibilityEvidence: "native_assignment_and_caller_reach",
      sourceContextPrivacy: "unverified",
      modelCalls: 0,
      capturedAt: started,
      expiresAt: started + OBSERVATION_MS,
      fingerprint: sha256(
        canonicalJson({
          version: VERSION,
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          channelId: ctx.channelId,
          threadRootId: ctx.threadRootId,
          triggerMessageId: ctx.triggerMessageId,
          taskId: native.run.issueId,
          authority: { kind: authority.kind, personId: authority.personId },
          reader,
          skills: selected,
          keys: [...keys].sort(),
        }),
      ),
    };
  } catch {
    return unavailable("native_evidence_unavailable");
  }
}
