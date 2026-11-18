import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  connectorGrantValidator,
  createApiKeyConnection,
  createIssue,
  createIssueProject,
  createNativeDeliveryService,
  decideApproval,
  postPersonMessage,
  setAgentScopes,
  updateIssue,
} from "../src";
import {
  checkConnectorDelivery,
  createDeliveryApprovalHandoff,
  type DeliveryCall,
  runConnectorDelivery,
} from "../src/connectors/delivery-guard";
import { actionHash } from "../src/tools/gateway";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => f?.close());
const head = "a".repeat(40);
const person = (userId: string) => ({ type: "person" as const, userId });

async function world() {
  f = await setup();
  const reads: string[] = [];
  const state = {
    repositoryId: 12345,
    head,
    defaultBranch: "main",
    baseRef: "main",
    duringRead: undefined as (() => Promise<void>) | undefined,
  };
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") !== "GET") throw new Error("No provider mutations in this fixture");
    reads.push(url);
    if (state.duringRead) {
      const action = state.duringRead;
      state.duringRead = undefined;
      await action();
    }
    if (url === "https://api.github.com/repos/acme/app")
      return Response.json({
        id: state.repositoryId,
        full_name: "acme/app",
        default_branch: state.defaultBranch,
        archived: false,
        disabled: false,
      });
    if (url === "https://api.github.com/repos/acme/app/pulls/21")
      return Response.json({
        number: 21,
        state: "open",
        draft: false,
        merged: false,
        merge_commit_sha: null,
        head: { sha: state.head },
        base: { sha: "b".repeat(40), ref: state.baseRef, repo: { id: state.repositoryId } },
      });
    throw new Error("Unexpected fixture read");
  }) as typeof fetch;
  const connectors = { db: f.db, keyWrappers: [f.keyWrapper], publicUrl: "https://chat.example.com", http };
  const connection = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: "fixture-only-github-key",
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const project = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Existing project" });
  const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
    title: "Existing task",
    projectId: project.id,
    assignee: { type: "agent", id: f.agent.id },
  });
  const service = createNativeDeliveryService({
    connectors,
    github: { app: () => null, http: { apiUrl: "https://api.github.com", fetch: http } },
    pubsub: f.pubsub,
  });
  const input = {
    action: "set" as const,
    expectedRevision: null,
    repository: { connectionId: connection.id, owner: "acme", repo: "app" },
    releaseOwnerId: f.agent.id,
    targets: [{ id: "selected-target", kind: "agent_chats_local" as const, environment: "local_installed" }],
  };
  const change = (value: unknown = input) => service.changeBinding(person(f.owner.id), f.org.id, issue.id, value);
  const read = () => service.readBinding(person(f.owner.id), f.org.id, issue.id);
  const message = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, {
    body: "Native delivery fixture",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: message.id,
      triggerMessageId: message.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      issueId: issue.id,
    })
    .returning();
  if (!run) throw new Error("Fixture run missing");
  await setAgentScopes(
    f.db,
    f.owner.id,
    f.org.id,
    f.agent.id,
    [{ connectionId: connection.id, scope: "github:pr.merge" }],
    connectorGrantValidator,
  );
  const call: DeliveryCall = {
    tool: "merge_pull_request",
    scope: "pr.merge",
    connectionId: connection.id,
    input: { owner: "acme", repo: "app", pullNumber: 21, sha: head },
    inputSchema: { type: "object", properties: { sha: { type: "string" } } },
    ctx: {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: message.id,
      triggerMessageId: message.id,
    },
  };
  const gate = () => checkConnectorDelivery(service.guard, call);
  return { service, input, change, read, gate, call, issue, project, connection, reads, state };
}

async function approved(
  w: Awaited<ReturnType<typeof world>>,
  decider = f.owner.id,
  tool = "github_merge_pull_request",
) {
  w.call.ctx.toolUseId = "native-binding-merge";
  const action = { tool, scope: "github:pr.merge", connectionId: w.connection.id, params: w.call.input };
  const [pending] = await f.db
    .insert(schema.approvals)
    .values({
      ...action,
      actionHash: actionHash(action),
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: w.call.ctx.runId,
      toolUseId: w.call.ctx.toolUseId,
      channelId: w.call.ctx.channelId,
      threadRootId: w.call.ctx.threadRootId,
      title: "Native fixture merge",
      why: "Verify the exact native approval row without authorizing any release target.",
      ownerUserId: f.owner.id,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  if (!pending) throw new Error("Missing fixture approval");
  await decideApproval({ db: f.db, pubsub: f.pubsub }, decider, f.org.id, pending.id, { decision: "approve" });
  const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, pending.id));
  if (!row) throw new Error("Missing decided approval");
  const handoff = createDeliveryApprovalHandoff(
    w.call.ctx,
    {
      name: action.tool,
      scope: action.scope,
      connectionId: w.connection.id,
      connector: { key: "github", via: "mcp", tool: w.call.tool },
    },
    row,
  );
  if (!handoff) throw new Error("Missing fixture handoff");
  w.call.ctx.deliveryApproval = handoff.checking;
  return { row, handoff };
}

test("an existing native approval resolves only action authority and never supplies target, checks, operation or lease", async () => {
  const w = await world();
  await w.change();
  const { row, handoff } = await approved(w);
  try {
    expect(await w.gate()).toMatchObject({
      ok: false,
      data: {
        deliveryGuardian: {
          reasonCodes: [
            "native_target_unverified",
            "trusted_check_policy_unavailable",
            "native_release_operation_unavailable",
            "native_release_lease_unavailable",
          ],
          isAuthorizationGrant: false,
        },
      },
    });
    const [current] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, row.id));
    expect(current?.executedAt).toBeNull();
  } finally {
    handoff.close();
  }
});

for (const status of ["refused", "canceled", "expired"] as const) {
  test(`native approval ${status} after selection refuses before provider observation`, async () => {
    const w = await world();
    await w.change();
    const { row, handoff } = await approved(w);
    try {
      await f.db.update(schema.approvals).set({ status }).where(eq(schema.approvals.id, row.id));
      const reads = w.reads.length;
      expect(await w.gate()).toMatchObject({
        ok: false,
        data: { deliveryGuardian: { reasonCodes: ["native_approval_not_approved"] } },
      });
      expect(w.reads).toHaveLength(reads);
    } finally {
      handoff.close();
    }
  });
}

for (const [name, patch] of [
  ["run", { runId: null }],
  ["tool use", { toolUseId: "different-call" }],
  ["connection", { connectionId: null }],
  ["action hash", { actionHash: "f".repeat(64) }],
  ["parameters", { params: { owner: "acme", repo: "app", pullNumber: 22, sha: head } }],
] satisfies [string, Partial<typeof schema.approvals.$inferInsert>][]) {
  test(`native approval changed ${name} is not reused for the selected call`, async () => {
    const w = await world();
    await w.change();
    const { row, handoff } = await approved(w);
    try {
      await f.db.update(schema.approvals).set(patch).where(eq(schema.approvals.id, row.id));
      expect(await w.gate()).toMatchObject({
        ok: false,
        data: { deliveryGuardian: { reasonCodes: ["native_approval_subject_mismatch"] } },
      });
    } finally {
      handoff.close();
    }
  });
}

test("expiry and current deciding membership are re-read from native state", async () => {
  const w = await world();
  await w.change();
  const decider = await addMember(f.db, f.org.id, "admin", "delivery-decider");
  const { row, handoff } = await approved(w, decider.id);
  try {
    await f.db
      .update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.approvals.id, row.id));
    expect(await w.gate()).toMatchObject({
      ok: false,
      data: { deliveryGuardian: { reasonCodes: ["native_approval_expired"] } },
    });
    await f.db
      .update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.approvals.id, row.id));
    await f.db
      .delete(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, decider.id)));
    expect(await w.gate()).toMatchObject({
      ok: false,
      data: { deliveryGuardian: { reasonCodes: ["native_approval_issuer_revoked"] } },
    });
  } finally {
    handoff.close();
  }
});

test("a different execution timestamp cannot stand in for the native claim", async () => {
  const w = await world();
  await w.change();
  const { row, handoff } = await approved(w);
  const at = new Date();
  try {
    await f.db
      .update(schema.approvals)
      .set({ executedAt: new Date(at.getTime() - 1) })
      .where(eq(schema.approvals.id, row.id));
    w.call.ctx.deliveryApproval = handoff.claim(at);
    expect(await w.gate()).toMatchObject({
      ok: false,
      data: { deliveryGuardian: { reasonCodes: ["native_approval_claim_mismatch"] } },
    });
  } finally {
    handoff.close();
  }
});

test("withdrawal after a claim and during provider observation prevents dispatch without clearing the claim", async () => {
  const w = await world();
  await w.change();
  const { row, handoff } = await approved(w);
  const at = new Date();
  try {
    await f.db.update(schema.approvals).set({ executedAt: at }).where(eq(schema.approvals.id, row.id));
    w.call.ctx.deliveryApproval = handoff.claim(at);
    w.call.ctx.approved = true;
    w.state.duringRead = async () => {
      await f.db.update(schema.approvals).set({ status: "canceled" }).where(eq(schema.approvals.id, row.id));
    };
    let calls = 0;
    expect(await runConnectorDelivery(w.service.guard, w.call, async () => ++calls)).toMatchObject({
      ok: false,
      data: { deliveryGuardian: { reasonCodes: ["native_approval_not_approved"] } },
    });
    expect(calls).toBe(0);
    const [current] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, row.id));
    expect(current?.executedAt?.toISOString()).toBe(at.toISOString());
    expect(current?.status).toBe("canceled");
  } finally {
    handoff.close();
  }
});

test("caller approved flags cannot replace the Gateway's native approval handoff", async () => {
  const w = await world();
  await w.change();
  w.call.ctx.approved = true;
  Object.assign(w.call.input, { approvalId: "caller-authored", authorized: true });
  let calls = 0;
  expect(await runConnectorDelivery(w.service.guard, w.call, async () => ++calls)).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_release_authority_unavailable"] } },
  });
  expect(calls).toBe(0);
});

test("native approval recheck honors an exact deny on a renamed catalog tool", async () => {
  const w = await world();
  await w.change();
  const tool = "github_2_merge_pull_request";
  const { handoff } = await approved(w, f.owner.id, tool);
  try {
    await f.db.insert(schema.agentScopes).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: w.connection.id,
      scope: `deny:${tool}`,
      grantedByUserId: f.owner.id,
    });
    const reads = w.reads.length;
    expect(await w.gate()).toMatchObject({
      ok: false,
      data: { deliveryGuardian: { reasonCodes: ["native_delivery_scope_revoked"] } },
    });
    expect(w.reads).toHaveLength(reads);
  } finally {
    handoff.close();
  }
});

test("native binding writer requires an authenticated current owner and never accepts an agent issuer", async () => {
  const w = await world();
  const member = await addMember(f.db, f.org.id, "member", "binding-member");
  await expect(w.service.changeBinding(person(member.id), f.org.id, w.issue.id, w.input)).rejects.toMatchObject({
    code: "delivery_binding.owner_required",
  });
  await expect(
    w.service.changeBinding(
      { type: "agent", agentId: f.agent.id, channelId: f.general.id },
      f.org.id,
      w.issue.id,
      w.input,
    ),
  ).rejects.toMatchObject({ code: "delivery_binding.owner_required" });
  expect(w.reads).toEqual([]);
});

test("two different owners changing the same prior revision cannot both commit", async () => {
  const w = await world();
  const other = await addMember(f.db, f.org.id, "owner", "other-binding-owner");
  const results = await Promise.allSettled([
    w.change(),
    w.service.changeBinding(person(other.id), f.org.id, w.issue.id, w.input),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: "delivery_binding.revision_conflict" });
  const rows = await f.db
    .select()
    .from(schema.issueActivity)
    .where(
      and(eq(schema.issueActivity.issueId, w.issue.id), eq(schema.issueActivity.event, "delivery_binding_changed")),
    );
  expect(rows).toHaveLength(1);
});

test("owner revocation during provider observation prevents the binding transaction", async () => {
  const w = await world();
  w.state.duringRead = async () => {
    await f.db
      .update(schema.organizationMembers)
      .set({ role: "member" })
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
  };
  await expect(w.change()).rejects.toMatchObject({ code: "delivery_binding.owner_required" });
  const rows = await f.db
    .select()
    .from(schema.issueActivity)
    .where(eq(schema.issueActivity.event, "delivery_binding_changed"));
  expect(rows).toEqual([]);
});

test("fake newer agent activity never revives a valid older binding", async () => {
  const w = await world();
  await w.change();
  const [real] = await f.db
    .select()
    .from(schema.issueActivity)
    .where(eq(schema.issueActivity.event, "delivery_binding_changed"));
  if (!real) throw new Error("Native event missing");
  // Same timestamp and payload as the real row: the new ID wins ordering, so refusal tests the native issuer.
  const fakeId = "ffffffff-ffff-7fff-8fff-ffffffffffff";
  await f.db.insert(schema.issueActivity).values({
    id: fakeId,
    orgId: f.org.id,
    issueId: w.issue.id,
    kind: "event",
    event: "delivery_binding_changed",
    authorType: "agent",
    authorId: f.agent.id,
    text: "Claimed native proof",
    data: real.data,
    createdAt: real.createdAt,
  });
  expect(await w.read()).toMatchObject({ state: "untrusted", revision: fakeId, authorityGranted: false });
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_binding_untrusted"] } },
  });
});

test("a copied owner event is not a binding for another native task", async () => {
  const w = await world();
  await w.change();
  const other = await createIssue({ db: f.db }, person(f.owner.id), f.org.id, {
    title: "Another task",
    projectId: w.project.id,
  });
  const [real] = await f.db
    .select()
    .from(schema.issueActivity)
    .where(eq(schema.issueActivity.event, "delivery_binding_changed"));
  if (!real) throw new Error("Native event missing");
  await f.db.insert(schema.issueActivity).values({
    orgId: f.org.id,
    issueId: other.id,
    kind: "event",
    event: "delivery_binding_changed",
    authorType: "person",
    authorId: f.owner.id,
    text: "Copied record",
    data: real.data,
    createdAt: real.createdAt,
  });
  expect(await w.service.readBinding(person(f.owner.id), f.org.id, other.id)).toMatchObject({
    state: "untrusted",
    authorityGranted: false,
  });
});

test("the original issuer must remain an active native owner at read time", async () => {
  const w = await world();
  await w.change();
  await f.db
    .update(schema.organizationMembers)
    .set({ role: "member" })
    .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, f.owner.id)));
  expect(await w.read()).toMatchObject({ state: "untrusted", authorityGranted: false });
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_binding_untrusted"] } },
  });
  expect(w.reads).toHaveLength(1);
});

test("a connection belonging to another organization is refused before credential or provider access", async () => {
  const w = await world();
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other tenant" }).returning();
  if (!other) throw new Error("Other tenant missing");
  await f.db
    .update(schema.connectorConnections)
    .set({ orgId: other.id })
    .where(eq(schema.connectorConnections.id, w.connection.id));
  await expect(w.change()).rejects.toMatchObject({ code: "delivery_binding.connection_unavailable" });
  expect(w.reads).toEqual([]);
});

test("an active-looking connection with a revocation timestamp is not usable", async () => {
  const w = await world();
  await f.db
    .update(schema.connectorConnections)
    .set({ revokedAt: new Date() })
    .where(eq(schema.connectorConnections.id, w.connection.id));
  await expect(w.change()).rejects.toMatchObject({ code: "delivery_binding.connection_unavailable" });
  expect(w.reads).toEqual([]);
});

test("native agent lifecycle fields refuse unavailable publishers and running actors", async () => {
  const w = await world();
  for (const field of ["archivedAt", "deletedAt", "operatorHoldAt"] as const) {
    await f.db
      .update(schema.agents)
      .set({ [field]: new Date() })
      .where(eq(schema.agents.id, f.agent.id));
    await expect(w.change()).rejects.toMatchObject({ code: "delivery_binding.release_owner_unavailable" });
    await f.db
      .update(schema.agents)
      .set({ [field]: null })
      .where(eq(schema.agents.id, f.agent.id));
  }
  await w.change();
  const before = w.reads.length;
  for (const field of ["archivedAt", "deletedAt", "operatorHoldAt"] as const) {
    await f.db
      .update(schema.agents)
      .set({ [field]: new Date() })
      .where(eq(schema.agents.id, f.agent.id));
    expect(await w.gate()).toMatchObject({
      ok: false,
      data: { deliveryGuardian: { reasonCodes: ["native_delivery_actor_inactive"] } },
    });
    expect(w.reads).toHaveLength(before);
    await f.db
      .update(schema.agents)
      .set({ [field]: null })
      .where(eq(schema.agents.id, f.agent.id));
  }
});

test("revoking the native connection after configuration blocks later observation", async () => {
  const w = await world();
  await w.change();
  await f.db
    .update(schema.connectorConnections)
    .set({ revokedAt: new Date() })
    .where(eq(schema.connectorConnections.id, w.connection.id));
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_delivery_connection_unavailable"] } },
  });
  expect(w.reads).toHaveLength(1);
});

test("revocation appends history and the current native read refuses release", async () => {
  const w = await world();
  const saved = await w.change();
  await w.change({ action: "revoke", expectedRevision: saved.revision, reason: "Owner revocation" });
  expect(await w.read()).toMatchObject({ state: "revoked", authorityGranted: false });
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_binding_revoked"] } },
  });
  expect(w.reads).toHaveLength(1);
});

test("changing the task's project invalidates its old repository relation", async () => {
  const w = await world();
  await w.change();
  await updateIssue({ db: f.db, pubsub: f.pubsub }, person(f.owner.id), f.org.id, w.issue.id, { projectId: null });
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_binding_subject_changed"] } },
  });
});

test("a configured owner, repository and publisher still do not invent native release gates", async () => {
  const w = await world();
  await w.change();
  const result = await w.gate();
  expect(result.ok).toBe(false);
  expect(result.data).toMatchObject({
    deliveryGuardian: {
      isAuthorizationGrant: false,
      reasonCodes: expect.arrayContaining([
        "native_release_lease_unavailable",
        "native_target_unverified",
        "trusted_check_policy_unavailable",
      ]),
    },
  });
  expect(w.reads).toEqual([
    "https://api.github.com/repos/acme/app",
    "https://api.github.com/repos/acme/app",
    "https://api.github.com/repos/acme/app/pulls/21",
  ]);
});

test("native scope revocation is checked before reading the provider", async () => {
  const w = await world();
  await w.change();
  await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [], connectorGrantValidator);
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_delivery_scope_revoked"] } },
  });
  expect(w.reads).toHaveLength(1);
});

test("provider repository replacement and current head drift refuse the exact call", async () => {
  const w = await world();
  await w.change();
  w.state.repositoryId = 99999;
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_repository_identity_changed"] } },
  });
  w.state.repositoryId = 12345;
  w.state.head = "d".repeat(40);
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_candidate_head_changed"] } },
  });
});

test("changing both the default branch and PR base does not silently change the configured integration target", async () => {
  const w = await world();
  await w.change();
  w.state.defaultBranch = "new-main";
  w.state.baseRef = "new-main";
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_integration_target_changed"] } },
  });
});

test("binding revocation during a provider read invalidates that observation", async () => {
  const w = await world();
  const saved = await w.change();
  w.state.duringRead = async () => {
    await w.change({ action: "revoke", expectedRevision: saved.revision, reason: "Revoked during lookup" });
  };
  const result = await w.gate();
  expect(result).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_binding_changed_during_observation"] } },
  });
});

test("File Room publisher remains unset instead of borrowing an agent role label", async () => {
  const w = await world();
  await w.change({
    ...w.input,
    releaseOwnerId: null,
    targets: [{ id: "selected-fileroom", kind: "macos_app", environment: "local_installed" }],
  });
  expect(await w.read()).toMatchObject({ releaseOwnerId: null, authorityGranted: false });
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_release_owner_unset"] } },
  });
});

test("request-supplied task or authorization flags cannot replace the stored run", async () => {
  const w = await world();
  await w.change();
  w.call.input.authorized = true;
  w.call.input.taskId = w.issue.id;
  w.call.ctx.runId = Bun.randomUUIDv7();
  expect(await w.gate()).toMatchObject({
    ok: false,
    data: { deliveryGuardian: { reasonCodes: ["native_delivery_run_missing"] } },
  });
});
