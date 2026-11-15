import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addRunStep,
  decideApproval,
  getSkill,
  grantScopes,
  insertMessage,
  listApprovals,
  openPersonAgentDm,
  saveSkill,
  type ToolContext,
} from "../src";
import { sha256 } from "../src/crypto";
import {
  mayViewSkillPublicationApproval,
  PUBLICATION_CONTRACT,
  prepareSkillPublication,
  verifySkillPublicationApproval,
} from "../src/skill-publication-approval";
import { actionHash } from "../src/tools/gateway";
import { canonicalJson } from "../src/tools/json-schema";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});
const now = new Date("2026-11-14T03:00:00.000Z");
const expires = new Date(now.getTime() + 10 * 60_000);
const marker = "SYNTHETIC_PRIVATE_DRAFT_0190";
const hash = (v: unknown) => sha256(canonicalJson(v));

async function world() {
  f = await setup({ skillTools: true, contextTools: true });
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "skills:read" },
    { connectionId: null, scope: "context:read" },
  ]);
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "person", userId: f.owner.id },
    body: "Fix the method, do not publish my private draft.",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: dm.id,
      triggerMessageId: message.id,
      threadRootId: message.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("run");
  const skill = await saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
    name: "generic-method",
    description: "Generic shared method",
    body: "Original public method",
    source: "manual",
    metadata: {},
  });
  await f.db.insert(schema.agentSkills).values({ orgId: f.org.id, agentId: f.agent.id, skillId: skill.id });
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: dm.id,
    triggerMessageId: message.id,
    threadRootId: message.id,
    toolUseId: "publication-exact-call",
  };
  // The actual native Gateway supplies the load receipt; no inference/network.
  const loaded = await f.tools?.invoke(ctx, { name: "load_skill", input: { name: skill.name }, toolUseId: "load" });
  expect(loaded?.type).toBe("result");
  const change = { skillId: skill.id, input: { name: skill.name, body: marker } };
  const sourcesHash = hash([{ kind: "message", id: message.id, hash: sha256(message.body), channels: [dm.id] }]);
  const audienceHash = hash({ channelId: dm.id, ownerUserId: f.owner.id, agentId: f.agent.id });
  const params = {
    contract: PUBLICATION_CONTRACT,
    input: change.input,
    publication: {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: dm.id,
      threadRootId: message.id,
      triggerMessageId: message.id,
      toolUseId: ctx.toolUseId,
      ownerUserId: f.owner.id,
      skillId: skill.id,
      baseVersion: skill.version,
      baseHash: sha256(skill.body),
      resourcesHash: hash([]),
      sourcesHash,
      audienceHash,
      purpose: "publish_to_org_skill_library",
      sourceCoverage: "current-dm-and-recorded-expand-only",
      issuedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    },
  };
  return { ctx, change, params, skill, dm, message, run };
}

async function seed(w: Awaited<ReturnType<typeof world>>, overrides: Record<string, unknown> = {}) {
  const [row] = await f.db
    .insert(schema.approvals)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: w.run.id,
      channelId: w.dm.id,
      threadRootId: w.message.id,
      toolUseId: w.ctx.toolUseId as string,
      tool: "update_skill",
      scope: "skills:read",
      connectionId: null,
      params: w.params,
      actionHash: actionHash({ tool: "update_skill", scope: "skills:read", connectionId: null, params: w.params }),
      title: "Share this exact draft with the organization skill library",
      detail: "",
      why: "Explicit one-time sharing approval is required.",
      ownerUserId: f.owner.id,
      requestedByUserId: f.owner.id,
      approvers: {
        userIds: [f.owner.id],
        label: "source owner",
        requestedBy: f.owner.id,
        requesterDecides: true,
        required: true,
      },
      expiresAt: expires,
      createdAt: now,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("approval");
  return row;
}

async function approve(w: Awaited<ReturnType<typeof world>>) {
  const row = await seed(w);
  await decideApproval({ db: f.db, pubsub: f.pubsub, now: () => now }, f.owner.id, f.org.id, row.id, {
    decision: "approve",
  });
  return row;
}

async function record(w: Awaited<ReturnType<typeof world>>, name: string, input: unknown) {
  const id = crypto.randomUUID();
  await addRunStep(f.db, w.run, "tool_call", { toolUseId: id, name, input });
  await addRunStep(f.db, w.run, "tool_result", {
    toolUseId: id,
    name,
    isError: false,
    content: "native fixture result",
  });
}

test("private preparation is opaque, read-only and never creates a broad native approval/proposal", async () => {
  const w = await world();
  const prepared = await prepareSkillPublication(w.ctx, w.change, now);
  expect(prepared.kind).toBe("approval_required");
  expect(JSON.stringify(prepared)).not.toContain(marker);
  expect(JSON.stringify(prepared)).not.toContain(w.message.body);
  expect(await f.db.select().from(schema.approvals)).toHaveLength(0);
  expect(await f.db.select().from(schema.contextProposals)).toHaveLength(0);
  expect((await getSkill(f.db, f.owner.id, f.org.id, w.skill.id)).body).toBe(w.skill.body);
});

test("actual native DB decision yields bounded proof only, not execution or privacy-wiring permission", async () => {
  const w = await world();
  const row = await approve(w);
  const proof = await verifySkillPublicationApproval(w.ctx, w.change, row.id, now);
  expect(proof.kind).toBe("verified_bounded_proof");
  expect(proof.mayPublish).toBe(false);
  expect((await f.db.select().from(schema.approvals))[0]?.executedAt).toBeNull();
  expect((await getSkill(f.db, f.owner.id, f.org.id, w.skill.id)).version).toBe(w.skill.version);
  expect(await mayViewSkillPublicationApproval(f.db, f.org.id, row.id, f.owner.id)).toBe(true);
});

test("pending/refused/expired/consumed approval and ctx.approved never stand in for one-time DB consent", async () => {
  const w = await world();
  const row = await seed(w);
  for (const patch of [
    { status: "pending" },
    { status: "refused" },
    { status: "canceled" },
    { status: "approved", decidedByUserId: null },
    { status: "approved", decidedByUserId: f.owner.id, decidedAt: now, expiresAt: new Date(now.getTime() - 1) },
    { status: "approved", decidedByUserId: f.owner.id, decidedAt: now, expiresAt: expires, executedAt: now },
  ]) {
    await f.db
      .update(schema.approvals)
      .set(patch as never)
      .where(eq(schema.approvals.id, row.id));
    expect((await verifySkillPublicationApproval({ ...w.ctx, approved: true }, w.change, row.id, now)).kind).toBe(
      "defer",
    );
  }
});

test("exact input, scope, identity, purpose, hash and version bindings reject independent tampering", async () => {
  const w = await world();
  const row = await approve(w);
  expect(
    (
      await verifySkillPublicationApproval(
        w.ctx,
        { ...w.change, input: { ...w.change.input, body: "different" } },
        row.id,
        now,
      )
    ).kind,
  ).toBe("defer");
  expect(
    (await verifySkillPublicationApproval({ ...w.ctx, agentId: crypto.randomUUID() }, w.change, row.id, now)).kind,
  ).toBe("defer");
  for (const patch of [
    { scope: "skills:write" },
    { runId: null },
    { actionHash: "0".repeat(64) },
    { params: { ...w.params, publication: { ...w.params.publication, purpose: "generic_tool_approval" } } },
  ]) {
    await f.db
      .update(schema.approvals)
      .set(patch as never)
      .where(eq(schema.approvals.id, row.id));
    expect((await verifySkillPublicationApproval(w.ctx, w.change, row.id, now)).kind).toBe("defer");
    await f.db
      .update(schema.approvals)
      .set({ scope: row.scope, runId: row.runId, actionHash: row.actionHash, params: row.params })
      .where(eq(schema.approvals.id, row.id));
  }
  await f.db
    .update(schema.skills)
    .set({ version: w.skill.version + 1 })
    .where(eq(schema.skills.id, w.skill.id));
  expect((await verifySkillPublicationApproval(w.ctx, w.change, row.id, now)).kind).toBe("defer");
});

test("another admin cannot view or supply source consent; native source ACL revocation fails closed", async () => {
  const w = await world();
  const other = await addMember(f.db, f.org.id, "admin", "outside-admin");
  const row = await approve(w);
  expect(await mayViewSkillPublicationApproval(f.db, f.org.id, row.id, other.id)).toBe(false);
  await f.db.update(schema.approvals).set({ decidedByUserId: other.id }).where(eq(schema.approvals.id, row.id));
  expect((await verifySkillPublicationApproval(w.ctx, w.change, row.id, now)).kind).toBe("defer");
  await f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.userId, f.owner.id));
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
});

test("unknown read and multi-owner are sanitized defer", async () => {
  const w = await world();
  await record(w, "read_wiki_page", { id: "not-a-private-source-proof" });
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
  const unknown = await prepareSkillPublication(w.ctx, w.change, now);
  expect(JSON.stringify(unknown)).not.toContain(marker);
  await f.db.delete(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, w.run.id));
  const other = await addMember(f.db, f.org.id, "member", "second-source-owner");
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: w.dm.id, userId: other.id });
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
});

test("fresh native load version is required before a changed target can be prepared", async () => {
  const w = await world();
  await f.db.update(schema.skills).set({ version: 2 }).where(eq(schema.skills.id, w.skill.id));
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
});

test("unsupported context/session/unknown IDs remain sanitized; no model metadata upgrades them", async () => {
  const w = await world();
  expect((await prepareSkillPublication(w.ctx, { ...w.change, skillId: "invalid-id" }, now)).kind).toBe("defer");
  expect(await mayViewSkillPublicationApproval(f.db, f.org.id, "invalid-id", f.owner.id)).toBe(false);
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: { privateContextComplete: true, public: true, approved: true } })
    .where(eq(schema.agentRuns.id, w.run.id));
  expect((await prepareSkillPublication({ ...w.ctx, approved: true }, w.change, now)).kind).toBe("defer");
});

test("native expand read is bound to same owner/source audience and invalidates an earlier proof", async () => {
  const w = await world();
  const row = await approve(w);
  const [item] = await f.db
    .insert(schema.contextItems)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      kind: "lesson",
      scopeType: "agent",
      scopeId: f.agent.id,
      content: "Synthetic same-owner private source",
      channelIds: [w.dm.id],
      sourceIds: [w.message.id],
      createdByKind: "person",
      createdById: f.owner.id,
    })
    .returning();
  if (!item) throw new Error("item");
  const result = await f.tools?.invoke(w.ctx, {
    name: "expand",
    input: { item_id: item.id },
    toolUseId: "native-expand",
  });
  expect(result?.type).toBe("result");
  if (result?.type === "result") expect(result.output.isError).not.toBe(true);
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("approval_required");
  expect((await verifySkillPublicationApproval(w.ctx, w.change, row.id, now)).kind).toBe("defer");
  await f.db
    .update(schema.contextItems)
    .set({ createdById: "unverified-other-owner" })
    .where(eq(schema.contextItems.id, item.id));
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
});

test("assignment, scope, transcript/session and resource-byte gaps cannot become sharing authority", async () => {
  const w = await world();
  await f.db.update(schema.agentSkills).set({ enabled: false }).where(eq(schema.agentSkills.skillId, w.skill.id));
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
  await f.db.update(schema.agentSkills).set({ enabled: true }).where(eq(schema.agentSkills.skillId, w.skill.id));
  await f.db.insert(schema.skillFiles).values({
    orgId: f.org.id,
    skillId: w.skill.id,
    version: w.skill.version,
    path: "reference.md",
    size: 3,
    mime: "text/plain",
    status: "stored",
  });
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
  await f.db.delete(schema.skillFiles).where(eq(schema.skillFiles.skillId, w.skill.id));
  await f.db
    .update(schema.agentRuns)
    .set({ brainSessionId: "prior-private-session" })
    .where(eq(schema.agentRuns.id, w.run.id));
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
  await f.db.update(schema.agentRuns).set({ brainSessionId: null }).where(eq(schema.agentRuns.id, w.run.id));
  await f.db.insert(schema.agentScopes).values({ orgId: f.org.id, agentId: f.agent.id, scope: "deny:update_skill" });
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
});

test("native privacy wiring withholds unqualified legacy support rows from broad views", async () => {
  const w = await world();
  const other = await addMember(f.db, f.org.id, "admin", "baseline-visible-admin");
  const row = await seed(w);
  const nativeList = await listApprovals(f.db, other.id, f.org.id);
  // The support proof still cannot authorize publishing; native views now withhold its legacy private envelope.
  expect(JSON.stringify(nativeList)).not.toContain(marker);
  expect(await mayViewSkillPublicationApproval(f.db, f.org.id, row.id, other.id)).toBe(false);
  expect((await getSkill(f.db, other.id, f.org.id, w.skill.id)).body).toBe(w.skill.body);
});

test("recomputed generic approval hashes and exact-content changes cannot change the publication purpose or source bindings", async () => {
  const w = await world();
  const row = await approve(w);
  for (const changes of [
    { purpose: "generic_tool_approval" },
    { sourcesHash: "0".repeat(64) },
    { baseVersion: 99 },
    { sourceCoverage: "model_says_public" },
  ]) {
    const params = { ...w.params, publication: { ...w.params.publication, ...changes } };
    const changedHash = actionHash({ tool: "update_skill", scope: "skills:read", connectionId: null, params });
    await f.db.update(schema.approvals).set({ params, actionHash: changedHash }).where(eq(schema.approvals.id, row.id));
    expect((await verifySkillPublicationApproval(w.ctx, w.change, row.id, now)).kind).toBe("defer");
  }
});

test("native operator/org holds also prevent a bounded proof from being treated as current", async () => {
  const w = await world();
  const row = await approve(w);
  await f.db.update(schema.organizations).set({ standing: "hold" }).where(eq(schema.organizations.id, f.org.id));
  expect((await verifySkillPublicationApproval(w.ctx, w.change, row.id, now)).kind).toBe("defer");
  await f.db.update(schema.organizations).set({ standing: "active" }).where(eq(schema.organizations.id, f.org.id));
  await f.db.update(schema.agents).set({ operatorHoldAt: now }).where(eq(schema.agents.id, f.agent.id));
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("defer");
});

async function expandedSourceWorld(personScoped = false) {
  const w = await world();
  const [item] = await f.db
    .insert(schema.contextItems)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      kind: "lesson",
      scopeType: personScoped ? "person" : "agent",
      scopeId: personScoped ? f.owner.id : f.agent.id,
      content: "SYNTHETIC_SCOPE_DRIFT_0190",
      channelIds: [w.dm.id],
      sourceIds: [w.message.id],
      createdByKind: "person",
      createdById: f.owner.id,
    })
    .returning();
  if (!item || !f.tools) throw new Error("native source fixture missing");
  const read = await f.tools.invoke(w.ctx, {
    name: "expand",
    input: { item_id: item.id },
    toolUseId: "scope-source-native-read",
  });
  expect(read.type).toBe("result");
  if (read.type !== "result") throw new Error("not native read");
  expect(read.output.isError).not.toBe(true);
  expect(read.output.content).toContain(item.content);
  const sources = [
    { kind: "message", id: w.message.id, hash: sha256(w.message.body), channels: [w.dm.id] },
    {
      kind: "context_item",
      id: item.id,
      hash: hash({
        content: item.content,
        version: item.version,
        sourceIds: item.sourceIds,
        agentId: item.agentId,
        scopeType: item.scopeType,
        scopeId: item.scopeId,
      }),
      channels: [w.dm.id],
    },
  ].sort((a, b) => a.id.localeCompare(b.id));
  w.params.publication.sourcesHash = hash(sources);
  return { ...w, item };
}

test("current native person-scope denial invalidates preparation, approved proof and view before a denied probe", async () => {
  const w = await expandedSourceWorld();
  const row = await approve(w);
  const before = await prepareSkillPublication(w.ctx, w.change, now);
  expect(before.kind).toBe("approval_required");
  expect((await verifySkillPublicationApproval(w.ctx, w.change, row.id, now)).kind).toBe("verified_bounded_proof");
  expect(await mayViewSkillPublicationApproval(f.db, f.org.id, row.id, f.owner.id)).toBe(true);
  const other = await addMember(f.db, f.org.id, "member", "scope-other-person");
  await f.db
    .update(schema.contextItems)
    .set({ scopeType: "person", scopeId: other.id })
    .where(eq(schema.contextItems.id, w.item.id));
  // All three helpers run BEFORE the denied Gateway probe can append an error step.
  const prepared = await prepareSkillPublication(w.ctx, w.change, now);
  const proof = await verifySkillPublicationApproval(w.ctx, w.change, row.id, now);
  const visible = await mayViewSkillPublicationApproval(f.db, f.org.id, row.id, f.owner.id);
  const native = await f.tools?.invoke(w.ctx, {
    name: "expand",
    input: { item_id: w.item.id },
    toolUseId: "scope-denied-probe",
  });
  expect(native?.type).toBe("result");
  if (native?.type === "result") {
    expect(native.output.isError).toBe(true);
    expect(native.output.content).not.toContain(w.item.content);
  }
  expect(prepared.kind).toBe("defer");
  expect(proof.kind).toBe("defer");
  expect(proof.mayPublish).toBe(false);
  expect(visible).toBe(false);
  expect(f.provider.calls).toHaveLength(0);
});

test("unchanged current owner-person scope remains native-readable and yields bounded evidence only", async () => {
  const w = await expandedSourceWorld(true);
  const row = await approve(w);
  expect((await prepareSkillPublication(w.ctx, w.change, now)).kind).toBe("approval_required");
  const proof = await verifySkillPublicationApproval(w.ctx, w.change, row.id, now);
  expect(proof.kind).toBe("verified_bounded_proof");
  expect(proof.mayPublish).toBe(false);
  expect(await mayViewSkillPublicationApproval(f.db, f.org.id, row.id, f.owner.id)).toBe(true);
  expect(f.provider.calls).toHaveLength(0);
});

test("a native-allowed scope change also changes the fingerprint and invalidates an old exact approval", async () => {
  const w = await expandedSourceWorld();
  const row = await approve(w);
  const before = await prepareSkillPublication(w.ctx, w.change, now);
  await f.db
    .update(schema.contextItems)
    .set({ scopeType: "person", scopeId: f.owner.id })
    .where(eq(schema.contextItems.id, w.item.id));
  const after = await prepareSkillPublication(w.ctx, w.change, now);
  const proof = await verifySkillPublicationApproval(w.ctx, w.change, row.id, now);
  const visible = await mayViewSkillPublicationApproval(f.db, f.org.id, row.id, f.owner.id);
  const native = await f.tools?.invoke(w.ctx, {
    name: "expand",
    input: { item_id: w.item.id },
    toolUseId: "scope-allowed-probe",
  });
  expect(native?.type).toBe("result");
  if (native?.type === "result") expect(native.output.isError).not.toBe(true);
  expect(after.kind).toBe("approval_required");
  expect(after).not.toEqual(before);
  expect(proof.kind).toBe("defer");
  expect(visible).toBe(false);
});
