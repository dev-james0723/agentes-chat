import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { cacheApproval } from "../src/api/queries";
import type { Approval } from "../src/api/types";
import { approveAllScope } from "../src/lib/approval-card";

const summary = {
  id: "private",
  status: "pending",
  canDecide: true,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  publicationRequired: true,
  params: {},
} as Approval;
const preview = {
  ...summary,
  publication: {
    fingerprint: "a".repeat(64),
    body: "PRIVATE_FULL_BODY",
    bodyHash: "b".repeat(64),
    skillId: "s",
    baseVersion: 1,
    baseCurrent: true,
    destination: "organization_skill_library" as const,
  },
};

test("private sharing never enters a bulk decision", () => {
  expect(approveAllScope([summary]).ids).toEqual([]);
});
test("events and decisions clear protected previews and never copy them into list caches", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.approvals("o"), [summary]);
  qc.setQueryData(keys.approval("o", summary.id), preview);
  cacheApproval(qc, "o", preview);
  expect(JSON.stringify(qc.getQueryData(keys.approvals("o")))).not.toContain("PRIVATE_FULL_BODY");
  const detail = qc.getQueryData<Approval>(keys.approval("o", summary.id));
  expect(detail?.publication).toBeUndefined();
  expect(detail?.canDecide).toBe(false);
  expect(qc.getQueryState(keys.approval("o", summary.id))?.isInvalidated).toBe(true);
});
