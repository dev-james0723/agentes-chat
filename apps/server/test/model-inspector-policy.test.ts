import { expect, test } from "bun:test";
import { testConfig } from "@agenteschat/config";
import { createQuotaCliQualifier, type MachineStatus } from "@agenteschat/engine";
import { scopeQuotaContinuation } from "../src/engine";

const orgId = "b221b439-4343-459b-bd26-f2abd0dfe764";
const otherOrgId = "0193eeee-0000-4000-8000-0000000000a1";

function fixture(global: boolean, orgs = orgId) {
  const config = testConfig({ QUOTA_HANDOFF_ENABLED: String(global), MODEL_INSPECTOR_ORG_IDS: orgs });
  let reads = 0;
  const status: MachineStatus = {
    id: "machine",
    orgId,
    name: "Computer",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: 57,
    executors: {
      codex: { version: "test" },
      ownUsage: {
        codex: {
          source: "probe",
          at: new Date().toISOString(),
          windows: [{ kind: "seven_day", usedPercent: 20, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
        },
      },
    },
  };
  const qualifier = scopeQuotaContinuation(
    config,
    createQuotaCliQualifier({
      models: { codex: config.QUOTA_HANDOFF_CODEX_MODEL },
      targets: ["codex"],
      machines: {
        status: async () => {
          reads++;
          return status;
        },
      },
    }),
  );
  const qualify = (id: string) =>
    qualifier.qualify({
      orgId: id,
      agentId: "agent",
      runId: "run",
      channelId: "channel",
      goalMessageId: "goal",
      machineId: "machine",
      sourceKind: "claude_code",
      sourceAccountId: null,
      targetKind: "codex",
      requiredTools: [],
      context: { system: [], messages: [] },
    });
  return { qualify, reads: () => reads, qualifier, status };
}

test("an opted-in workspace gets native subscription qualification with global handoff disabled", async () => {
  const f = fixture(false);
  expect(f.qualifier.enabled?.(orgId)).toBe(true);
  expect(f.qualifier.enabled?.(otherOrgId)).toBe(false);
  expect(await f.qualify(otherOrgId)).toBeNull();
  expect(f.reads()).toBe(0);
  const route = await f.qualify(orgId);
  expect(route?.targetKind).toBe("codex");
  expect(route?.noPaidExtraUsage).toBe(true);
  expect(f.reads()).toBe(1);
  expect(f.qualifier.targets).toEqual(["codex"]);
  // Scope does not bypass the real qualifier's sign-in evidence.
  f.status.executors = { codex: { version: "test" } };
  expect(await f.qualify(orgId)).toBeNull();
});

test("global continuity retains its scope while an empty disabled configuration qualifies nothing", async () => {
  expect((await fixture(true).qualify(otherOrgId))?.targetKind).toBe("codex");
  const f = fixture(false, "");
  expect(await f.qualify(orgId)).toBeNull();
  expect(f.reads()).toBe(0);
});
