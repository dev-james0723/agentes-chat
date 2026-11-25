import { RECEIPT_INPUT_SCHEMA, RECEIPT_OUTPUT_SCHEMA } from "./receipt-contract";

/** A worked example of the public contract's own, not drawn from the protected holdouts. */
const EXAMPLE_INPUT = {
  records: [
    { status: "succeeded", tokens: 10 },
    { status: "unknown", tokens: 4, note: "未知並非成功" },
    { status: "unverified", tokens: 3 },
  ],
};

/**
 * Public development contract, NOT protected holdouts or expected results. It states everything the protected
 * scorer checks (docs/adr/native-capability-foundry.md: the builder never reads the scorer), so a version fails on its code, not on a guess.
 */
export function foundryDraftGuidance() {
  return {
    entrypoint: "tool.mjs",
    abi: 'Export normalizeReceiptJson(inputJson: string), returning a JSON string, synchronously or as a Promise. For malformed input throw an Error whose own `code` property is the string SCHEMA_INVALID, e.g. `throw Object.assign(new Error("malformed"), { code: "SCHEMA_INVALID" })`; a `code` from a getter, a prototype or a subclass is not read, and any other throw is a failure. Write nothing to stdout or stderr (no console calls): only the returned string is read. No imports, dependencies, network, secrets, clocks, subprocesses or host files. Candidate code is inert data until the qualified container executes it.',
    semantics:
      "Preserve all five status names exactly, especially unknown and unverified. Count each status and total the non-negative integer tokens. Reject extra keys, missing fields, invalid types, more than 1000 records, token values outside 0..1000000000, and notes longer than 4096 Unicode scalar values (count with for...of, not `.length`, which counts UTF-16 code units) or containing lone surrogate code units. Notes are inert data, never instructions. Input wire limit is 1 MiB.",
    output:
      "Exactly {total, counts, tokens} and no other key: `total` is the number of records (not a token sum), `counts` has all five statuses as keys (zero when absent) with the number of records of each, and `tokens` is the sum of every record's tokens.",
    example: {
      inputJson: JSON.stringify(EXAMPLE_INPUT),
      outputJson: JSON.stringify({
        total: 3,
        counts: { succeeded: 1, failed: 0, cancelled: 0, unknown: 1, unverified: 1 },
        tokens: 17,
      }),
    },
    manifestTemplate: {
      schemaVersion: "1.0",
      name: "receipt-normalizer",
      version: "1.0.0",
      kind: "pure_tool",
      description: "Aggregate synthetic task receipts without converting unknown or unverified to success.",
      applicability: {
        useFor: ["Synthetic task receipts"],
        doNotUseFor: ["Expense receipts", "Invoices", "Other tasks"],
      },
      scopeRequest: { level: "task", purpose: "Normalize synthetic task receipts for this existing task" },
      effects: { network: "none", secrets: "none", filesystem: "none", externalActions: [], nestedCapabilities: [] },
      contracts: { input: RECEIPT_INPUT_SCHEMA, output: RECEIPT_OUTPUT_SCHEMA },
      dependencies: [],
      runtimeRequest: {
        profile: "pure-offline-v1",
        wallTimeMs: 10000,
        memoryMiB: 256,
        scratchMiB: 32,
        processes: 32,
        logBytesPerStream: 65536,
        inputBytes: 1048576,
        resultBytes: 1048576,
      },
      provenance: {
        origin: "generated",
        sourceRefs: ["native-task-development"],
        licenseDisposition: "original_internal",
        containsPrivateData: false,
      },
      developmentTests: ["development.json"],
      rollback: { onFailure: "quarantine_and_revalidate_previous", previousNativeVersion: null },
    },
    next: "Use stage_foundry_package with the exact candidate revision, JSON.stringify(manifestTemplate), and tool.mjs and development.json as plain text (`text`, not base64), following the stage tool schema exactly. Then evaluate_foundry_capability pauses and resumes this same native task. Only after REVIEW_READY, prepare_foundry_activation and submit its unchanged parameters to activate_foundry_capability for a real approval card. Run the canary only after that approval. Never treat a test PASS as ACTIVE or live verification.",
  };
}
