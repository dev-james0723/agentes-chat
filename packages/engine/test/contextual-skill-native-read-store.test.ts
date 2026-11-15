import { afterEach, expect, test } from "bun:test";
import { and, type Database, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { runAuthorityById } from "../src/authority";
import {
  beginNativeSkillRead,
  completeNativeSkillRead,
  finalizeNativeSkillRead,
  prepareNativeSkillRead,
  registerNativeSkillReadTool,
} from "../src/contextual-skill-native-read";
import { claimNativeSkillRead, revokeNativeSkillReads } from "../src/contextual-skill-native-read-store";
import { createSkillToolSource } from "../src/skill-tools";
import { installNativeSkillReadTestSchema, nativePublishedReadFixture } from "./contextual-skill-native-read.fixture";
import { addMember } from "./fixtures";

let fixture: Awaited<ReturnType<typeof nativePublishedReadFixture>>;
afterEach(async () => {
  await fixture?.f.close();
});
// Isolated store fixture uses the real native source's tool object and the actual private-call runtime functions.
// It does not claim Gateway registration/formatting acceptance; the peer's real Gateway suite owns that boundary.
async function attempt(toolUseId = "native-b2-read", inputName?: string) {
  const { f, ctx, selected, body, name } = fixture;
  const context = { ...ctx, toolUseId };
  const input = { name: inputName ?? name };
  const tools = await createSkillToolSource(f.artifactDeps).tools(context);
  const tool = tools.find((t) => t.name === "load_skill")!;
  registerNativeSkillReadTool(tool);
  const [step] = await f.db
    .insert(schema.agentRunSteps)
    .values({
      orgId: ctx.orgId,
      runId: ctx.runId,
      seq: sql`(select coalesce(max(seq),0)+1 from agent_run_steps where run_id=${ctx.runId}::uuid)`,
      kind: "tool_call",
      data: { toolUseId, name: "load_skill", input },
    })
    .returning();
  const authority = await runAuthorityById(f.db, ctx.orgId, ctx.runId);
  const call = await beginNativeSkillRead(
    context,
    tool,
    step!.id,
    input,
    {
      canary: [{ agentId: ctx.agentId, runId: ctx.runId, skillId: selected.skillId, operation: "load_skill" }],
    },
    authority,
  );
  if (!call) throw Error("Genuine native mint refused fixture");
  const before = prepareNativeSkillRead(context, {
    selected: {
      orgId: selected.orgId,
      skillId: selected.skillId,
      version: selected.version,
      operation: selected.operation,
      path: selected.path,
      mime: null,
    },
    output: { content: body },
    rawSelectedBytes: new TextEncoder().encode(body),
    listing: "",
    readerTruncated: false,
    omitted: false,
  });
  finalizeNativeSkillRead(context, before, before, { suffix: null, sanitized: false, gatewayTruncated: false });
  return { context, call, step: step!, finish: () => completeNativeSkillRead(context, call, before) };
}
const count = async () =>
  (await fixture.f.db.select().from(schema.skills).where(eq(schema.skills.id, fixture.selected.skillId)))[0]!.useCount;
const activations = async () =>
  rowsOf<Record<string, unknown>>(await fixture.f.db.execute(sql`select * from skill_read_activations`));
async function ready() {
  fixture = await nativePublishedReadFixture();
  await installNativeSkillReadTestSchema(fixture.f.db);
}

test("actual DB unique call claim returns exact body once, commits native useCount once, and retry returns no body", async () => {
  await ready();
  const before = await count();
  const first = await attempt();
  const output = await first.finish();
  expect(output.isError).not.toBe(true);
  expect(output.content).toBe(fixture.body);
  expect(output.data?.skillReadActivation).toMatchObject({
    runId: fixture.ctx.runId,
    stepId: first.step.id,
    skillVersion: 2,
    state: "completed",
  });
  expect(await count()).toBe(before + 1);
  expect(await activations()).toHaveLength(1);
  const retry = await attempt();
  const replay = await retry.finish();
  expect(replay.isError).toBe(true);
  expect(replay.content).not.toContain(fixture.body);
  expect(await count()).toBe(before + 1);
  expect((await activations())[0]).toMatchObject({ used_count: 1, state: "completed" });
});

test.each([
  "assignment",
  "terminal",
  "vendor-pointer",
  "source-edit",
  "wrong-step",
  "abort",
  "legacy-proof",
  "resources",
  "forged-call",
] as const)("native DB claim refuses %s without body or counter", async (mode) => {
  await ready();
  const before = await count();
  const a = await attempt();
  const { f, ctx, selected, approval } = fixture;
  if (mode === "assignment")
    await f.db
      .update(schema.agentSkills)
      .set({ enabled: false })
      .where(eq(schema.agentSkills.skillId, selected.skillId));
  if (mode === "terminal")
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));
  if (mode === "vendor-pointer")
    await f.db
      .update(schema.agentRuns)
      .set({ brainSessionId: "opaque-vendor-continuation" })
      .where(eq(schema.agentRuns.id, ctx.runId));
  if (mode === "source-edit")
    await f.db
      .update(schema.messages)
      .set({ body: "Changed source" })
      .where(
        eq(
          schema.messages.id,
          (approval.params as { publication: { triggerMessageId: string } }).publication.triggerMessageId,
        ),
      );
  if (mode === "wrong-step")
    await f.db
      .update(schema.agentRunSteps)
      .set({ data: { toolUseId: ctx.toolUseId, name: "other_tool", input: { name: fixture.name } } })
      .where(eq(schema.agentRunSteps.id, a.step.id));
  if (mode === "abort") {
    const c = new AbortController();
    c.abort();
    a.context.signal = c.signal;
  }
  if (mode === "legacy-proof")
    await f.db
      .update(schema.approvals)
      .set({ result: { content: "published", data: { version: 2 } } })
      .where(eq(schema.approvals.id, approval.id));
  if (mode === "resources")
    await f.db.insert(schema.skillFiles).values({
      orgId: ctx.orgId,
      skillId: selected.skillId,
      version: 2,
      path: "extra.txt",
      mime: "text/plain",
      size: 1,
      status: "stored",
    });
  if (mode === "forged-call")
    expect(await claimNativeSkillRead(a.context, { ...a.call }, { descriptor: {} })).toMatchObject({
      status: "refused",
      reason: "native_capture_unqualified",
    });
  const out = mode === "forged-call" ? null : await a.finish();
  if (out) {
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain(fixture.body);
  }
  expect(await count()).toBe(before);
  expect(await activations()).toHaveLength(0);
});

test.each(["revoked", "expired", "context-drift", "input-conflict"] as const)(
  "consumed delivery cannot replay body after %s",
  async (mode) => {
    await ready();
    const before = await count();
    const a = await attempt();
    expect((await a.finish()).content).toBe(fixture.body);
    const { f, ctx } = fixture;
    if (mode === "revoked") await f.db.execute(sql`update skill_read_activations set revoked_at=clock_timestamp()`);
    if (mode === "expired")
      await f.db.execute(
        sql`update skill_read_activations set issued_at=t.at-interval '6 minutes', expires_at=t.at-interval '1 minute' from (select clock_timestamp() as at) t`,
      );
    if (mode === "context-drift")
      await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, ctx.agentId));
    const retry = await attempt("native-b2-read", mode === "input-conflict" ? ` ${fixture.name} ` : undefined);
    const out = await retry.finish();
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain(fixture.body);
    expect(await count()).toBe(before + 1);
    expect(await activations()).toHaveLength(1);
  },
);

test("actual SQL failure after activation CAS rolls back activation and skill counter and releases no body", async () => {
  await ready();
  const before = await count();
  const a = await attempt();
  await fixture.f.db.execute(
    sql.raw(
      `create function b2_reject_skill_use() returns trigger language plpgsql as $$ begin perform 1/0; return NEW; end $$`,
    ),
  );
  await fixture.f.db.execute(
    sql.raw(
      `create trigger b2_reject_skill_use before update of use_count on skills for each row execute function b2_reject_skill_use()`,
    ),
  );
  const out = await a.finish();
  expect(out.isError).toBe(true);
  expect(out.content).not.toContain(fixture.body);
  expect(await count()).toBe(before);
  expect(await activations()).toHaveLength(0);
});

// Same-TX seam after the last proof and at the DB clock: mutations are actual SQL, not forged facts.
test.each(["assignment", "archive", "membership", "source-edit"] as const)(
  "late %s mutation at final async boundary prevents CAS and native counter",
  async (mode) => {
    await ready();
    const before = await count();
    const a = await attempt();
    let injected = 0;
    const wrap = (db: Database): Database =>
      new Proxy(db, {
        get(target, key) {
          if (key === "transaction")
            return async (body: (tx: Database) => Promise<unknown>) =>
              target.transaction((tx) => body(wrap(tx as unknown as Database)));
          if (key === "execute")
            return async (query: Parameters<Database["execute"]>[0]) => {
              const text =
                (query as unknown as { queryChunks?: { value?: string[] }[] }).queryChunks
                  ?.map((c) => (c && Array.isArray(c.value) ? c.value.join("") : ""))
                  .join("") ?? "";
              if (text.includes("floor(extract(epoch from clock_timestamp())")) {
                injected++;
                if (mode === "assignment")
                  await target
                    .update(schema.agentSkills)
                    .set({ enabled: false })
                    .where(
                      and(
                        eq(schema.agentSkills.agentId, fixture.ctx.agentId),
                        eq(schema.agentSkills.skillId, fixture.selected.skillId),
                      ),
                    );
                else if (mode === "membership")
                  await target
                    .delete(schema.organizationMembers)
                    .where(
                      and(
                        eq(schema.organizationMembers.orgId, fixture.ctx.orgId),
                        eq(schema.organizationMembers.userId, fixture.f.owner.id),
                      ),
                    );
                else if (mode === "source-edit")
                  await target
                    .update(schema.messages)
                    .set({ body: "Changed original source at final clock" })
                    .where(eq(schema.messages.channelId, fixture.dm.id));
                else
                  await target
                    .update(schema.agents)
                    .set({ archivedAt: new Date() })
                    .where(eq(schema.agents.id, fixture.ctx.agentId));
              }
              return target.execute(query);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    a.context.db = wrap(fixture.f.db);
    const out = await a.finish();
    expect(injected).toBe(1);
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain(fixture.body);
    expect(await count()).toBe(before);
    expect((await activations()).every((row) => row.used_count === 0)).toBe(true);
  },
);

test("native internal revoke is exact org/agent/run, idempotent, content-free and cannot re-open a consumed read", async () => {
  await ready();
  const before = await count();
  const a = await attempt();
  expect((await a.finish()).content).toBe(fixture.body);
  const { f, ctx } = fixture;
  expect(
    await revokeNativeSkillReads(f.db, { orgId: crypto.randomUUID(), agentId: ctx.agentId, runId: ctx.runId }),
  ).toEqual({ revoked: 0 });
  expect(
    await revokeNativeSkillReads(f.db, { orgId: ctx.orgId, agentId: crypto.randomUUID(), runId: ctx.runId }),
  ).toEqual({ revoked: 0 });
  const result = await revokeNativeSkillReads(f.db, { orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId });
  expect(result).toEqual({ revoked: 1 });
  expect(JSON.stringify(result)).not.toContain(fixture.body);
  expect(await revokeNativeSkillReads(f.db, { orgId: ctx.orgId, agentId: ctx.agentId, runId: ctx.runId })).toEqual({
    revoked: 0,
  });
  const retry = await attempt();
  const out = await retry.finish();
  expect(out.isError).toBe(true);
  expect(out.content).not.toContain(fixture.body);
  expect(await count()).toBe(before + 1);
  expect((await activations())[0]).toMatchObject({ used_count: 1, state: "completed" });
});

test("recorded native audit why is retained while only the exact normalized native parameters bind the claim", async () => {
  await ready();
  const before = await count();
  const a = await attempt();
  const input = {
    name: fixture.name,
    why: "Read the exact owner-shared method after verifying its current native source and version",
  };
  await fixture.f.db
    .update(schema.agentRunSteps)
    .set({ data: { toolUseId: a.context.toolUseId, name: "load_skill", input } })
    .where(eq(schema.agentRunSteps.id, a.step.id));
  const out = await a.finish();
  expect(out.isError).not.toBe(true);
  expect(out.content).toBe(fixture.body);
  expect(await count()).toBe(before + 1);
  const [stored] = await fixture.f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.id, a.step.id));
  expect(stored?.data.input).toEqual(input);
});
test.each(["semantic-extra", "unexpected-path", "why-type", "why-too-long", "tool-mismatch"] as const)(
  "recorded native input projection rejects %s without changing the audit row",
  async (mode) => {
    await ready();
    const before = await count();
    const a = await attempt();
    const input: Record<string, unknown> = { name: fixture.name };
    if (mode === "semantic-extra") input.version = 99;
    if (mode === "unexpected-path") input.path = "hidden.txt";
    if (mode === "why-type") input.why = { approved: true };
    if (mode === "why-too-long") input.why = "x".repeat(1001);
    const data = {
      toolUseId: a.context.toolUseId,
      name: mode === "tool-mismatch" ? "read_skill_file" : "load_skill",
      input,
    };
    await fixture.f.db.update(schema.agentRunSteps).set({ data }).where(eq(schema.agentRunSteps.id, a.step.id));
    const out = await a.finish();
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain(fixture.body);
    expect(await count()).toBe(before);
    expect(await activations()).toHaveLength(0);
    const [stored] = await fixture.f.db
      .select()
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.id, a.step.id));
    expect(stored?.data).toEqual(data);
  },
);

test.each(["direct-person", "steered-unattended"] as const)(
  "native actor/steering epoch drift during capture invalidates %s call even when both actors are authorized",
  async (mode) => {
    await ready();
    const { f } = fixture;
    const next = await addMember(f.db, f.org.id, "owner", "other-authorized-reader");
    if (mode === "steered-unattended") {
      const [message] = await f.db
        .insert(schema.messages)
        .values({
          orgId: f.org.id,
          channelId: f.general.id,
          authorType: "agent",
          authorAgentId: f.agent.id,
          body: "Synthetic unattended source, no person chain",
        })
        .returning();
      await f.db
        .update(schema.agentRuns)
        .set({ triggerMessageId: message!.id, threadRootId: message!.id, transcript: { steeredBy: f.owner.id } })
        .where(eq(schema.agentRuns.id, fixture.ctx.runId));
      fixture.ctx.triggerMessageId = message!.id;
      fixture.ctx.threadRootId = message!.id;
    }
    expect(await runAuthorityById(f.db, f.org.id, fixture.ctx.runId)).toMatchObject({
      kind: "person",
      personId: f.owner.id,
    });
    const before = await count();
    const a = await attempt();
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, fixture.ctx.runId));
    await f.db
      .update(schema.agentRuns)
      .set({ transcript: { ...(row?.transcript ?? {}), steeredBy: next.id } })
      .where(eq(schema.agentRuns.id, fixture.ctx.runId));
    // The direct-person root deliberately stays original in native authority.ts; epoch must still invalidate.
    expect(await runAuthorityById(f.db, f.org.id, fixture.ctx.runId)).toMatchObject({
      kind: "person",
      personId: mode === "direct-person" ? f.owner.id : next.id,
    });
    const out = await a.finish();
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain(fixture.body);
    expect(await count()).toBe(before);
    expect(await activations()).toHaveLength(0);
  },
);

test("a current opaque vendor pointer is continuity-bound but remains unknown_vendor_context, not native session authority", async () => {
  await ready();
  const { f, ctx } = fixture;
  await f.db
    .update(schema.agentRuns)
    .set({ brainSessionId: "opaque-vendor-current-pointer" })
    .where(eq(schema.agentRuns.id, ctx.runId));
  const before = await count();
  const a = await attempt();
  const out = await a.finish();
  expect(out.isError).not.toBe(true);
  expect(out.content).toBe(fixture.body);
  expect(await count()).toBe(before + 1);
  const { readNativeSkillSourceProof, nativeSkillSourceFacts } = await import(
    "../src/contextual-skill-native-read-proof"
  );
  const verified = await readNativeSkillSourceProof(f.db, ctx, fixture.selected);
  expect(verified.status).toBe("verified");
  if (verified.status !== "verified") throw Error(verified.reason);
  expect(nativeSkillSourceFacts(verified.proof)).toMatchObject({ readerVendorContext: "unknown_vendor_context" });
});

test.each(["steered-presence-null", "pending-context", "malformed-steering"] as const)(
  "native epoch rejects %s drift although person-root authority may stay the same",
  async (mode) => {
    await ready();
    const { f, ctx } = fixture;
    const before = await count();
    const a = await attempt();
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, ctx.runId));
    if (mode === "pending-context")
      await f.db
        .update(schema.agentRuns)
        .set({ pendingMessageIds: [ctx.triggerMessageId] })
        .where(eq(schema.agentRuns.id, ctx.runId));
    else
      await f.db
        .update(schema.agentRuns)
        .set({
          transcript: {
            ...(run?.transcript ?? {}),
            steeredBy: mode === "steered-presence-null" ? null : { untrusted: true },
          },
        })
        .where(eq(schema.agentRuns.id, ctx.runId));
    expect(await runAuthorityById(f.db, ctx.orgId, ctx.runId)).toMatchObject({ kind: "person", personId: f.owner.id });
    const out = await a.finish();
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain(fixture.body);
    expect(await count()).toBe(before);
    expect(await activations()).toHaveLength(0);
  },
);

test("actual late vendor-pointer SQL change after final proof is rejected by the raw native CAS", async () => {
  await ready();
  const { f, ctx } = fixture;
  const before = await count();
  const a = await attempt();
  let injected = 0;
  const wrap = (db: Database): Database =>
    new Proxy(db, {
      get(target, key) {
        if (key === "transaction")
          return async (body: (tx: Database) => Promise<unknown>) =>
            target.transaction((tx) => body(wrap(tx as unknown as Database)));
        if (key === "execute")
          return async (query: Parameters<Database["execute"]>[0]) => {
            const text =
              (query as unknown as { queryChunks?: { value?: string[] }[] }).queryChunks
                ?.map((c) => (c && Array.isArray(c.value) ? c.value.join("") : ""))
                .join("") ?? "";
            if (text.includes("set used_count=1,state='completed'")) {
              injected++;
              await target
                .update(schema.agentRuns)
                .set({ brainSessionId: "different-after-last-proof" })
                .where(eq(schema.agentRuns.id, ctx.runId));
            }
            return target.execute(query);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  a.context.db = wrap(f.db);
  const out = await a.finish();
  expect(injected).toBe(1);
  expect(out.isError).toBe(true);
  expect(out.content).not.toContain(fixture.body);
  expect(await count()).toBe(before);
  expect((await activations()).every((row) => row.used_count === 0)).toBe(true);
});
