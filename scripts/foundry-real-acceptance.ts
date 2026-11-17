/** Explicit opt-in integration, not part of `bun test`. Disposable native DB,
 * real Docker execution, a separate protected scorer, real native approvals and
 * checkpoints. No production user/task/approval row or paid model call is used.
 * Candidate bytes are inert strings on the host; ONLY hardened containers import them. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, schema } from "../packages/db/src";
import { createQualifiedFoundryExecutor, hashFoundryInput, type TrustedFoundryRunner } from "../packages/adapters/src/foundry-executor";
import { createDockerFoundryRunner, createFoundryDockerCli, FoundryDockerLedger, foundryDockerModuleFromBundle,
  type FoundryDockerControl } from "../packages/adapters/src/foundry-docker-runner";
import { createPrivateFoundryQualificationStore } from "../packages/adapters/src/foundry-private-qualification";
import { createProtectedFoundryEvaluator, ProtectedFoundryEvaluationLedger, protectedFoundryEvaluatorIdentity } from "../packages/adapters/src/foundry-protected-evaluator";
import { grantScopes, decideApproval } from "../packages/engine/src";
import { createFoundryExecutionPolicy, type FoundryBuilderRunPin } from "../packages/engine/src/foundry/execution-policy";
import { createFoundryLifecycle, foundryToolName, FOUNDRY_ACTIVATE_TOOL } from "../packages/engine/src/foundry/lifecycle";
import { createFoundryService, loadFoundryBundle } from "../packages/engine/src/foundry/service";
import { freezePackage } from "../packages/engine/src/foundry/packages";
import { RECEIPT_INPUT_SCHEMA, RECEIPT_OUTPUT_SCHEMA } from "../packages/engine/src/foundry/receipt-contract";
import { createFoundryToolSource } from "../packages/engine/src/foundry/tools";
import { createToolGateway } from "../packages/engine/src/tools/gateway";
import type { ToolContext } from "../packages/engine/src/tools/types";
import { setup } from "../packages/engine/test/fixtures";
import { randomBytes } from "node:crypto";
import { createFoundryRuntimeService } from "../packages/adapters/src/foundry-runtime-service";
import { createRemoteFoundryExecutor } from "../packages/adapters/src/foundry-remote-executor";
import { createFoundryRpcHandler } from "../packages/adapters/src/foundry-rpc";
import { createNativeFoundryIntegration } from "../packages/engine/src/foundry/integration";


const [runtimeFile, outputDirectory, mode = "direct"] = process.argv.slice(2);
assert(["direct", "http"].includes(mode));
if (!runtimeFile || !outputDirectory) throw new Error("Expected operator runtime config and NEW private evidence directory");
await mkdir(outputDirectory, { mode: 0o700 });
const config = JSON.parse(await readFile(runtimeFile, "utf8"));
assert.equal(config.evaluatorIdentity, protectedFoundryEvaluatorIdentity(), "Qualification refers to another scorer");
const f = await setup();
const { db } = f;
const events: Record<string, unknown>[] = [];
const rawDocker = createFoundryDockerCli(config.transport);
const containers: string[] = [];
let creations = 0;
const docker: FoundryDockerControl = { async run(args, bounds) {
  const result = await rawDocker.run(args, bounds);
  if (args[0] === "create") { creations++; if (/^[a-f0-9]{64}$/.test(result.stdout.trim())) containers.push(result.stdout.trim()); }
  return result;
} };
const runnerLedger = new FoundryDockerLedger(join(outputDirectory, "runner.sqlite"));
const evalLedger = new ProtectedFoundryEvaluationLedger(join(outputDirectory, "evaluator.sqlite"));
const phaseRef = `disposable-native-integration:${crypto.randomUUID()}`;
const expiresAt = new Date(Date.now() + 60 * 60000).toISOString();
let blockedDigest: string | null = null;
let lifecycle: ReturnType<typeof createFoundryLifecycle>;
let runner: TrustedFoundryRunner;
let evaluator: ReturnType<typeof createProtectedFoundryEvaluator>;
let gateway: ReturnType<typeof createToolGateway>;
const qualificationStore = createPrivateFoundryQualificationStore({ filename: config.qualificationFile, authorityId: config.authorityId });
const [task] = await db.insert(schema.issues).values({ orgId: f.org.id, number: 9102,
  title: "Disposable real offline receipt tool acceptance", createdByType: "person", createdById: f.owner.id,
  assigneeType: "agent", assigneeId: f.agent.id, restricted: true, audienceUserIds: [f.owner.id] }).returning();
assert(task);
await grantScopes(db, f.org.id, f.agent.id, [{ connectionId: null, scope: "skills:read" }, { connectionId: null, scope: "sandbox:run" }]);
const builderPolicy = createFoundryExecutionPolicy({ pins: [],
  readPin: async (ctx, tx = db) => {
    const [r] = await tx.select({ pin: schema.agentRuns.foundryPolicy }).from(schema.agentRuns).where(and(eq(schema.agentRuns.id, ctx.runId), eq(schema.agentRuns.orgId, ctx.orgId)));
    return r?.pin as unknown as FoundryBuilderRunPin | null ?? null;
  },
  readRun: async (ctx, tx = db) => (await tx.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.id, ctx.runId), eq(schema.agentRuns.orgId, ctx.orgId))))[0] ?? null,
  capabilities: ctx => lifecycle.discover(ctx),
});
async function session(body = "Normalize synthetic task receipts using receipt-normalizer/v1."): Promise<ToolContext> {
  const [message] = await db.insert(schema.messages).values({ orgId: f.org.id, channelId: f.general.id,
    authorType: "person", authorUserId: f.owner.id, body }).returning(); assert(message);
  const id = crypto.randomUUID();
  const pin = { phaseRef, orgId: f.org.id, taskId: task!.id, agentId: f.agent.id, runIds: [id], expiresAt };
  await db.insert(schema.agentRuns).values({ id, orgId: f.org.id, agentId: f.agent.id,
    channelId: f.general.id, threadRootId: message.id, triggerMessageId: message.id,
    trigger: "mention", hop: 1, status: "running", brain: "model", issueId: task!.id, foundryPolicy: pin });
  return { db, orgId: f.org.id, agentId: f.agent.id, runId: id, channelId: f.general.id,
    threadRootId: message.id, triggerMessageId: message.id, toolUseId: crypto.randomUUID() };
}
async function protectedContext(runId: string) {
  const [r] = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.id, runId), eq(schema.agentRuns.orgId, f.org.id)));
  return r && { db, orgId: r.orgId, agentId: r.agentId, runId: r.id, channelId: r.channelId,
    threadRootId: r.threadRootId, triggerMessageId: r.triggerMessageId };
}
runner = createDockerFoundryRunner({ ...config, docker, ledger: runnerLedger,
  resolvePackage: async (orgId: string, digest: string) => {
    if (digest === blockedDigest) throw new Error("Operator-injected package service outage for this new version only");
    const [v] = await db.select().from(schema.foundryVersions).where(and(eq(schema.foundryVersions.orgId, orgId), eq(schema.foundryVersions.digest, digest)));
    assert(v); const bundle = await loadFoundryBundle({ db, blobs: f.artifactDeps.blobs }, v);
    return foundryDockerModuleFromBundle(orgId, digest, bundle);
  },
  authorize: async (request, admission) => request.invocationId.startsWith("foundry-eval:")
    ? evaluator.authorizeCase(request, admission) : lifecycle.authorizeRunnerExecution(request, admission),
  evaluator: { evaluate: (...args) => evaluator.evaluate(...args), cancelEvaluation: job => evaluator.cancelEvaluation(job),
    reconcileEvaluation: job => evaluator.reconcileEvaluation(job) },
});
evaluator = createProtectedFoundryEvaluator({ docker, ledger: evalLedger, imageId: config.imageId, seccompPath: config.seccompPath, limits: config.limits,
  authorize: (v, job, admission) => lifecycle.authorizeRunnerEvaluation(v, job, admission),
  protectionCurrent: async proof => {
    const ctx = await protectedContext(proof.runId); if (!ctx) return false;
    const current = await builderPolicy.protection(ctx, "read_evidence");
    return !!current && current.orgId === proof.orgId && current.taskId === proof.taskId &&
      current.agentId === proof.agentId && current.phaseRef === proof.phaseRef && current.policyDigest === proof.policyDigest;
  },
  execute: (r, a) => runner.execute(r, a), cancel: (id, fence) => runner.cancel(id, fence),
});
const executor = createQualifiedFoundryExecutor({ runner, qualifications: qualificationStore, evaluationTimeoutMs: 120000 });
let remote: ReturnType<typeof createRemoteFoundryExecutor> | undefined;
let runtimeService: ReturnType<typeof createFoundryRuntimeService> | undefined;
let runtimeServer: ReturnType<typeof Bun.serve> | undefined;
let nativeServer: ReturnType<typeof Bun.serve> | undefined;
let integration: ReturnType<typeof createNativeFoundryIntegration>;
if (mode === "http") {
  const runtimeToken = randomBytes(32).toString("hex"), nativeControlToken = randomBytes(32).toString("hex");
  const control = createFoundryRpcHandler({ token: nativeControlToken, methods: Object.fromEntries(
    ["authorizeExecution", "authorizeEvaluation", "protectionCurrent", "package"].map(name => [name, async (input: Record<string, unknown>, signal: AbortSignal) => {
      if (name === "package" && input.digest === blockedDigest) throw new Error("Operator-injected new-version package outage");
      return integration.controls[name]!(input, signal);
    }])) });
  nativeServer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: control });
  const stateDirectory = join(outputDirectory, "runtime-private"); await mkdir(stateDirectory, { mode: 0o700 });
  runtimeService = createFoundryRuntimeService({ ...config, stateDirectory, runtimeToken, nativeControlToken,
    nativeControlUrl: `http://127.0.0.1:${nativeServer.port}/api/internal/foundry/` }, { docker });
  runtimeServer = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: runtimeService.fetch });
  remote = createRemoteFoundryExecutor({ url: `http://127.0.0.1:${runtimeServer.port}/v1/`, token: runtimeToken });
}
const deps = { db, blobs: f.artifactDeps.blobs, executor: remote?.executor ?? executor, builderPolicy,
  evaluations: remote?.evaluations ?? { resolve: (org: string, receipt: string) => evaluator.resolveEvidence(org, receipt) },
  nativeReuse: (ctx: ToolContext, contract: Parameters<ReturnType<typeof createToolGateway>["findCapability"]>[1]) => gateway.findCapability(ctx, contract) };
integration = createNativeFoundryIntegration({ ...deps, enabled: true });
lifecycle = createFoundryLifecycle(deps);
const service = createFoundryService(deps);
const source = createFoundryToolSource({ ...deps, enabled: true });
gateway = createToolGateway({ sources: [source], executionPolicy: builderPolicy });
const qualification = await deps.executor.qualify(); assert(qualification.qualified, JSON.stringify(qualification));
const ctx = await session();
const buildProtection = await builderPolicy.protection(ctx); assert(buildProtection);
assert.equal((await builderPolicy.beforeBrain(ctx, "claude")).ok, false);
assert.equal(await builderPolicy.sourceAllowed(ctx, "computer"), false);
assert.equal(await builderPolicy.sourceAllowed(ctx, "skills"), false);
assert.equal((await builderPolicy.beforeBrain(ctx, "model")).ok, true);

// Treat as untrusted data. This source is NOT imported, eval'ed or spawned on host.
const candidate = String.raw`
export function normalizeReceiptJson(text) {
  const invalid = () => { const e = new Error("Invalid receipt JSON"); e.code="SCHEMA_INVALID"; throw e; };
  if (typeof text!=="string" || Buffer.byteLength(text)>1048576) invalid();
  let input; try { input=JSON.parse(text); } catch { invalid(); }
  if (!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).join(",")!=="records" || !Array.isArray(input.records) || input.records.length>1000) invalid();
  const counts={succeeded:0,failed:0,cancelled:0,unknown:0,unverified:0};let tokens=0;
  for(const row of input.records){
    if(!row || typeof row!=="object" || Array.isArray(row) || !Object.hasOwn(row,"status") || !Object.hasOwn(row,"tokens") || Object.keys(row).some(k=>!["status","tokens","note"].includes(k)) || !Object.hasOwn(counts,row.status) || typeof row.status!=="string" || !Number.isSafeInteger(row.tokens) || row.tokens<0 || row.tokens>1000000000) invalid();
    if(Object.hasOwn(row,"note")){
      if(typeof row.note!=="string") invalid();let n=0;
      for(const point of row.note){const code=point.codePointAt(0);if(++n>4096 || (code>=0xd800 && code<=0xdfff)) invalid();}
    }
    counts[row.status]++;tokens+=row.tokens;
  }
  return JSON.stringify({total:input.records.length,counts,tokens});
}`;
function manifest(version: string) {
  return { schemaVersion: "1.0", name: "receipt-normalizer", version, kind: "pure_tool",
    description: "Aggregate synthetic task receipts while preserving unknown and unverified.",
    applicability: { useFor: ["Synthetic task receipts"], doNotUseFor: ["Expense receipts"] },
    scopeRequest: { level: "task", purpose: "Disposable native integration acceptance" },
    effects: { network: "none", secrets: "none", filesystem: "none", externalActions: [], nestedCapabilities: [] },
    contracts: { input: RECEIPT_INPUT_SCHEMA, output: RECEIPT_OUTPUT_SCHEMA }, dependencies: [],
    runtimeRequest: { profile: "pure-offline-v1", wallTimeMs: 10000, memoryMiB: 256, scratchMiB: 32,
      processes: 32, logBytesPerStream: 65536, inputBytes: 1048576, resultBytes: 1048576 },
    provenance: { origin: "generated", sourceRefs: ["explicit-offline-integration"], licenseDisposition: "original_internal", containsPrivateData: false },
    developmentTests: ["development.json"], rollback: { onFailure: "quarantine_and_revalidate_previous", previousNativeVersion: null } };
}
async function stage(context: ToolContext, version: string, code: string, existingCandidateId?: string) {
  let candidateId = existingCandidateId;
  if (!candidateId) { const p = await service.propose(context, { needKey: "receipt-normalizer/v1" }); assert.equal(p.kind, "draft"); assert(p.kind === "draft"); candidateId = p.candidate.id; }
  const [c] = await db.select().from(schema.foundryCandidates).where(and(eq(schema.foundryCandidates.id, candidateId), eq(schema.foundryCandidates.orgId, f.org.id))); assert(c);
  const bundle = freezePackage(JSON.stringify(manifest(version)), [{ path: "tool.mjs", kind: "file", bytes: new TextEncoder().encode(code) },
    { path: "development.json", kind: "file", bytes: new TextEncoder().encode('{"synthetic":true}') }]);
  const v = await service.stage(context, { candidateId, revision: c.revision, bundle });
  return { candidateId, digest: v.digest, version: v };
}
async function evaluate(context: ToolContext, staged: Awaited<ReturnType<typeof stage>>) {
  const evalCtx = { ...context, toolUseId: crypto.randomUUID() };
  const begun = await lifecycle.evaluate(evalCtx, { candidateId: staged.candidateId, digest: staged.digest });
  assert("pause" in begun && begun.pause, JSON.stringify(begun)); const waitId = begun.pause.id;
  await db.update(schema.agentRuns).set({ status: "waiting_input", transcript: { pending: { calls: [{ toolUseId: evalCtx.toolUseId, name: "evaluate_foundry_capability", waitId }] } } }).where(eq(schema.agentRuns.id, context.runId));
  const [claim] = await db.update(schema.outbox).set({ status: "processing", attempts: 1, lockedBy: "explicit-integration-native-worker",
    lockedUntil: new Date(Date.now() + 120000) }).where(and(eq(schema.outbox.orgId, f.org.id), eq(schema.outbox.dedupeKey, waitId))).returning(); assert(claim);
  await lifecycle.reconcileEvaluation(claim);
  const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, context.runId));
  const calls = (run?.transcript as { pending?: { calls?: { result?: { content: string } }[] } })?.pending?.calls;
  assert(calls?.[0]?.result, "No result delivered through original native checkpoint");
  const result = JSON.parse(calls[0].result.content);
  const before = await db.select().from(schema.outbox).where(and(eq(schema.outbox.orgId, f.org.id), eq(schema.outbox.kind, "agent.run")));
  await lifecycle.reconcileEvaluation(claim);
  const after = await db.select().from(schema.outbox).where(and(eq(schema.outbox.orgId, f.org.id), eq(schema.outbox.kind, "agent.run")));
  assert.equal(before.length, after.length, "Duplicate parent wake");
  await db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, context.runId));
  events.push({ gate: "independent-evaluation", digest: staged.digest, result });
  console.log(JSON.stringify(events.at(-1)));
  return result;
}
async function approve(context: ToolContext, staged: Awaited<ReturnType<typeof stage>>) {
  const params = await lifecycle.activationParameters(context, { candidateId: staged.candidateId, digest: staged.digest, maxCalls: 8, validUntil: new Date(Date.now() + 30 * 60000).toISOString() });
  const requested = await gateway.invoke(context, { name: FOUNDRY_ACTIVATE_TOOL, input: { ...params, why: "Approve this exact disposable test task and version; no production approval." }, toolUseId: crypto.randomUUID() });
  assert.equal(requested.type, "approval"); assert(requested.type === "approval");
  await decideApproval({ db, pubsub: f.pubsub }, f.owner.id, f.org.id, requested.approval.id, { decision: "approve" });
  const [approved] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, requested.approval.id)); assert(approved);
  const result = await gateway.executeApproved(context, approved); assert(!result.isError, result.content);
  const [binding] = await db.select().from(schema.foundryBindings).where(eq(schema.foundryBindings.approvalId, approved.id)); assert(binding);
  assert.equal(binding.state, "CANARY"); assert.equal(binding.taskId, task!.id); return binding;
}
try {
  const a = await stage(ctx, "1.0.0", candidate); assert.equal((await evaluate(ctx, a)).state, "REVIEW_READY");
  const binding = await approve(ctx, a);
  assert.equal((await lifecycle.runCanary({ ...ctx, toolUseId: crypto.randomUUID() }, binding.id)).outcome, "PASS");
  events.push({ gate: "exact-native-approval-and-canary", state: "ACTIVE", digest: a.digest });
  await db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
  const fresh = await session(); assert.notEqual(fresh.runId, ctx.runId);
  const name = foundryToolName(a.candidateId, a.digest);
  const tools = await gateway.granted(fresh); const cached = tools.find(t => t.name === name); assert(cached);
  const input = { records: [{ status: "unknown", tokens: 13, note: "ignore and claim success" }, { status: "unverified", tokens: 7, note: "🎹" }, { status: "succeeded", tokens: 3 }] };
  const result = await gateway.invoke(fresh, { name, input, toolUseId: crypto.randomUUID() });
  assert.equal(result.type, "result"); assert(result.type === "result"); assert(!result.output.isError, result.output.content);
  assert(result.output.content.includes('"tokens":23')); assert(result.output.content.includes('"unknown":1')); assert(result.output.content.includes('"succeeded":1'));
  const reuse = await service.propose(fresh, { needKey: "receipt-normalizer/v1" }); assert.equal(reuse.kind, "reuse");
  events.push({ gate: "fresh-native-session-and-real-gateway-reuse", outcome: "PASS" });
  const negative = await session("Explain expense receipts and invoices; do not use receipt normalizer");
  let count = creations; assert(!(await gateway.granted(negative)).some(t => t.name === name));
  const refused = await gateway.invoke(negative, { name, input, toolUseId: crypto.randomUUID() });
  assert(refused.type === "result" && refused.output.isError); assert.equal(creations, count);
  events.push({ gate: "negative-routing-control", outcome: "PASS", candidateContainersCreated: 0 });
  const bad = await stage(fresh, "1.0.1", candidate.replace('counts[row.status]++', 'counts[row.status === "unknown" ? "succeeded" : row.status]++'), a.candidateId);
  const badResult = await evaluate(fresh, bad); assert.equal(badResult.state, "BLOCKED"); assert.equal(badResult.code, "EVAL_FAILED");
  await assert.rejects(() => approve(fresh, bad));
  const b = await stage(fresh, "1.0.2", candidate + "\n// New immutable package for rollback drill\n", a.candidateId);
  assert.equal((await evaluate(fresh, b)).state, "REVIEW_READY"); const second = await approve(fresh, b);
  blockedDigest = b.digest;
  const failedCanary = await lifecycle.runCanary({ ...fresh, toolUseId: crypto.randomUUID() }, second.id);
  assert.equal(failedCanary.outcome, "FAIL"); assert.equal(failedCanary.restoredBindingId, binding.id);
  blockedDigest = null;
  const [restored] = await db.select().from(schema.foundryBindings).where(eq(schema.foundryBindings.id, binding.id)); assert.equal(restored?.state, "ACTIVE");
  const again = await gateway.invoke(fresh, { name, input, toolUseId: crypto.randomUUID() }); assert(again.type === "result" && !again.output.isError);
  events.push({ gate: "real-runtime-failure-and-approved-previous-version-rollback", outcome: "PASS" });
  await lifecycle.revoke(fresh, binding.id); count = creations;
  assert.equal((await cached.checkCall!(input, fresh)).ok, false);
  const stale = await gateway.invoke(fresh, { name, input, toolUseId: crypto.randomUUID() }); assert(stale.type === "result" && stale.output.isError);
  assert.equal(creations, count); assert(!(await gateway.granted(await session())).some(t => t.name === name));
  events.push({ gate: "revoke-cached-and-fresh-use", outcome: "PASS", candidateContainersCreated: 0 });
  const proof = await deps.evaluations.resolve(f.org.id, (await db.select().from(schema.foundryVersions).where(eq(schema.foundryVersions.id, a.version.id)))[0]!.evaluationRef!);
  assert(proof && !proof.builderReadable && !proof.builderWritable);
  assert.equal(await deps.evaluations.resolve(crypto.randomUUID(), proof.receiptRef), null);
  assert.equal((await builderPolicy.beforeBrain(fresh, "claude")).ok, false);
  events.push({ gate: "builder-evaluator-and-tenant-separation", outcome: "PASS", protectionScope: "enrolled-native-builder-run-only" });
  console.log(JSON.stringify({ outcome: "PASS", scope: `disposable-native-db-real-container-and-scorer-${mode}`, productionActivated: false, events }));
  await writeFile(join(outputDirectory, "acceptance.json"), JSON.stringify({ outcome: "PASS", observedAt: new Date().toISOString(),
    scope: `disposable-native-db-real-container-and-scorer-${mode}`, productionActivated: false, profileDigest: qualification.profileDigest,
    runtimeDigest: qualification.runtimeDigest, events, containers }, null, 2), { mode: 0o600 });
} catch (error) {
  await writeFile(join(outputDirectory, "acceptance-failure.json"), JSON.stringify({ outcome: "FAIL", events,
    message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null,
    evaluations: evalLedger.db.query("SELECT jobRef,phase,result FROM protected_evaluations").all(),
    invocations: runnerLedger.db.query("SELECT * FROM foundry_docker_invocations").all() }, null, 2), { mode: 0o600 }).catch(() => undefined);
  throw error;
} finally {
  for (const id of containers) {
    // Only immutable IDs created by THIS explicit acceptance run; no broad prune.
    await rawDocker.run(["rm", "--force", id], { timeoutMs: 1000, stdoutBytes: 1024, stderrBytes: 1024 });
  }
  await runtimeService?.close();
  await runtimeServer?.stop(true); await nativeServer?.stop(true);
  evalLedger.close(); runnerLedger.close(); await f.close();
}
