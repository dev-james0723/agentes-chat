import { and, eq, inArray, schema } from "@agenteschat/db";
import { type RunAuthority, runAuthority } from "./authority";
import { claimNativeSkillRead } from "./contextual-skill-native-read-store";
import {
  type SkillReadSurfaceDescriptor,
  type SkillReadSurfaceSeal,
  sealSkillReadSurface,
} from "./contextual-skill-read-surface";
import { sha256 } from "./crypto";
import { canonicalJson } from "./tools/json-schema";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tools/types";

type Operation = SkillReadSurfaceDescriptor["selected"]["operation"];
export interface NativeSkillReadScope {
  agentId: string;
  runId: string;
  skillId: string;
  operation: Operation;
}
export interface NativeSkillReadConfig {
  canary: readonly NativeSkillReadScope[];
}
export interface NativeSkillReadBinding {
  orgId: string;
  agentId: string;
  runId: string;
  stepId: string;
  toolUseId: string;
  toolName: "load_skill" | "read_skill_file";
  authorityFingerprint: string;
  nativeEpoch: Readonly<NativeSkillReadEpoch>;
  nativeEpochFingerprint: string;
  inputHash: string;
  input: Readonly<{ name: string; path?: string }>;
}
export interface NativeSkillReadEpoch {
  schema: "native-skill-read-epoch/1";
  orgId: string;
  agentId: string;
  runId: string;
  channelId: string;
  threadRootId: string;
  triggerMessageId: string;
  background: boolean;
  workId: string | null;
  issueId: string | null;
  pendingMessageIds: readonly string[];
  steeredByPresent: boolean;
  steeredBy: string | null;
  brainSessionId: string | null;
  vendorContext: "unknown_vendor_context";
}
export const nativeSkillReadAuthorityFingerprint = (authority: RunAuthority | null) => sha256(canonicalJson(authority));
/** A bounded projection of actual native DB inputs. Hashing arbitrary JSON grants no authority. */
export function nativeSkillReadEpoch(run: typeof schema.agentRuns.$inferSelect): Readonly<NativeSkillReadEpoch> | null {
  const transcript = run.transcript;
  const present = !!transcript && Object.hasOwn(transcript, "steeredBy");
  const steering = present ? transcript?.steeredBy : null;
  if (steering !== null && typeof steering !== "string") return null;
  if (!Array.isArray(run.pendingMessageIds) || !run.pendingMessageIds.every((id) => typeof id === "string"))
    return null;
  return Object.freeze({
    schema: "native-skill-read-epoch/1",
    orgId: run.orgId,
    agentId: run.agentId,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    background: run.background,
    workId: run.workId,
    issueId: run.issueId,
    pendingMessageIds: Object.freeze([...run.pendingMessageIds]),
    steeredByPresent: present,
    steeredBy: steering,
    brainSessionId: run.brainSessionId,
    vendorContext: "unknown_vendor_context",
  });
}
export function nativeSkillReadEpochFingerprint(run: typeof schema.agentRuns.$inferSelect): string | null {
  const epoch = nativeSkillReadEpoch(run);
  return epoch ? sha256(canonicalJson(epoch)) : null;
}
declare const callBrand: unique symbol;
export type NativeSkillReadCall = { readonly [callBrand]: true };
type Surface = Extract<SkillReadSurfaceSeal, { status: "sealed_observation" }>;
interface Prepared {
  selected: SkillReadSurfaceDescriptor["selected"];
  output: ToolOutput;
  rawSelectedBytes: Uint8Array | null;
  listing: string | null;
  readerTruncated: boolean;
  omitted: boolean;
}
interface CallState {
  binding: Readonly<NativeSkillReadBinding>;
  scopes: readonly NativeSkillReadScope[];
  legacy: boolean;
  blocked: boolean;
  prepared?: Prepared;
  finalized?: { content: string; suffix: string | null; sanitized: boolean; gatewayTruncated: boolean };
  seal?: Surface;
}
const nativeTools = new WeakSet<ToolDefinition>();
const states = new WeakMap<NativeSkillReadCall, CallState>();
const contexts = new WeakMap<ToolContext, NativeSkillReadCall>();
const uuid = (v: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export const NATIVE_SKILL_READ_REFUSAL = "This scoped skill read could not be verified. No skill content was released.";
export function registerNativeSkillReadTool(tool: ToolDefinition) {
  nativeTools.add(tool);
}

/** Called only inside the genuine Gateway after its current schema/grants/policy/checks pass. */
export async function beginNativeSkillRead(
  ctx: ToolContext,
  tool: ToolDefinition,
  stepId: string | undefined,
  input: Record<string, unknown>,
  config: NativeSkillReadConfig | undefined,
  authority: RunAuthority | null,
): Promise<NativeSkillReadCall | null> {
  if (!config || !nativeTools.has(tool) || !["load_skill", "read_skill_file"].includes(tool.name)) return null;
  const scopes = config.canary.filter((s) => s.agentId === ctx.agentId && s.runId === ctx.runId);
  if (!scopes.length) return null;
  if (
    !stepId ||
    ![ctx.orgId, ctx.agentId, ctx.runId, stepId].every(uuid) ||
    !ctx.toolUseId ||
    authority?.kind !== "person"
  )
    return null;
  if (typeof input.name !== "string" || (tool.name === "read_skill_file" && typeof input.path !== "string"))
    return null;
  // Only the opted-in native path reads this row. Capture never comes from ctx/model JSON.
  const [run] = await ctx.db
    .select()
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.orgId, ctx.orgId),
        eq(schema.agentRuns.agentId, ctx.agentId),
        eq(schema.agentRuns.id, ctx.runId),
      ),
    );
  if (
    !run ||
    run.status !== "running" ||
    run.channelId !== ctx.channelId ||
    run.threadRootId !== ctx.threadRootId ||
    run.triggerMessageId !== ctx.triggerMessageId ||
    ctx.signal?.aborted
  )
    return null;
  const epoch = nativeSkillReadEpoch(run),
    epochFingerprint = nativeSkillReadEpochFingerprint(run);
  if (!epoch || !epochFingerprint) return null;
  const currentAuthority = await runAuthority(ctx.db, run);
  const authorityFingerprint = nativeSkillReadAuthorityFingerprint(currentAuthority);
  if (authorityFingerprint !== nativeSkillReadAuthorityFingerprint(authority)) return null;
  const normalized = Object.freeze({
    name: input.name,
    ...(tool.name === "read_skill_file" ? { path: input.path as string } : {}),
  });
  const call = Object.freeze({}) as NativeSkillReadCall;
  states.set(call, {
    binding: Object.freeze({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      stepId,
      toolUseId: ctx.toolUseId,
      toolName: tool.name as NativeSkillReadBinding["toolName"],
      authorityFingerprint,
      nativeEpoch: epoch,
      nativeEpochFingerprint: epochFingerprint,
      inputHash: sha256(canonicalJson(normalized)),
      input: normalized,
    }),
    scopes: scopes.map((s) => Object.freeze({ ...s })),
    legacy: false,
    blocked: false,
  });
  contexts.set(ctx, call);
  return call;
}
/** Routing into an opted-in approval read, not evidence of permission. OFF performs no query. */
export async function nativeSkillReadTargeted(
  ctx: ToolContext,
  tool: ToolDefinition,
  input: Record<string, unknown>,
  config?: NativeSkillReadConfig,
): Promise<boolean> {
  if (
    !config ||
    !nativeTools.has(tool) ||
    !["load_skill", "read_skill_file"].includes(tool.name) ||
    typeof input.name !== "string"
  )
    return false;
  const operation: Operation =
    tool.name === "load_skill"
      ? "load_skill"
      : typeof input.path === "string" && input.path.endsWith("/")
        ? "folder_listing"
        : "stored_text";
  const ids = config.canary
    .filter((s) => s.agentId === ctx.agentId && s.runId === ctx.runId && s.operation === operation)
    .map((s) => s.skillId);
  if (!ids.length) return false;
  const [row] = await ctx.db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(
      and(
        eq(schema.skills.orgId, ctx.orgId),
        eq(schema.skills.slug, input.name.trim().toLowerCase()),
        inArray(schema.skills.id, ids),
      ),
    )
    .limit(1);
  return !!row;
}
export function nativeSkillReadBinding(ctx: ToolContext, call: unknown): Readonly<NativeSkillReadBinding> | null {
  if (!call || typeof call !== "object") return null;
  const state = states.get(call as NativeSkillReadCall);
  const b = state?.binding;
  return b &&
    b.orgId === ctx.orgId &&
    b.agentId === ctx.agentId &&
    b.runId === ctx.runId &&
    b.toolUseId === ctx.toolUseId
    ? b
    : null;
}
export function nativeSkillReadSurface(
  ctx: ToolContext,
  call: unknown,
  sealed: unknown,
): Readonly<SkillReadSurfaceDescriptor> | null {
  if (!nativeSkillReadBinding(ctx, call)) return null;
  const state = states.get(call as NativeSkillReadCall);
  return state?.seal && state.seal === sealed ? state.seal.descriptor : null;
}
export function nativeSkillReadScoped(ctx: ToolContext, skillId: string, operation: Operation): boolean {
  const call = contexts.get(ctx),
    state = call && states.get(call);
  if (!state) return false;
  const scoped = state.scopes.some((s) => s.skillId === skillId && s.operation === operation);
  state.legacy = !scoped;
  return scoped;
}
export function nativeSkillReadPending(ctx: ToolContext): boolean {
  const call = contexts.get(ctx),
    state = call && states.get(call);
  return !!state && !state.legacy;
}
export function refuseNativeSkillRead(ctx: ToolContext): ToolOutput {
  const call = contexts.get(ctx),
    state = call && states.get(call);
  if (state) state.blocked = true;
  return { content: NATIVE_SKILL_READ_REFUSAL, isError: true };
}
/** Sidecar stays in native memory, bound to the call, never in output.data or a model-visible argument. */
export function prepareNativeSkillRead(ctx: ToolContext, prepared: Prepared): ToolOutput {
  const call = contexts.get(ctx),
    state = call && states.get(call);
  if (!state || state.legacy) return prepared.output;
  if (prepared.output.outcome || prepared.output.images?.length || prepared.selected.orgId !== ctx.orgId)
    return refuseNativeSkillRead(ctx);
  state.prepared = {
    ...prepared,
    selected: Object.freeze({ ...prepared.selected }),
    output: { ...prepared.output },
    rawSelectedBytes: prepared.rawSelectedBytes ? new Uint8Array(prepared.rawSelectedBytes) : null,
  };
  return prepared.output;
}
/** Invoked by the real outputOf finalizer; its capped clone need not retain object identity. */
export function finalizeNativeSkillRead(
  ctx: ToolContext,
  before: ToolOutput,
  after: ToolOutput,
  facts: { suffix: string | null; sanitized: boolean; gatewayTruncated: boolean },
): void {
  const call = contexts.get(ctx),
    state = call && states.get(call);
  if (!state || state.legacy) return;
  if (!state.prepared || state.prepared.output.content !== before.content || after.outcome || after.images?.length) {
    state.blocked = true;
    return;
  }
  state.finalized = { content: after.content, ...facts };
}
/** No body can reach Gateway consumers until the genuine persisted store has claimed this exact native read. */
export async function completeNativeSkillRead(
  ctx: ToolContext,
  call: NativeSkillReadCall,
  finalizedOutput: ToolOutput,
): Promise<ToolOutput> {
  const state = states.get(call);
  if (state?.legacy) return finalizedOutput;
  if (
    !state ||
    !nativeSkillReadBinding(ctx, call) ||
    state.blocked ||
    ctx.signal?.aborted ||
    !state.prepared ||
    !state.finalized ||
    finalizedOutput.content !== state.finalized.content ||
    finalizedOutput.outcome ||
    finalizedOutput.images?.length
  )
    return refuseNativeSkillRead(ctx);
  const p = state.prepared,
    f = state.finalized;
  const seal = sealSkillReadSurface({
    selected: p.selected,
    result: { type: "result", output: finalizedOutput },
    sidecar: {
      rawSelectedBytes: p.rawSelectedBytes,
      listing: p.listing,
      preGatewayContent: p.output.content,
      finalizerSuffix: f.suffix,
    },
    flags: {
      complete: !(p.readerTruncated || p.omitted || f.gatewayTruncated || f.sanitized),
      readerTruncated: p.readerTruncated,
      gatewayTruncated: f.gatewayTruncated,
      omitted: p.omitted,
      sanitized: f.sanitized,
    },
  });
  if (seal.status !== "sealed_observation") return refuseNativeSkillRead(ctx);
  state.seal = seal;
  try {
    const claimed = await claimNativeSkillRead(ctx, call, seal);
    if (claimed.status !== "claimed") return refuseNativeSkillRead(ctx);
    // Exact immutable bytes, not a second native read. A receipt never contains private content.
    return {
      ...finalizedOutput,
      content: new TextDecoder().decode(seal.readReturnedBytes()),
      data: { ...finalizedOutput.data, skillReadActivation: claimed.receipt },
    };
  } catch {
    return refuseNativeSkillRead(ctx);
  }
}
