import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

const path = new URL("./policy.mjs", import.meta.url);
const implementation = existsSync(path) ? await import(path.href) : {};
const now = Date.parse("2026-11-16T17:00:00Z");
const sha = "a".repeat(40);
const other = "b".repeat(40);
const observation = () => ({
  schema: "delivery-observation/v1",
  repository: "example/app",
  branch: "feat/task",
  head: sha,
  observedAt: new Date(now).toISOString(),
  stable: true,
  errors: [],
  trackedCount: 200,
  changes: [{ path: "src/task.ts", index: " ", worktree: "M" }],
  staged: [],
  deletedPaths: [],
  remote: { status: "not_requested", head: null },
});
const scope = () => ({
  repository: "example/app",
  branch: "feat/task",
  head: sha,
  paths: ["src/task.ts"],
  authorized: true,
  writerConfirmed: true,
});
function checkpoint(changeObservation = () => {}, changeScope = () => {}) {
  assert.equal(typeof implementation.checkCheckpoint, "function", "checkpoint validator must exist");
  const o = observation(),
    s = scope();
  changeObservation(o);
  changeScope(s);
  return implementation.checkCheckpoint(o, s, { now });
}
function release(change = () => {}) {
  assert.equal(typeof implementation.checkRelease, "function", "release validator must exist");
  const x = {
    head: sha,
    expectedHead: sha,
    observedAt: new Date(now).toISOString(),
    trustedChecks: true,
    requiredChecks: ["unit", "typecheck", "lint", "boundaries", "build", "secrets", "regression"],
    checks: ["unit", "typecheck", "lint", "boundaries", "build", "secrets", "regression"].map((name) => ({
      name,
      sha,
      conclusion: "success",
      observedAt: new Date(now).toISOString(),
    })),
    review: { sha, decision: "approved", independent: true, observedAt: new Date(now).toISOString() },
    authorized: true,
    hazardsReviewed: true,
    activeRuns: 0,
    exclusiveLease: true,
    backupRestoreVerified: true,
    stagedArtifactVerified: true,
    rollbackVerified: true,
    runnerCompatible: true,
  };
  change(x);
  return implementation.checkRelease(x, { now });
}

test("one scoped change is eligible for checkpoint, not a deployment claim", () => {
  const r = checkpoint();
  assert.equal(r.ok, true);
  assert.equal(r.stage, "checkpoint_eligible");
  assert.equal(r.deployed, false);
});
for (const [name, change, code] of [
  [
    "wrong repository",
    (o) => {
      o.repository = "other/app";
    },
    "repository_mismatch",
  ],
  [
    "protected branch",
    (o) => {
      o.branch = "main";
    },
    "protected_branch",
  ],
  [
    "detached head",
    (o) => {
      o.branch = "";
    },
    "protected_branch",
  ],
  [
    "changed head",
    (o) => {
      o.head = other;
    },
    "head_mismatch",
  ],
  [
    "stale snapshot",
    (o) => {
      o.observedAt = new Date(now - 600001).toISOString();
    },
    "stale_observation",
  ],
  [
    "future observation",
    (o) => {
      o.observedAt = new Date(now + 60001).toISOString();
    },
    "invalid_observation_time",
  ],
  [
    "unstable worktree",
    (o) => {
      o.stable = false;
    },
    "unstable_observation",
  ],
  [
    "collection failure",
    (o) => {
      o.errors = ["git failed"];
    },
    "collection_failed",
  ],
  [
    "foreign staged file",
    (o) => {
      o.staged = ["src/other.ts"];
    },
    "foreign_staged_path",
  ],
  [
    "bulk deletion",
    (o) => {
      o.deletedPaths = Array.from({ length: 21 }, (_, i) => `src/${i}.ts`);
    },
    "bulk_deletion",
  ],
  [
    "proportionate deletion",
    (o) => {
      o.trackedCount = 4;
      o.deletedPaths = ["src/task.ts"];
    },
    "bulk_deletion",
  ],
  [
    "missing tracked count",
    (o) => {
      delete o.trackedCount;
    },
    "invalid_inventory",
  ],
])
  test(`checkpoint refuses ${name}`, () => {
    const r = checkpoint(change);
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes(code), JSON.stringify(r));
  });
for (const file of [
  "../secret",
  "/etc/passwd",
  ".env",
  ".env.production",
  "ops/owner.cookies",
  "id_rsa",
  "keys/private.pem",
  ".git/config",
]) {
  test(`checkpoint refuses protected or escaping path ${file}`, () => {
    const r = checkpoint(
      (o) => {
        o.changes = [{ path: file, index: "?", worktree: "?" }];
      },
      (s) => {
        s.paths = [file];
      },
    );
    assert.equal(r.ok, false);
    assert.ok(
      r.blockers.some((x) => x === "unsafe_path" || x === "protected_path"),
      JSON.stringify(r),
    );
  });
}
test("checkpoint refuses no explicit authority or writer confirmation", () => {
  assert.ok(
    checkpoint(
      () => {},
      (s) => {
        s.authorized = false;
      },
    ).blockers.includes("authorization_required"),
  );
  assert.ok(
    checkpoint(
      () => {},
      (s) => {
        s.writerConfirmed = false;
      },
    ).blockers.includes("writer_unverified"),
  );
});
test("empty task path list is not a blanket scope", () => {
  assert.ok(
    checkpoint(
      () => {},
      (s) => {
        s.paths = [];
      },
    ).blockers.includes("empty_scope"),
  );
});
test("unrelated unstaged files are left alone", () => {
  assert.equal(
    checkpoint((o) => {
      o.changes.push({ path: "someone-else.ts", index: " ", worktree: "M" });
    }).ok,
    true,
  );
});
test("merge evidence is eligible only with every explicit gate", () => {
  assert.equal(release().ok, true);
});
for (const [name, change, code] of [
  [
    "empty required checks",
    (x) => {
      x.requiredChecks = [];
    },
    "missing_required_checks",
  ],
  [
    "no checks",
    (x) => {
      x.checks = [];
    },
    "check_missing:unit",
  ],
  [
    "untrusted checks",
    (x) => {
      x.trustedChecks = false;
    },
    "untrusted_checks",
  ],
  [
    "wrong check SHA",
    (x) => {
      x.checks[0].sha = other;
    },
    "check_sha_mismatch:unit",
  ],
  [
    "skipped check",
    (x) => {
      x.checks[0].conclusion = "skipped";
    },
    "check_not_success:unit",
  ],
  [
    "stale checks",
    (x) => {
      x.checks[0].observedAt = new Date(now - 86400001).toISOString();
    },
    "check_stale:unit",
  ],
  [
    "stale review",
    (x) => {
      x.review.sha = other;
    },
    "review_unverified",
  ],
  [
    "self review",
    (x) => {
      x.review.independent = false;
    },
    "review_unverified",
  ],
  [
    "moved PR head",
    (x) => {
      x.expectedHead = other;
    },
    "head_mismatch",
  ],
  [
    "active runs",
    (x) => {
      x.activeRuns = 1;
    },
    "active_work",
  ],
  [
    "unknown active runs",
    (x) => {
      delete x.activeRuns;
    },
    "active_work",
  ],
  [
    "missing rollback",
    (x) => {
      x.rollbackVerified = false;
    },
    "rollback_unverified",
  ],
  [
    "unknown runner",
    (x) => {
      delete x.runnerCompatible;
    },
    "runner_unverified",
  ],
  [
    "missing lock",
    (x) => {
      x.exclusiveLease = false;
    },
    "lease_unverified",
  ],
  [
    "missing backup restore",
    (x) => {
      x.backupRestoreVerified = false;
    },
    "backup_restore_unverified",
  ],
])
  test(`release refuses ${name}`, () => {
    const r = release(change);
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes(code), JSON.stringify(r));
  });
test("malformed observation never passes", () => {
  assert.equal(implementation.checkCheckpoint({}, {}, { now }).ok, false);
  assert.equal(implementation.checkRelease({}, { now }).ok, false);
});

test("an observation cannot lower the mandatory release check set to a smoke test", () => {
  const r = release((x) => {
    x.requiredChecks = ["smoke"];
    x.checks = [{ name: "smoke", sha, conclusion: "success", observedAt: new Date(now).toISOString() }];
  });
  assert.equal(r.ok, false);
  assert.ok(r.blockers.includes("required_policy_checks_missing"));
});
