import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createFoundryExecutionPolicy,
  FOUNDRY_POLICY_MANAGEMENT,
  type FoundryBuilderRunPin,
  type FoundryExecutionPolicyOptions,
  type FoundryPolicyRun,
} from "../src/foundry/execution-policy";
import type { ToolContext, ToolDefinition } from "../src/tools/types";

const ORG = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000002";
const AGENT = "00000000-0000-4000-8000-000000000003";
const RUN = "00000000-0000-4000-8000-000000000004";
const OTHER = "00000000-0000-4000-8000-000000000005";
const CANDIDATE = "00000000-0000-4000-8000-000000000006";
const DIGEST = "a".repeat(64);
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const ctx = { orgId: ORG, agentId: AGENT, runId: RUN } as ToolContext;
const capabilityName = (digest = DIGEST) =>
  `foundry_receipt_normalizer_${CANDIDATE.replaceAll("-", "").slice(0, 16)}_${digest.slice(0, 20)}`;
const tool = (name = "propose_foundry_capability", scope = "skills:read", extra: Partial<ToolDefinition> = {}) => ({
  name,
  scope,
  description: "trusted fixture",
  inputSchema: {},
  async execute() {
    return { content: "" };
  },
  ...extra,
});

function fixture(extra: Partial<FoundryExecutionPolicyOptions> = {}) {
  let row: FoundryPolicyRun | null = {
    id: RUN,
    orgId: ORG,
    agentId: AGENT,
    issueId: TASK,
    status: "running",
    background: false,
    workId: null,
    brain: "model",
    brainSessionId: null,
  };
  const pin: FoundryBuilderRunPin = {
    phaseRef: "foundry-phase-1",
    orgId: ORG,
    taskId: TASK,
    agentId: AGENT,
    runIds: [RUN],
    expiresAt: "2026-11-16T13:00:00.000Z",
  };
  let clock = NOW;
  let reads = 0;
  const policy = createFoundryExecutionPolicy({
    pins: [pin],
    now: () => clock,
    async readRun() {
      reads++;
      return row && { ...row };
    },
    ...extra,
  });
  return {
    policy,
    pin,
    get row() {
      return row;
    },
    get reads() {
      return reads;
    },
    change(change: Partial<FoundryPolicyRun>) {
      row = row && { ...row, ...change };
    },
    remove() {
      row = null;
    },
    advance() {
      clock += 3600_000;
    },
  };
}

test("default builder policy admits only the verified Foundry management definitions", async () => {
  const f = fixture();
  for (const [name, scope] of Object.entries(FOUNDRY_POLICY_MANAGEMENT)) {
    assert.equal((await f.policy.check(ctx, tool(name, scope), "foundry")).ok, true, name);
  }
  assert.equal(await f.policy.sourceAllowed(ctx, "foundry"), true);
  for (const source of ["sandbox", "host-mcp", "browser", "desktop", "vault", "skills", "issues", "new-plugin"]) {
    assert.equal(await f.policy.sourceAllowed(ctx, source), false, source);
  }
});

test("host, network, delegation, writes, settings and unknown names fail closed despite native all grants", async () => {
  const f = fixture();
  const names = [
    "run_code",
    "read_file",
    "start_task",
    "permission_prompt",
    "browser_open",
    "desktop_do",
    "web_fetch",
    "execute_sql",
    "read_secret",
    "get_vault_item",
    "ask_agent",
    "tell_agent",
    "create_issue",
    "update_issue",
    "work_in_background",
    "hand_off",
    "schedule_action",
    "update_skill",
    "request_permission",
    "setup_agent",
    "run_approved_action",
    "foundry_receipt_normalizer_unknown",
    "newly_added_tool",
  ];
  for (const name of names) {
    assert.equal((await f.policy.check(ctx, tool(name, "skills:read"), "foundry")).ok, false, name);
  }
});

test("exact source provenance, scope and absence of connector/dependency are mandatory", async () => {
  const { policy } = fixture();
  assert.equal((await policy.check(ctx, tool())).ok, false);
  assert.equal((await policy.check(ctx, tool(), "host-mcp")).ok, false);
  assert.equal((await policy.check(ctx, tool("propose_foundry_capability", "sandbox:run"), "foundry")).ok, false);
  for (const extra of [
    { connectionId: OTHER },
    { needs: { name: "run_code", scope: "sandbox:run" } },
    { connector: { key: "fake", via: "mcp", tool: "run_code" } },
  ]) {
    assert.equal(
      (await policy.check(ctx, tool(undefined, undefined, extra as Partial<ToolDefinition>), "foundry")).ok,
      false,
    );
  }
});

test("exact live candidate discovery permits a version but not a guessed prefix or a stale version", async () => {
  let current = DIGEST;
  const { policy } = fixture({ capabilities: async () => [{ candidateId: CANDIDATE, digest: current }] });
  const candidate = tool(capabilityName(), "sandbox:run");
  assert.equal((await policy.check(ctx, candidate, "foundry")).ok, true);
  assert.equal((await policy.check(ctx, tool(`${capabilityName()}_extra`, "sandbox:run"), "foundry")).ok, false);
  assert.equal((await policy.check(ctx, candidate, "other-native-source")).ok, false);
  current = "b".repeat(64);
  assert.equal((await policy.check(ctx, candidate, "foundry")).ok, false);
  assert.equal((await policy.check(ctx, tool(capabilityName(current), "sandbox:run"), "foundry")).ok, true);
  assert.equal((await fixture().policy.check(ctx, candidate, "foundry")).ok, false);
});

test("candidate discovery failures and late answers cannot remove the restriction", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    capabilities: async () => {
      f.change({ status: "canceled" });
      return [{ candidateId: CANDIDATE, digest: DIGEST }];
    },
  });
  assert.equal((await f.policy.check(ctx, tool(capabilityName(), "sandbox:run"), "foundry")).ok, false);
  const failed = fixture({
    capabilities: async () => {
      throw new Error("unavailable");
    },
  });
  assert.equal((await failed.policy.check(ctx, tool(capabilityName(), "sandbox:run"), "foundry")).ok, false);
});

test("every check freshly rejects canceled, reassigned, moved, missing and background runs", async () => {
  for (const change of [
    { status: "canceled" },
    { status: "done" },
    { issueId: OTHER },
    { agentId: OTHER },
    { orgId: OTHER },
    { background: true },
    { workId: OTHER },
    { brain: "codex" },
    { brainSessionId: "old-cli-session" },
  ]) {
    const f = fixture();
    assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, true);
    f.change(change);
    assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, false, JSON.stringify(change));
    assert.equal(await f.policy.protection(ctx), null);
  }
  const missing = fixture();
  missing.remove();
  assert.equal((await missing.policy.check(ctx, tool(), "foundry")).ok, false);
});

test("expiry and forged org/agent identities never turn a pinned run into an unrestricted run", async () => {
  const f = fixture();
  assert.equal((await f.policy.check({ ...ctx, orgId: OTHER }, tool(), "foundry")).ok, false);
  assert.equal((await f.policy.check({ ...ctx, agentId: OTHER }, tool(), "foundry")).ok, false);
  f.advance();
  assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, false);
  assert.equal(await f.policy.sourceAllowed(ctx, "foundry"), false);
  assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, false);
});

test("a genuine model turn is required; CLI, bridge and historical CLI sessions stay refused", async () => {
  const f = fixture();
  assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, true);
  for (const kind of ["codex", "claude_code", "cursor", "opencode", "grok", "antigravity", "new-brain"]) {
    assert.equal((await f.policy.beforeBrain(ctx, kind)).ok, false, kind);
  }
  assert.equal((await f.policy.check({ ...ctx, bridge: { machineId: OTHER } }, tool(), "foundry")).ok, false);
  f.change({ brain: null });
  assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, true);
  assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, true);
  assert.equal(await f.policy.sourceAllowed(ctx, "foundry"), true);
  assert.equal(await f.policy.protection(ctx), null);
  f.change({ brainSessionId: "old-cli-session" });
  assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, false);
});

test("cancellation is checked even after native lifecycle discovery", async () => {
  const abort = new AbortController();
  const f = fixture({
    capabilities: async () => {
      abort.abort();
      return [{ candidateId: CANDIDATE, digest: DIGEST }];
    },
  });
  const canceled = { ...ctx, signal: abort.signal };
  assert.equal((await f.policy.check(canceled, tool(capabilityName(), "sandbox:run"), "foundry")).ok, false);
  assert.equal(await f.policy.sourceAllowed(canceled, "foundry"), false);
});

test("control read errors and bounded timeouts fail closed", async () => {
  const failed = fixture({
    readRun: async () => {
      throw new Error("database unavailable");
    },
  });
  assert.equal((await failed.policy.check(ctx, tool(), "foundry")).ok, false);
  const timedOut = fixture({ controlTimeoutMs: 5, readRun: () => new Promise(() => {}) });
  assert.equal((await timedOut.policy.beforeBrain(ctx, "model")).ok, false);
});

test("operator pin is snapshotted, and mutable transcript/task markers are not authority", async () => {
  const f = fixture();
  (f.pin.runIds as string[]).length = 0;
  f.pin.taskId = OTHER;
  assert.equal(f.policy.requiresModelBrain(ctx), true);
  assert.equal((await f.policy.check(ctx, tool("run_code", "sandbox:run"), "sandbox")).ok, false);
  const unpinned = { ...ctx, runId: OTHER, foundry: true, taskText: "restricted builder phase" } as ToolContext;
  assert.equal(await f.policy.protection(unpinned), null);
});

test("unrelated native runs including other work on the same master task keep their own grants", async () => {
  const f = fixture();
  const anotherRun = { ...ctx, runId: OTHER };
  assert.equal(f.policy.requiresModelBrain(anotherRun), false);
  assert.equal((await f.policy.check(anotherRun, tool("run_code", "sandbox:run"), "sandbox")).ok, true);
  assert.equal((await f.policy.beforeBrain(anotherRun, "codex")).ok, true);
  assert.equal(await f.policy.sourceAllowed(anotherRun, "host-mcp"), true);
  assert.equal(await f.policy.protection(anotherRun), null);
  assert.equal(f.reads, 0);
});

test("protection receipt expressly binds only the verified native builder run", async () => {
  const f = fixture();
  const proof = await f.policy.protection(ctx);
  assert.ok(proof);
  assert.equal(proof.claim, "native_builder_run_only");
  assert.equal(proof.phaseRef, "foundry-phase-1");
  assert.equal(proof.runId, RUN);
  assert.equal(proof.taskId, TASK);
  assert.equal(proof.brain, "model");
  assert.match(proof.policyDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(await f.policy.protection({ ...ctx, bridge: { machineId: OTHER } }), null);
});

test("native evaluation waits retain their protection claim without enabling tools or brain turns", async () => {
  const f = fixture();
  const initial = await f.policy.protection(ctx);
  assert.ok(initial);
  for (const status of ["waiting_input", "waiting_approval"]) {
    f.change({ status });
    const waiting = await f.policy.protection(ctx);
    assert.equal(waiting?.policyDigest, initial.policyDigest);
    assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, false);
    assert.equal(await f.policy.sourceAllowed(ctx, "foundry"), false);
    assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, false);
  }
  f.change({ status: "running" });
  assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, true);
});

test("operator-pinning a fresh run in the same phase preserves the evaluated permission profile", async () => {
  const first = fixture();
  const second = fixture({ pins: [{ ...first.pin, runIds: [RUN, OTHER] }] });
  assert.equal((await first.policy.protection(ctx))?.policyDigest, (await second.policy.protection(ctx))?.policyDigest);
  assert.equal(first.policy.requiresModelBrain({ ...ctx, runId: OTHER }), false);
  assert.equal(second.policy.requiresModelBrain({ ...ctx, runId: OTHER }), true);
});

test("completed builder proof is readable only through the explicit historical evidence path", async () => {
  const f = fixture();
  const proof = await f.policy.protection(ctx);
  f.change({ status: "done" });
  assert.equal(await f.policy.protection(ctx), null);
  assert.equal((await f.policy.protection(ctx, "read_evidence"))?.policyDigest, proof?.policyDigest);
  assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, false);
  assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, false);
});

test("optional reviewed task/Skill reads match exact source, name and scope, never update_skill", async () => {
  const read = {
    sourceName: "reviewed-skill-source",
    name: "read_reviewed_skill",
    scope: "skills:read" as const,
    reviewRef: "operator:sha256:reviewed",
  };
  const f = fixture({ nativeReads: [read] });
  assert.equal(await f.policy.sourceAllowed(ctx, read.sourceName), true);
  assert.equal((await f.policy.check(ctx, tool(read.name, read.scope), read.sourceName)).ok, true);
  assert.equal((await f.policy.check(ctx, tool(read.name, read.scope), "spoofed")).ok, false);
  read.name = "update_skill";
  assert.equal((await f.policy.check(ctx, tool("update_skill", "skills:read"), read.sourceName)).ok, false);
  assert.throws(() => fixture({ nativeReads: [read] }), /Invalid operator-owned/);
});

test("duplicate pins and invalid operator configuration fail at startup", () => {
  const pin = fixture().pin;
  assert.throws(() => fixture({ pins: [pin, pin] }), /Invalid operator-owned/);
  assert.throws(() => fixture({ pins: [{ ...pin, runIds: [] }] }), /Invalid operator-owned/);
  assert.throws(
    () => fixture({ pins: [{ ...pin, phaseRef: undefined as unknown as string }] }),
    /Invalid operator-owned/,
  );
  assert.throws(() => fixture({ pins: [{ ...pin, expiresAt: "not-a-date" }] }), /Invalid operator-owned/);
  assert.throws(() => fixture({ controlTimeoutMs: 10_001 }), /Invalid operator-owned/);
});

test("fresh native run policy column protects a dynamically admitted run and retains its tombstone", async () => {
  let record: FoundryBuilderRunPin | null = fixture().pin;
  const f = fixture({ pins: [], readPin: async () => record });
  assert.equal((await f.policy.beforeBrain(ctx, "codex")).ok, false);
  assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, true);
  assert.equal((await f.policy.protection(ctx))?.claim, "native_builder_run_only");
  record = { ...record!, expiresAt: "2026-11-16T11:00:00.000Z" };
  assert.equal((await f.policy.check(ctx, tool(), "foundry")).ok, false);
  record = null;
  assert.equal((await f.policy.beforeBrain(ctx, "model")).ok, false);
  assert.equal((await f.policy.check(ctx, tool("run_code", "sandbox:run"), "sandbox")).ok, false);
});

test("failed or malformed native policy reads never fall back to ordinary native grants", async () => {
  const failed = fixture({
    pins: [],
    readPin: async () => {
      throw new Error("native row unavailable");
    },
  });
  assert.equal((await failed.policy.check(ctx, tool("run_code", "sandbox:run"), "sandbox")).ok, false);
  assert.equal((await failed.policy.beforeBrain(ctx, "codex")).ok, false);
  const malformed = fixture({ pins: [], readPin: async () => ({ ...fixture().pin, runIds: [OTHER] }) });
  assert.equal((await malformed.policy.check(ctx, tool(), "foundry")).ok, false);
  const absent = fixture({ pins: [], readPin: async () => null });
  assert.equal((await absent.policy.check(ctx, tool("run_code", "sandbox:run"), "sandbox")).ok, true);
});
