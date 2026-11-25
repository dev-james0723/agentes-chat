// SF-06/SF-14 (docs/adr/native-capability-foundry.md): the protected scorer is the bar, and the public contract must be enough to clear it.
// These candidates are test-owned module text run the way the container's bootstrap classifies a result (an
// explicit own `code` of SCHEMA_INVALID, anything else a failure). They show that an implementation written from
// the public contract passes unchanged holdouts, and that the three mistakes the public words used to leave open
// each fail them. Nothing here weakens or reads around the scorer.
import { describe, expect, test } from "bun:test";
import { runReceiptOracle } from "../src/foundry-receipt-oracle";

const SEEDS = ["ab".repeat(32), "0f".repeat(32), "9c".repeat(32)];

/** Written from the public contract alone: the semantics, the ABI and the output description. */
const REFERENCE = String.raw`
const STATUSES = ["succeeded", "failed", "cancelled", "unknown", "unverified"];
const fail = () => { throw Object.assign(new Error("malformed receipt input"), { code: "SCHEMA_INVALID" }); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function normalizeReceiptJson(inputJson) {
  let input;
  try { input = JSON.parse(inputJson); } catch { fail(); }
  if (!plain(input) || Object.keys(input).length !== 1 || !Array.isArray(input.records)) fail();
  if (input.records.length > 1000) fail();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let tokens = 0;
  for (const row of input.records) {
    if (!plain(row)) fail();
    const keys = Object.keys(row);
    if (!keys.every((k) => k === "status" || k === "tokens" || k === "note")) fail();
    if (!STATUSES.includes(row.status)) fail();
    if (!Number.isSafeInteger(row.tokens) || row.tokens < 0 || row.tokens > 1000000000) fail();
    if ("note" in row) {
      if (typeof row.note !== "string") fail();
      let scalars = 0;
      for (const ch of row.note) {
        const p = ch.codePointAt(0);
        if (p >= 0xd800 && p <= 0xdfff) fail();
        scalars++;
      }
      if (scalars > 4096) fail();
    }
    counts[row.status]++;
    tokens += row.tokens;
  }
  return JSON.stringify({ total: input.records.length, counts, tokens });
}`;

/** The same classification as FOUNDRY_DOCKER_BOOTSTRAP, in process, for test-owned text only. */
async function observe(source: string, inputJson: string) {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  try {
    const value = await module.normalizeReceiptJson(inputJson);
    if (typeof value !== "string") return { outcome: "FAILED", code: "EVAL_FAILED" };
    return { outcome: "SUCCEEDED", output: JSON.parse(value) as unknown };
  } catch (error) {
    const own = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : null;
    return {
      outcome: "FAILED",
      code: own && "value" in own && own.value === "SCHEMA_INVALID" ? "SCHEMA_INVALID" : "EVAL_FAILED",
    };
  }
}

/** The evaluator's own serialization of a case (sorted keys), as it sends `inputJson`. */
const stable = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(",")}}`;

async function score(source: string, seed: string) {
  const plan = await runReceiptOracle({ operation: "plan", seed });
  if (!("cases" in plan)) throw new Error("no plan");
  const observations = [];
  for (const c of plan.cases) observations.push(await observe(source, stable(c.input)));
  const verdict = await runReceiptOracle({ operation: "score", seed, observations });
  return "outcome" in verdict ? verdict.outcome : "NONE";
}

describe("the public receipt contract is enough to pass the unchanged protected scorer", () => {
  test("an implementation written from the public contract passes every seed", async () => {
    for (const seed of SEEDS) expect(await score(REFERENCE, seed)).toBe("PASS");
  });

  test("`total` read as the token sum fails: it is the number of records", async () => {
    const mistaken = REFERENCE.replace("total: input.records.length", "total: tokens");
    expect(mistaken).not.toBe(REFERENCE);
    expect(await score(mistaken, SEEDS[0]!)).toBe("FAIL");
  });

  test("a `code` the error only inherits or computes fails: it must be the error's own value", async () => {
    const mistaken = REFERENCE.replace(
      'const fail = () => { throw Object.assign(new Error("malformed receipt input"), { code: "SCHEMA_INVALID" }); };',
      'class SchemaError extends Error { get code() { return "SCHEMA_INVALID"; } }\nconst fail = () => { throw new SchemaError("malformed"); };',
    );
    expect(mistaken).not.toBe(REFERENCE);
    expect(await score(mistaken, SEEDS[0]!)).toBe("FAIL");
  });

  test("a note limit counted in UTF-16 code units fails: it is 4096 Unicode scalar values", async () => {
    const mistaken = REFERENCE.replace("if (scalars > 4096) fail();", "if (row.note.length > 4096) fail();");
    expect(mistaken).not.toBe(REFERENCE);
    expect(await score(mistaken, SEEDS[0]!)).toBe("FAIL");
  });
});
