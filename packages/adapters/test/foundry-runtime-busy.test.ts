import { expect, test } from "bun:test";
import type { FoundryFrozenVersion } from "../src/foundry-executor";
import { createRemoteFoundryExecutor } from "../src/foundry-remote-executor";
import { createFoundryRpcClient, createFoundryRpcHandler, FoundryRuntimeBusyError } from "../src/foundry-rpc";
import { createFoundryAdmission } from "../src/foundry-runtime-service";

const token = "b".repeat(64);
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

function through(methods: Parameters<typeof createFoundryRpcHandler>[0]["methods"]) {
  const handle = createFoundryRpcHandler({ token, methods });
  return ((input: string | URL | Request, init?: RequestInit) =>
    handle(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;
}

test("a busy runtime answers 429 and the client sees a busy error, not an unknown outcome", async () => {
  const fetch = through({
    execute: async () => {
      throw new FoundryRuntimeBusyError();
    },
    other: async () => {
      throw new Error("secret detail");
    },
  });
  const call = createFoundryRpcClient({ url: "http://localhost/internal/foundry/", token, fetch });
  await expect(call("execute", {})).rejects.toBeInstanceOf(FoundryRuntimeBusyError);
  const other = await call("other", {}).catch((e: unknown) => e);
  expect(other).not.toBeInstanceOf(FoundryRuntimeBusyError);
});

test("the remote executor passes a busy refusal on and never cancels or tombstones the job", async () => {
  const seen: string[] = [];
  const busy = async () => {
    throw new FoundryRuntimeBusyError();
  };
  const record = (name: string) => async () => {
    seen.push(name);
    return null;
  };
  const { executor } = createRemoteFoundryExecutor({
    url: "http://localhost/internal/foundry/",
    token,
    fetch: through({
      evaluate: busy,
      execute: busy,
      cancelEvaluation: record("cancelEvaluation"),
      cancel: record("cancel"),
    }),
  });
  await expect(executor.evaluate({ orgId: ORG_A } as FoundryFrozenVersion, "job-1")).rejects.toMatchObject({
    code: "RUNTIME_BUSY",
  });
  await expect(
    executor.execute({
      orgId: ORG_A,
      digest: "c".repeat(64),
      input: {},
      inputDigest: "d".repeat(64),
      invocationId: "00000000-0000-4000-8000-000000000001",
      fencingToken: 1,
      nativeDecisionRef: "x",
      budgetReservationRef: "y",
      abort: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
  expect(seen).toEqual([]);
});

test("admission keeps a slot per workspace: one org cannot take the whole pool", async () => {
  const admit = createFoundryAdmission({ limit: 2, perOrg: 1 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = admit(
    async () => held,
    (input) => input.orgId as string,
  );
  const first = slow({ orgId: ORG_A }, new AbortController().signal);
  await expect(slow({ orgId: ORG_A }, new AbortController().signal)).rejects.toBeInstanceOf(FoundryRuntimeBusyError);
  const second = slow({ orgId: ORG_B }, new AbortController().signal);
  await expect(
    slow({ orgId: "00000000-0000-4000-8000-00000000000c" }, new AbortController().signal),
  ).rejects.toBeInstanceOf(FoundryRuntimeBusyError);
  release();
  await Promise.all([first, second]);
  await expect(slow({ orgId: ORG_A }, new AbortController().signal)).resolves.toBeUndefined();
});

test("not qualified right now is a refusal before anything started: busy, never an unknown outcome", async () => {
  const { FoundryExecutorError } = await import("../src/foundry-executor");
  const { refusedBeforeStart } = await import("../src/foundry-runtime-service");
  const notQualified = refusedBeforeStart(async () => {
    throw new FoundryExecutorError("BLOCKED_SANDBOX", "Current trusted runner identity is unavailable.");
  });
  await expect(notQualified({}, new AbortController().signal)).rejects.toBeInstanceOf(FoundryRuntimeBusyError);
  // Anything after the start stays what it was: the caller reconciles it.
  const started = refusedBeforeStart(async () => {
    throw new FoundryExecutorError("UNKNOWN_OUTCOME", "Evaluation outcome requires reconciliation.");
  });
  await expect(started({}, new AbortController().signal)).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
  const fine = refusedBeforeStart(async () => "ok");
  expect(await fine({}, new AbortController().signal)).toBe("ok");
});
