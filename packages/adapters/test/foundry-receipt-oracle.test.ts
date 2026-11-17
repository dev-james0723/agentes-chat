import { expect, test } from "bun:test";
import { runReceiptOracle } from "../src/foundry-receipt-oracle";
const seed = "ab".repeat(32);
async function fixture() {
  const plan = await runReceiptOracle({ operation: "plan", seed });
  if (!("cases" in plan)) throw new Error("No plan");
  const observations = plan.cases.map((c) => {
    if (c.invalid) return { outcome: "FAILED", code: "SCHEMA_INVALID" };
    const records = (c.input as { records: { status: string; tokens: number }[] }).records;
    const counts = { succeeded: 0, failed: 0, cancelled: 0, unknown: 0, unverified: 0 };
    let tokens = 0;
    for (const row of records) { counts[row.status as keyof typeof counts]++; tokens += row.tokens; }
    return { outcome: "SUCCEEDED", output: { total: records.length, counts, tokens } };
  });
  return { plan, observations };
}
test("separate scorer accepts exact semantics, malformed-input refusals and Unicode notes", async () => {
  const { plan, observations } = await fixture();
  expect(plan.cases.length).toBeGreaterThanOrEqual(20);
  expect(JSON.stringify(plan)).not.toContain("expectedOutput");
  const result = await runReceiptOracle({ operation: "score", seed, observations });
  expect(result).toMatchObject({ outcome: "PASS", casesRun: plan.cases.length });
});
test("plausible counts that silently turn unknown into success fail the independent oracle", async () => {
  const { observations } = await fixture();
  for (const row of observations) if (row.output) {
    row.output.counts.succeeded += row.output.counts.unknown;
    row.output.counts.unknown = 0;
  }
  expect(await runReceiptOracle({ operation: "score", seed, observations })).toMatchObject({ outcome: "FAIL" });
});
test("accepting malformed inputs, missing cases and a forged PASS are never enough", async () => {
  const { plan, observations } = await fixture();
  const index = plan.cases.findIndex(c => c.invalid);
  observations[index] = { outcome: "SUCCEEDED", output: { total: 0, counts: { succeeded: 0, failed: 0, cancelled: 0, unknown: 0, unverified: 0 }, tokens: 0 } };
  expect(await runReceiptOracle({ operation: "score", seed, observations })).toMatchObject({ outcome: "FAIL" });
  expect(await runReceiptOracle({ operation: "score", seed, observations: observations.slice(1) })).toMatchObject({ outcome: "FAIL" });
  await expect(runReceiptOracle({ operation: "score", seed, observations: { outcome: "PASS" } } as never)).rejects.toThrow();
});
test("holdouts vary by protected seed and contain no executable candidate bytes", async () => {
  const a = await runReceiptOracle({ operation: "plan", seed });
  const b = await runReceiptOracle({ operation: "plan", seed: "cd".repeat(32) });
  expect(a).not.toEqual(b);
  await expect(runReceiptOracle({ operation: "plan", seed: "untrusted" })).rejects.toThrow();
});
