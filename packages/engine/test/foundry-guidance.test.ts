// SF-06 (docs/adr/native-capability-foundry.md): the builder sees only the public contract, so it has to say everything the protected scorer
// checks (packages/adapters/test/foundry-receipt-conformance.test.ts proves an implementation written from it passes).
import { expect, test } from "bun:test";
import { foundryDraftGuidance } from "../src/foundry/guidance";

test("the public contract names the output's meaning, the error's form and the silent stdout", () => {
  const g = foundryDraftGuidance();
  expect(g.output).toContain("`total` is the number of records");
  expect(g.output).toContain("`tokens` is the sum");
  expect(g.abi).toContain("own `code` property");
  expect(g.abi).toContain("Object.assign(new Error");
  expect(g.abi).toContain("console");
  expect(g.semantics).toContain("4096 Unicode scalar values");
  // A worked example of its own, consistent with the output description.
  const input = JSON.parse(g.example.inputJson) as { records: { status: string; tokens: number }[] };
  const output = JSON.parse(g.example.outputJson) as { total: number; tokens: number; counts: Record<string, number> };
  expect(output.total).toBe(input.records.length);
  expect(output.tokens).toBe(input.records.reduce((sum, r) => sum + r.tokens, 0));
  expect(Object.keys(output.counts)).toEqual(["succeeded", "failed", "cancelled", "unknown", "unverified"]);
});
