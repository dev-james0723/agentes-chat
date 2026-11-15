import { expect, test } from "bun:test";
import type { SkillActivationEnvelopeV1, SkillAdmissionFactsV1 } from "../src/contextual-skill-admission";
import {
  createContextualSkillPlan,
  type NativeSkillPlanEvidence,
  type SkillPlanDeps,
  type SkillPlanInput,
} from "../src/contextual-skill-plan";
import { createJevJudge } from "../src/judge";

const NOW = 1_800_000_000_000;
const h = (c: string) => c.repeat(64);
function evidence(id = "skill-1"): NativeSkillPlanEvidence {
  const envelope: SkillActivationEnvelopeV1 = {
    schemaVersion: 1,
    id: `activation-${id}`,
    orgId: "org",
    agentId: "agent",
    runId: "run",
    taskId: "task",
    sessionId: "session",
    authority: { kind: "person", personId: "person", routineId: null, fingerprint: h("a") },
    skillId: id,
    skillVersion: 1,
    contentHash: h("b"),
    scope: { kind: "task", id: "task" },
    approvalId: null,
    purposeHash: h("c"),
    contextVersion: h("d"),
    capabilityVersion: h("e"),
    policyVersion: "policy-1",
    issuedAt: NOW - 100,
    expiresAt: NOW + 20_000,
    revokedAt: null,
    maxUses: 1,
    usedCount: 0,
  };
  const facts: SkillAdmissionFactsV1 = {
    schemaVersion: 1,
    serverNow: NOW,
    checkedAt: NOW,
    maxAgeMs: 1000,
    envelopeVerified: true,
    orgId: "org",
    agentId: "agent",
    runId: "run",
    taskId: "task",
    sessionId: "session",
    authority: { ...envelope.authority },
    runStatus: "running",
    taskState: "open",
    sessionState: "active",
    actorAllowed: true,
    agentArchived: false,
    assignmentEnabled: true,
    skillDeleted: false,
    skillId: id,
    skillVersion: 1,
    contentHash: h("b"),
    purposeHash: h("c"),
    underlyingAuthority: "allowed",
    contextVersion: h("d"),
    capabilityVersion: h("e"),
    policyVersion: "policy-1",
    requiresOwnerApproval: false,
    approval: null,
  };
  return {
    envelope,
    facts,
    egress: {
      orgId: "org",
      projectId: "project",
      contextVersion: h("d"),
      policyVersion: "policy-1",
      expiresAt: NOW + 500,
      summary: "Approved synthetic skill summary",
    },
  };
}
function fixture() {
  const page = {
    agent_id: "agent",
    source: "native_agent_runtime",
    captured_at: new Date(NOW - 100).toISOString(),
    expires_at: new Date(NOW + 20_000).toISOString(),
    context_version: h("d"),
    usage_observed_version: h("9"),
    changed: null,
    authority: false,
    acting_person: true,
    section: "skills",
    offset: 0,
    total: 1,
    complete: true,
    next_offset: null as number | null,
    items: [{ id: "skill-1", name: "Synthetic", version: 1 }],
  };
  const input: SkillPlanInput = {
    context: {
      orgId: "org",
      projectId: "project",
      agentId: "agent",
      runId: "run",
      taskId: "task",
      sessionId: "session",
      contextVersion: h("d"),
      capabilityVersion: h("e"),
      policyVersion: "policy-1",
      purposeHash: h("c"),
      serverNow: NOW,
    },
    profilePages: [page],
    candidateIds: ["skill-1"],
    explicit: [{ id: "skill-1", version: 1 }],
  };
  const row = evidence();
  const rows = [row];
  const seen: string[][] = [];
  const deps: SkillPlanDeps = {
    now: () => NOW,
    readNativeEvidence: async (ids) => {
      seen.push([...ids]);
      return rows;
    },
  };
  return { input, page, row, rows, deps, seen };
}

test("explicit approved mapping uses no model, grants nothing and consumes no use", async () => {
  const f = fixture();
  const before = structuredClone(f.rows);
  f.deps.judge = {
    name: "unexpected",
    ask: async () => {
      throw Error("must not call");
    },
  };
  const plan = await createContextualSkillPlan(f.input, f.deps);
  expect(plan).toMatchObject({
    status: "recommended",
    path: "rules",
    authority: false,
    requiresExecutionRevalidation: true,
    decisionCalls: 0,
    recommendations: [{ skillId: "skill-1", version: 1, contentHash: h("b") }],
  });
  expect(f.rows).toEqual(before);
});

for (const [label, mutate] of [
  [
    "expired",
    (f: ReturnType<typeof fixture>) => {
      f.page.expires_at = new Date(NOW).toISOString();
    },
  ],
  [
    "incomplete",
    (f: ReturnType<typeof fixture>) => {
      f.page.complete = false;
      f.page.next_offset = 1;
      f.page.total = 2;
    },
  ],
  [
    "wrong agent",
    (f: ReturnType<typeof fixture>) => {
      f.page.agent_id = "other";
    },
  ],
  [
    "changed context",
    (f: ReturnType<typeof fixture>) => {
      f.page.context_version = h("f");
    },
  ],
  [
    "authority claim",
    (f: ReturnType<typeof fixture>) => {
      (f.page as { authority: boolean }).authority = true;
    },
  ],
  [
    "oversized list",
    (f: ReturnType<typeof fixture>) => {
      f.input.candidateIds = Array.from({ length: 13 }, (_, i) => `skill-${i}`);
    },
  ],
] as const)
  test(`profile ${label} abstains before native reads or a judge`, async () => {
    const f = fixture();
    mutate(f);
    expect((await createContextualSkillPlan(f.input, f.deps)).status).toBe("abstain");
    expect(f.seen).toHaveLength(0);
  });

for (const [label, mutate] of [
  [
    "revoked",
    (r: NativeSkillPlanEvidence) => {
      r.envelope.revokedAt = NOW;
    },
  ],
  [
    "assignment disabled",
    (r: NativeSkillPlanEvidence) => {
      r.facts.assignmentEnabled = false;
    },
  ],
  [
    "version changed",
    (r: NativeSkillPlanEvidence) => {
      r.facts.skillVersion = 2;
    },
  ],
  [
    "hash changed",
    (r: NativeSkillPlanEvidence) => {
      r.facts.contentHash = h("f");
    },
  ],
  [
    "purpose changed",
    (r: NativeSkillPlanEvidence) => {
      r.facts.purposeHash = h("f");
    },
  ],
  [
    "actor revoked",
    (r: NativeSkillPlanEvidence) => {
      r.facts.actorAllowed = false;
    },
  ],
  [
    "unknown authority",
    (r: NativeSkillPlanEvidence) => {
      r.facts.underlyingAuthority = "unknown";
    },
  ],
  [
    "approval required",
    (r: NativeSkillPlanEvidence) => {
      r.facts.requiresOwnerApproval = true;
    },
  ],
  [
    "ended session",
    (r: NativeSkillPlanEvidence) => {
      r.facts.sessionState = "terminal";
    },
  ],
  [
    "wrong native boundary",
    (r: NativeSkillPlanEvidence) => {
      r.facts.orgId = r.envelope.orgId = "other";
    },
  ],
] as const)
  test(`native ${label} cannot become a recommendation`, async () => {
    const f = fixture();
    mutate(f.row);
    const plan = await createContextualSkillPlan(f.input, f.deps);
    expect(plan.status).toBe("abstain");
    expect(plan.recommendations).toEqual([]);
  });

test("observational labels and a supplied allow boolean do not replace a native reader", async () => {
  const f = fixture();
  expect((await createContextualSkillPlan(f.input, { now: () => NOW, readNativeEvidence: true } as never)).status).toBe(
    "abstain",
  );
});

test("all profile pages must be contiguous and share one capability context", async () => {
  const f = fixture();
  f.page.total = 2;
  f.page.complete = false;
  f.page.next_offset = 1;
  const second = {
    ...f.page,
    offset: 1,
    complete: true,
    next_offset: null,
    items: [{ id: "skill-2", name: "Two", version: 1 }],
  };
  f.input.profilePages = [f.page, second];
  f.input.candidateIds = ["skill-1", "skill-2"];
  f.rows.push(evidence("skill-2"));
  expect((await createContextualSkillPlan(f.input, f.deps)).status).toBe("recommended");
  second.context_version = h("f");
  expect((await createContextualSkillPlan(f.input, f.deps)).status).toBe("abstain");
});

test("usage-only change and duplicate identical events retain a stable planning fingerprint", async () => {
  const f = fixture();
  const first = await createContextualSkillPlan(f.input, f.deps);
  f.page.usage_observed_version = h("8");
  const next = await createContextualSkillPlan(f.input, f.deps);
  expect(next.fingerprint).toBe(first.fingerprint);
  expect(next.decisionCalls).toBe(0);
});

test("more than three explicit requests abstain instead of silently dropping a required skill", async () => {
  const f = fixture();
  f.input.explicit = Array.from({ length: 4 }, (_, i) => ({ id: `skill-${i}`, version: 1 }));
  expect((await createContextualSkillPlan(f.input, f.deps)).status).toBe("abstain");
});

test("unresolved fit defaults to abstention with no semantic call", async () => {
  const f = fixture();
  delete f.input.explicit;
  expect(await createContextualSkillPlan(f.input, f.deps)).toMatchObject({
    status: "abstain",
    reason: "semantic_unqualified",
    decisionCalls: 0,
  });
});

function semantics(f: ReturnType<typeof fixture>, choice = "skill-1", confidence = 0.92) {
  delete f.input.explicit;
  const bodies: unknown[] = [];
  f.deps.semantic = {
    summary: "Synthetic approved task summary",
    orgId: "org",
    projectId: "project",
    contextVersion: h("d"),
    policyVersion: "policy-1",
    purposeHash: h("c"),
    expiresAt: NOW + 500,
    approvalSourceRef: "native-fixture",
    remainingCalls: 1,
    calibration: {
      decisionClass: "contextual_skill_fit",
      questionVersion: "wp3-a/1",
      resolvedModel: "jev-1.14.0",
      minConfidence: 0.8,
      minMargin: 0.1,
      evidenceRef: "synthetic-calibration-only",
      expiresAt: NOW + 500,
    },
  };
  f.deps.judge = createJevJudge({
    key: "synthetic",
    gateway: { recordExternalUsage: async () => "synthetic-usage" },
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        model: "jev-1.14.0",
        answers: {
          fit: { choice, confidence, probabilities: { "skill-1": 0.92, none: 0.04, insufficient_evidence: 0.04 } },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      });
    }) as unknown as typeof fetch,
  });
  return bodies;
}

test("bounded semantic fixture uses only qualified egress metadata and the shared calibrated Judge", async () => {
  const f = fixture();
  const bodies = semantics(f);
  const plan = await createContextualSkillPlan(f.input, f.deps);
  expect(plan).toMatchObject({
    status: "recommended",
    path: "jev",
    decisionCalls: 1,
    authority: false,
    recommendations: [{ skillId: "skill-1" }],
  });
  expect(bodies).toHaveLength(1);
  expect(JSON.stringify(bodies)).not.toContain("activation-");
});

for (const reason of ["private candidate", "expired policy", "unqualified calibration", "exhausted budget"] as const)
  test(`${reason} cannot call a semantic judge`, async () => {
    const f = fixture();
    const bodies = semantics(f);
    const policy = f.deps.semantic;
    if (!policy) throw Error("fixture policy missing");
    if (reason === "private candidate") delete f.row.egress;
    if (reason === "expired policy") policy.expiresAt = NOW;
    if (reason === "unqualified calibration") policy.calibration.expiresAt = NOW;
    if (reason === "exhausted budget") policy.remainingCalls = 0;
    expect((await createContextualSkillPlan(f.input, f.deps)).status).toBe("abstain");
    expect(bodies).toHaveLength(0);
  });

test("low confidence, malformed and foreign choices abstain without a fallback or retry", async () => {
  for (const [choice, confidence] of [
    ["skill-1", 0.2],
    ["foreign", 1],
    ["none", 1],
    ["insufficient_evidence", 1],
  ] as const) {
    const f = fixture();
    const bodies = semantics(f, choice, confidence);
    const plan = await createContextualSkillPlan(f.input, f.deps);
    expect(plan.status).toBe("abstain");
    expect(plan.decisionCalls).toBe(1);
    expect(bodies).toHaveLength(1);
  }
});

test("a cross-project/private candidate is excluded before forming any semantic request", async () => {
  const f = fixture();
  f.page.total = 2;
  f.page.items.push({ id: "skill-2", name: "Private body never sent", version: 1 });
  f.input.candidateIds = ["skill-1", "skill-2"];
  const other = evidence("skill-2");
  if (!other.egress) throw Error("fixture egress missing");
  other.egress = { ...other.egress, projectId: "other-project", summary: "PRIVATE_PROJECT_CONTENT" };
  f.rows.push(other);
  const bodies = semantics(f);
  expect((await createContextualSkillPlan(f.input, f.deps)).status).toBe("recommended");
  expect(JSON.stringify(bodies)).not.toContain("PRIVATE_PROJECT_CONTENT");
  expect(JSON.stringify(bodies)).not.toContain('"skill-2"');
});

test("three explicit qualified skills stay bounded and do not manufacture activation", async () => {
  const f = fixture();
  f.page.items = [1, 2, 3].map((i) => ({ id: `skill-${i}`, name: "Synthetic", version: 1 }));
  f.page.total = 3;
  f.rows.splice(0, f.rows.length, ...[1, 2, 3].map((i) => evidence(`skill-${i}`)));
  f.input.candidateIds = f.page.items.map((s) => s.id);
  f.input.explicit = f.page.items.map(({ id, version }) => ({ id, version }));
  const plan = await createContextualSkillPlan(f.input, f.deps);
  expect(plan.recommendations).toHaveLength(3);
  expect(plan.authority).toBe(false);
  expect(plan.decisionCalls).toBe(0);
});

test("a resolved-model change invalidates a previously qualified semantic policy", async () => {
  const f = fixture();
  semantics(f);
  const policy = f.deps.semantic;
  if (!policy) throw Error("fixture policy missing");
  policy.calibration.resolvedModel = "jev-old";
  expect(await createContextualSkillPlan(f.input, f.deps)).toMatchObject({
    status: "abstain",
    reason: "model_unqualified",
    decisionCalls: 1,
  });
});

test("evidence expiring while judging abstains without renewing the budget", async () => {
  const f = fixture();
  const bodies = semantics(f);
  const shared = f.deps.judge;
  if (!shared) throw Error("fixture judge missing");
  let clock = NOW;
  f.deps.now = () => clock;
  f.deps.judge = {
    name: shared.name,
    ask: async (request) => {
      const answer = await shared.ask(request);
      clock += 2000;
      return answer;
    },
  };
  expect(await createContextualSkillPlan(f.input, f.deps)).toMatchObject({
    status: "abstain",
    reason: "evidence_expired",
    decisionCalls: 1,
  });
  expect(bodies).toHaveLength(1);
});

test("native-reader and judge failures are unknown, with no hidden retry or paid fallback", async () => {
  const f = fixture();
  f.deps.readNativeEvidence = async () => {
    throw Error("native unavailable");
  };
  expect(await createContextualSkillPlan(f.input, f.deps)).toMatchObject({ status: "abstain", decisionCalls: 0 });
  const g = fixture();
  semantics(g);
  let calls = 0;
  g.deps.judge = {
    name: "jev",
    ask: async () => {
      calls++;
      throw Error("down");
    },
  };
  expect(await createContextualSkillPlan(g.input, g.deps)).toMatchObject({ status: "abstain", decisionCalls: 1 });
  expect(calls).toBe(1);
});

test("a receipt from different judgment inputs cannot qualify a recommendation", async () => {
  const f = fixture();
  semantics(f);
  const shared = f.deps.judge;
  if (!shared) throw Error("fixture judge missing");
  f.deps.judge = { name: shared.name, ask: (request) => shared.ask({ ...request, state: { different: "fixture" } }) };
  expect(await createContextualSkillPlan(f.input, f.deps)).toMatchObject({
    status: "abstain",
    reason: "judgment_unbound",
    decisionCalls: 1,
  });
});

test("semantic input changes invalidate the planning fingerprint even before a caller updates its purpose version", async () => {
  const f = fixture();
  semantics(f);
  const first = await createContextualSkillPlan(f.input, f.deps);
  const policy = f.deps.semantic;
  if (!policy) throw Error("fixture policy missing");
  policy.summary = "Different approved synthetic task summary";
  const next = await createContextualSkillPlan(f.input, f.deps);
  expect(next.status).toBe("recommended");
  expect(next.fingerprint).not.toBe(first.fingerprint);
});

test("candidate egress expiring during judgment invalidates the result", async () => {
  const f = fixture();
  semantics(f);
  if (!f.row.egress || !f.deps.judge) throw Error("fixture missing");
  f.row.egress.expiresAt = NOW + 10;
  const shared = f.deps.judge;
  let clock = NOW;
  f.deps.now = () => clock;
  f.deps.judge = {
    name: shared.name,
    ask: async (request) => {
      const answer = await shared.ask(request);
      clock += 20;
      return answer;
    },
  };
  expect(await createContextualSkillPlan(f.input, f.deps)).toMatchObject({
    status: "abstain",
    reason: "evidence_expired",
  });
});

test("semantic recommendation expiry respects the earliest policy, egress and calibration deadline", async () => {
  const f = fixture();
  semantics(f);
  if (!f.row.egress || !f.deps.semantic) throw Error("fixture missing");
  f.row.egress.expiresAt = NOW + 10;
  f.deps.semantic.calibration.expiresAt = NOW + 20;
  expect((await createContextualSkillPlan(f.input, f.deps)).expiresAt).toBe(NOW + 10);
});

async function settlePlanLocally(pending: ReturnType<typeof createContextualSkillPlan>) {
  let guard: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    pending,
    new Promise<null>((resolve) => {
      guard = setTimeout(() => resolve(null), 1750);
    }),
  ]);
  clearTimeout(guard);
  expect(result).not.toBeNull();
  if (!result) throw Error("planner did not settle within the local deadline guard");
  return result;
}

test("a Judge ignoring timeout still settles the plan locally with one consumed call", async () => {
  const f = fixture();
  semantics(f);
  let calls = 0;
  f.deps.judge = {
    name: "nonsettling",
    ask: () => {
      calls++;
      return new Promise(() => {});
    },
  };
  const plan = await settlePlanLocally(createContextualSkillPlan(f.input, f.deps));
  expect(plan).toMatchObject({ status: "abstain", reason: "semantic_deadline", decisionCalls: 1, recommendations: [] });
  expect(calls).toBe(1);
});

test("shared Judge accounting may finish late without promoting the timed-out plan", async () => {
  const f = fixture();
  semantics(f);
  let release: () => void = () => {};
  const accounting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetches = 0,
    records = 0,
    completed = 0;
  const shared = createJevJudge({
    key: "synthetic",
    gateway: {
      recordExternalUsage: async () => {
        records++;
        await accounting;
        return "synthetic-usage";
      },
    },
    fetch: (async () => {
      fetches++;
      return Response.json({
        model: "jev-1.14.0",
        answers: {
          fit: {
            choice: "skill-1",
            confidence: 0.92,
            probabilities: { "skill-1": 0.92, none: 0.04, insufficient_evidence: 0.04 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 0 },
      });
    }) as unknown as typeof fetch,
  });
  f.deps.judge = {
    name: shared.name,
    ask: async (request) => {
      const answer = await shared.ask(request);
      completed++;
      return answer;
    },
  };
  try {
    const plan = await settlePlanLocally(createContextualSkillPlan(f.input, f.deps));
    expect(plan).toMatchObject({
      status: "abstain",
      reason: "semantic_deadline",
      decisionCalls: 1,
      recommendations: [],
    });
    const frozen = JSON.stringify(plan);
    expect(completed).toBe(0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed).toBe(1);
    expect(JSON.stringify(plan)).toBe(frozen);
    expect(fetches).toBe(1);
    expect(records).toBe(1);
  } finally {
    release();
  }
});

test("a late Judge rejection is observed without a retry or result publication", async () => {
  const f = fixture();
  semantics(f);
  let reject: (reason: Error) => void = () => {};
  let calls = 0;
  const late = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  f.deps.judge = {
    name: "late-rejection",
    ask: () => {
      calls++;
      return late;
    },
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const plan = await settlePlanLocally(createContextualSkillPlan(f.input, f.deps));
    const frozen = JSON.stringify(plan);
    reject(Error("late synthetic failure"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(plan).toMatchObject({
      status: "abstain",
      reason: "semantic_deadline",
      decisionCalls: 1,
      recommendations: [],
    });
    expect(JSON.stringify(plan)).toBe(frozen);
    expect(unhandled).toEqual([]);
    expect(calls).toBe(1);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
