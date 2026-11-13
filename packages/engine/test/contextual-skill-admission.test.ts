import { expect, test } from "bun:test";
import {
  decideSkillAdmission,
  type SkillActivationEnvelopeV1,
  type SkillAdmissionFactsV1,
  type SkillUseApprovalV1,
} from "../src/contextual-skill-admission";

const hash = (char: string) => char.repeat(64);
function fixture(): { e: SkillActivationEnvelopeV1; f: SkillAdmissionFactsV1 } {
  const e: SkillActivationEnvelopeV1 = {
    schemaVersion: 1,
    id: "activation-1",
    orgId: "org-1",
    agentId: "agent-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    authority: { kind: "person", personId: "person-1", routineId: null, fingerprint: hash("a") },
    skillId: "skill-1",
    skillVersion: 3,
    contentHash: hash("b"),
    scope: { kind: "run", id: "run-1" },
    approvalId: null,
    purposeHash: hash("c"),
    contextVersion: hash("d"),
    capabilityVersion: hash("e"),
    policyVersion: "policy-1",
    issuedAt: 1_000,
    expiresAt: 20_000,
    revokedAt: null,
    maxUses: 1,
    usedCount: 0,
  };
  const f: SkillAdmissionFactsV1 = {
    schemaVersion: 1,
    serverNow: 10_000,
    checkedAt: 9_950,
    maxAgeMs: 100,
    envelopeVerified: true,
    orgId: e.orgId,
    agentId: e.agentId,
    runId: e.runId,
    taskId: e.taskId,
    sessionId: e.sessionId,
    authority: { ...e.authority },
    runStatus: "running",
    taskState: "open",
    sessionState: "active",
    actorAllowed: true,
    agentArchived: false,
    assignmentEnabled: true,
    skillDeleted: false,
    skillId: e.skillId,
    skillVersion: e.skillVersion,
    contentHash: e.contentHash,
    purposeHash: e.purposeHash,
    underlyingAuthority: "allowed",
    contextVersion: e.contextVersion,
    capabilityVersion: e.capabilityVersion,
    policyVersion: e.policyVersion,
    requiresOwnerApproval: false,
    approval: null,
  };
  return { e, f };
}
function approved(e: SkillActivationEnvelopeV1): SkillUseApprovalV1 {
  return {
    id: "approval-1",
    orgId: e.orgId,
    agentId: e.agentId,
    skillId: e.skillId,
    skillVersion: e.skillVersion,
    contentHash: e.contentHash,
    scope: { ...e.scope },
    purposeHash: e.purposeHash,
    status: "approved",
    expiresAt: 20_000,
    maxUses: 1,
  };
}
for (const kind of ["run", "task", "session"] as const) {
  test(`eligible ${kind} decision does not grant or consume a use`, () => {
    const { e, f } = fixture();
    e.scope = { kind, id: kind === "run" ? f.runId : (f[`${kind}Id`] as string) };
    const before = structuredClone({ e, f });
    expect(decideSkillAdmission(e, f)).toEqual({ decision: "ALLOW", reason: "eligible" });
    expect(decideSkillAdmission(e, f).decision).toBe("ALLOW");
    expect({ e, f }).toEqual(before);
  });
  test(`mismatched ${kind} scope cannot borrow another boundary`, () => {
    const { e, f } = fixture();
    e.scope = { kind, id: "another-scope" };
    expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  });
}
for (const key of ["orgId", "agentId", "runId", "taskId", "sessionId", "skillId"] as const) {
  test(`another ${key} cannot reuse an envelope`, () => {
    const { e, f } = fixture();
    f[key] = "another-id";
    expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  });
}
test("task/session scope needs a native id rather than a thread fallback", () => {
  for (const kind of ["task", "session"] as const) {
    const { e, f } = fixture();
    e.scope = { kind, id: "thread-impostor" };
    e[`${kind}Id`] = null;
    f[`${kind}Id`] = null;
    expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  }
});
test("unverified envelope or substituted person/authority is blocked", () => {
  const { e, f } = fixture();
  f.envelopeVerified = false;
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  f.envelopeVerified = true;
  f.authority.personId = "agent-owner";
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  f.authority = { ...e.authority, fingerprint: hash("f") };
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
});
test("routine and unattended grants never claim to act as their creator", () => {
  for (const kind of ["routine", "unattended"] as const) {
    const { e, f } = fixture();
    e.authority = { kind, personId: null, routineId: kind === "routine" ? "routine-1" : null, fingerprint: hash("a") };
    f.authority = { ...e.authority };
    expect(decideSkillAdmission(e, f).decision).toBe("ALLOW");
    f.authority.personId = "creator";
    expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  }
});
for (const status of ["queued", "waiting_input", "waiting_approval", "done", "failed", "canceled"] as const) {
  test(`${status} run cannot admit another operation`, () => {
    const { e, f } = fixture();
    f.runStatus = status;
    expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  });
}
test("task completion blocks a still-active run and unknown state is not open", () => {
  for (const state of ["terminal", "none", "unknown"] as const) {
    const { e, f } = fixture();
    f.taskState = state;
    expect(decideSkillAdmission(e, f).decision).not.toBe("ALLOW");
  }
  const { e, f } = fixture();
  e.taskId = null;
  f.taskId = null;
  f.taskState = "none";
  expect(decideSkillAdmission(e, f).decision).toBe("ALLOW");
});
test("hard denials beat missing owner approval and soft context drift", () => {
  const mutations: ((e: SkillActivationEnvelopeV1, f: SkillAdmissionFactsV1) => void)[] = [
    (_, f) => {
      f.actorAllowed = false;
    },
    (_, f) => {
      f.agentArchived = true;
    },
    (_, f) => {
      f.assignmentEnabled = false;
    },
    (_, f) => {
      f.skillDeleted = true;
    },
    (_, f) => {
      f.underlyingAuthority = "denied";
    },
    (e) => {
      e.revokedAt = 9_000;
    },
  ];
  for (const mutate of mutations) {
    const { e, f } = fixture();
    f.requiresOwnerApproval = true;
    f.contextVersion = hash("0");
    mutate(e, f);
    expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  }
});
test("version and content hash independently require revalidation", () => {
  const { e, f } = fixture();
  f.skillVersion++;
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "REVALIDATE", reason: "skill_changed" });
  f.skillVersion = e.skillVersion;
  f.contentHash = hash("f");
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "REVALIDATE", reason: "skill_changed" });
});
test("exact expiry and future issue/check/revoke clocks fail closed", () => {
  const { e, f } = fixture();
  e.expiresAt = f.serverNow;
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "expired" });
  e.expiresAt = 20_000;
  e.issuedAt = f.serverNow + 1;
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  e.issuedAt = 1_000;
  f.checkedAt = f.serverNow + 1;
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  f.checkedAt = f.serverNow;
  e.revokedAt = f.serverNow + 1;
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
});
for (const key of ["contextVersion", "capabilityVersion", "policyVersion"] as const) {
  test(`${key} drift is resolved before asking for approval`, () => {
    const { e, f } = fixture();
    f.requiresOwnerApproval = true;
    f[key] = key === "policyVersion" ? "policy-2" : hash("0");
    expect(decideSkillAdmission(e, f)).toEqual({ decision: "REVALIDATE", reason: "context_changed" });
  });
}
test("stale facts and unknown underlying authority are not permission gaps", () => {
  const { e, f } = fixture();
  f.checkedAt = 9_899;
  f.requiresOwnerApproval = true;
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "REVALIDATE", reason: "facts_stale" });
  f.checkedAt = f.serverNow;
  f.underlyingAuthority = "unknown";
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "REVALIDATE", reason: "authority_unknown" });
});
test("owner decision is not fabricated and refusal dominates revalidation", () => {
  const { e, f } = fixture();
  f.requiresOwnerApproval = true;
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "NEEDS_OWNER", reason: "approval_required" });
  e.approvalId = "approval-1";
  f.approval = approved(e);
  f.approval.status = "pending";
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "NEEDS_OWNER", reason: "approval_pending" });
  f.approval.status = "approved";
  expect(decideSkillAdmission(e, f).decision).toBe("ALLOW");
  f.approval.status = "refused";
  f.contextVersion = hash("0");
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "approval_refused" });
});
test("approval binds exact skill/version/hash/scope/purpose/account", () => {
  for (const key of [
    "id",
    "orgId",
    "agentId",
    "skillId",
    "skillVersion",
    "contentHash",
    "scope",
    "purposeHash",
  ] as const) {
    const { e, f } = fixture();
    f.requiresOwnerApproval = true;
    e.approvalId = "approval-1";
    f.approval = approved(e);
    const value =
      key === "skillVersion"
        ? 4
        : key === "scope"
          ? { kind: "task", id: "task-1" }
          : key === "contentHash" || key === "purposeHash"
            ? hash("f")
            : "other";
    f.approval = { ...f.approval, [key]: value } as SkillUseApprovalV1;
    expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "approval_mismatch" });
  }
});
test("missing referenced or expired approval cannot become unapproved use", () => {
  const { e, f } = fixture();
  e.approvalId = "approval-1";
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  f.approval = approved(e);
  f.approval.expiresAt = f.serverNow;
  expect(decideSkillAdmission(e, f).decision).not.toBe("ALLOW");
});
test("once-use exhaustion and wider-than-approved uses fail closed", () => {
  const { e, f } = fixture();
  e.usedCount = 1;
  f.requiresOwnerApproval = true;
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "uses_exhausted" });
  e.usedCount = 0;
  e.approvalId = "approval-1";
  f.approval = approved(e);
  e.maxUses = null;
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
  e.maxUses = 2;
  expect(decideSkillAdmission(e, f).decision).toBe("BLOCKED");
});
test("malformed or omitted data never receives optimistic defaults", () => {
  const { e, f } = fixture();
  for (const bad of [null, [], {}, "approved", { ...e, schemaVersion: 2 }, { ...e, allow: true }]) {
    expect(decideSkillAdmission(bad, f).decision).toBe("BLOCKED");
  }
  for (const bad of [null, {}, { ...f, actorAllowed: undefined }, { ...f, schemaVersion: 2 }]) {
    expect(decideSkillAdmission(e, bad).decision).toBe("BLOCKED");
  }
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "10000"]) {
    expect(decideSkillAdmission({ ...e, issuedAt: value }, f).decision).toBe("BLOCKED");
    expect(decideSkillAdmission(e, { ...f, serverNow: value }).decision).toBe("BLOCKED");
  }
  for (const patch of [{ contentHash: "3" }, { maxUses: 0 }, { usedCount: -1 }, { expiresAt: e.issuedAt }]) {
    expect(decideSkillAdmission({ ...e, ...patch }, f).decision).toBe("BLOCKED");
  }
});
test("frozen native data is unchanged and accessor inputs fail closed without throwing", () => {
  const { e, f } = fixture();
  Object.freeze(e.scope);
  Object.freeze(e.authority);
  Object.freeze(e);
  Object.freeze(f.authority);
  Object.freeze(f);
  expect(decideSkillAdmission(e, f).decision).toBe("ALLOW");
  const hostile = {
    ...e,
    get contentHash() {
      throw Error("not native data");
    },
  };
  expect(decideSkillAdmission(hostile, f).decision).toBe("BLOCKED");
});

test("a still-valid envelope cannot be reused for a different current purpose in the same run", () => {
  for (const requiresOwnerApproval of [false, true]) {
    const { e, f } = fixture();
    f.purposeHash = hash("f");
    f.requiresOwnerApproval = requiresOwnerApproval;
    expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "purpose_mismatch" });
  }
});

test("an ended native session blocks the same running run before owner approval", () => {
  for (const requiresOwnerApproval of [false, true]) {
    const { e, f } = fixture();
    f.sessionState = "terminal";
    f.requiresOwnerApproval = requiresOwnerApproval;
    expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "session_ended" });
  }
});

test("unknown current session state requires revalidation before asking an owner", () => {
  const { e, f } = fixture();
  f.sessionState = "unknown";
  f.requiresOwnerApproval = true;
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "REVALIDATE", reason: "session_unknown" });
});

test("session id and state must agree; a valid no-session run stays eligible", () => {
  const { e, f } = fixture();
  f.sessionState = "none";
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "invalid_facts" });
  e.sessionId = null;
  f.sessionId = null;
  f.sessionState = "active";
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "invalid_facts" });
  f.sessionState = "unknown";
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "BLOCKED", reason: "invalid_facts" });
  f.sessionState = "none";
  expect(decideSkillAdmission(e, f)).toEqual({ decision: "ALLOW", reason: "eligible" });
});
