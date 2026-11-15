import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HandlerContext, handleRequest } from "../../runner/handlers";

test("a guarded project turn refuses absent or failing native proof before invoking a brain", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-wire-")));
  let invoked = 0;
  const agent = { id: randomUUID(), handle: "worker" };
  const runId = randomUUID();
  const scope = { signal: new AbortController().signal, output: () => {} };
  const ctx = {
    workspaceReal: root,
    exec: true,
    token: "test",
    brains: {
      turn: async () => {
        invoked++;
        return { type: "done", text: "ok" };
      },
    },
  } as unknown as HandlerContext;
  const req = {
    op: "paperclip.brain.turn",
    kind: "claude_code",
    agent,
    runId,
    session: { id: randomUUID(), resume: false },
    cwd: "/target",
    system: "",
    prompt: "",
    mcp: { token: "test" },
    paperclipProof: { nonce: "bad", agentId: agent.id, runId },
  } as any;
  try {
    await expect(handleRequest(ctx, req, scope)).rejects.toThrow();
    expect(invoked).toBe(0);
    const withGate = {
      ...ctx,
      paperclip: {
        probe: () => ({ version: 1, connectionId: randomUUID() }),
        attest: () => {
          throw Error("denied");
        },
        consume: () => {
          throw Error("denied");
        },
      },
    } as unknown as HandlerContext;
    await expect(handleRequest(withGate, req, scope)).rejects.toThrow();
    expect(invoked).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the special project turn validates proof and reaches the native brain exactly once", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-wire-")));
  let invoked = 0,
    verified = 0,
    rechecked = 0,
    finished = 0;
  const agent = { id: randomUUID(), handle: "worker" };
  const runId = randomUUID();
  const scope = { signal: new AbortController().signal, output: () => {} };
  const ctx = {
    workspaceReal: root,
    exec: true,
    token: "test",
    brains: {
      turn: async (_req: any, context: any) => {
        await context.beforeLaunch("/target");
        invoked++;
        return { type: "done", text: "ok" };
      },
    },
    paperclip: {
      probe: () => ({ version: 1, connectionId: randomUUID() }),
      attest: () => ({}),
      consume: () => {
        verified++;
        return true;
      },
      recheck: async (_req: any, cwd: string) => {
        expect(cwd).toBe("/target");
        rechecked++;
      },
      finish: () => {
        finished++;
      },
    },
  } as unknown as HandlerContext;
  const req = {
    op: "paperclip.brain.turn",
    kind: "claude_code",
    agent,
    runId,
    session: { id: randomUUID(), resume: false },
    cwd: "/target",
    system: "",
    prompt: "",
    mcp: { token: "test" },
    paperclipProof: { nonce: "test", agentId: agent.id, runId },
  } as any;
  try {
    await handleRequest(ctx, req, scope);
    expect(verified).toBe(1);
    expect(rechecked).toBe(1);
    expect(finished).toBe(1);
    expect(invoked).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
