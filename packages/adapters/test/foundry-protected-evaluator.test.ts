import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtectedFoundryEvaluationLedger } from "../src/foundry-protected-evaluator";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function path() { const d = mkdtempSync(join(tmpdir(), "foundry-evaluation-test-")); dirs.push(d); return join(d, "private.sqlite"); }
test("evaluation cancellation before dispatch survives restart and fences a late submission", () => {
  const p = path(); const a = new ProtectedFoundryEvaluationLedger(p);
  a.requestCancel("job"); a.close();
  const b = new ProtectedFoundryEvaluationLedger(p);
  expect(b.reserve("job", "identity", "{}", Date.now() + 10000)).toBe(false);
  expect(b.start("job", "identity")).toBe(false);
  expect(b.read("job")?.phase).toBe("CANCELLED"); b.close();
});
test("only one protected worker may claim a job and lost dispatch cannot replay", () => {
  const p = path(); const a = new ProtectedFoundryEvaluationLedger(p);
  expect(a.reserve("job", "identity", "{}", Date.now() + 10000)).toBe(true);
  expect(a.start("job", "identity")).toBe(true);
  expect(a.start("job", "identity")).toBe(false); a.close();
  const b = new ProtectedFoundryEvaluationLedger(p);
  expect(b.reserve("job", "identity", "{}", Date.now() + 10000)).toBe(false);
  expect(b.start("job", "identity")).toBe(false);
  expect(b.read("job")?.phase).toBe("RUNNING"); b.close();
});
test("an evaluator cannot publish a PASS after a durable cancellation", () => {
  const a = new ProtectedFoundryEvaluationLedger(path());
  a.reserve("job", "identity", "{}", Date.now() + 10000); a.start("job", "identity");
  a.requestCancel("job");
  expect(a.finish("job", "identity", JSON.stringify({ outcome: "PASS" }), "{}")).toBe(false);
  expect(a.read("job")?.result).toBeNull(); a.close();
});
test("receipts cannot leak through a changed job identity", () => {
  const a = new ProtectedFoundryEvaluationLedger(path());
  a.reserve("job", "identity", "{}", Date.now() + 10000); a.start("job", "identity");
  expect(a.finish("job", "other-tenant", "{}", "{}")).toBe(false);
  expect(a.read("job")?.result).toBeNull(); a.close();
});
