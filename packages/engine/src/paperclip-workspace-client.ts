/** Non-retryable, connection-bound project turn transport (ADR 0181). */

import { randomBytes } from "node:crypto";
import type { AgentScope, BrainTurnRequest, PaperclipWorkspaceProof } from "@agenteschat/adapters/machine-protocol";
import { PAPERCLIP_WORKSPACE_PROTOCOL } from "@agenteschat/adapters/machine-protocol";
import type { MachineCaller } from "./machine-hub";

type Input = {
  orgId: string;
  machineId: string;
  ownerId: string;
  agent: AgentScope;
  bindingId: string;
  generation: string;
  targetCwd: string;
  bindingDigest: string;
  turn: BrainTurnRequest;
};
// The caller must check the owner session, current mapping/agent settings and DB authorization on every invocation.
// The authoritative runtime resolves every input from persisted receipt/run links.
type Deps = {
  hub: Pick<MachineCaller, "call" | "status">;
  assertAuthorized: (input: Input) => Promise<boolean>;
  signal?: AbortSignal;
  now?: () => number;
};
const fail = (): never => {
  throw new Error("owner-registered project unavailable");
};
export async function runOwnerBoundProjectTurn(deps: Deps, input: Input) {
  const turn = input.turn;
  if (
    !input.agent?.id ||
    turn.cwd !== input.targetCwd ||
    !input.targetCwd.startsWith("/") ||
    input.targetCwd.includes("\0") ||
    !/^[a-f0-9]{64}$/.test(input.bindingDigest) ||
    !["codex", "claude_code"].includes(turn.kind) ||
    turn.keepAlive !== false ||
    turn.session.resume !== false ||
    turn.permissions?.mode === "chat"
  )
    return fail();
  const allowed = async () => {
    const status = await deps.hub.status(input.machineId);
    return Boolean(
      status &&
        status.orgId === input.orgId &&
        status.pairedByUserId === input.ownerId &&
        status.os === "darwin" &&
        status.protocol >= PAPERCLIP_WORKSPACE_PROTOCOL &&
        status.online &&
        !status.paused &&
        status.execAllowed &&
        (await deps.assertAuthorized(input)),
    );
  };
  if (!(await allowed())) return fail();
  const probe = await deps.hub.call(
    input.machineId,
    { op: "paperclip.workspace.probe" },
    { timeoutMs: 5000, signal: deps.signal },
  );
  if (probe.version !== 1 || typeof probe.connectionId !== "string") return fail();
  const proof: PaperclipWorkspaceProof = {
    orgId: input.orgId,
    machineId: input.machineId,
    ownerId: input.ownerId,
    agentId: input.agent.id,
    bindingId: input.bindingId,
    generation: input.generation,
    runId: turn.runId,
    connectionId: probe.connectionId,
    nonce: randomBytes(32).toString("base64url"),
    expiresAt: (deps.now ?? Date.now)() + 15000,
  };
  const got = await deps.hub.call(
    input.machineId,
    { op: "paperclip.workspace.attest", agent: input.agent, proof },
    { timeoutMs: 10000, signal: deps.signal },
  );
  if (
    got.bindingId !== proof.bindingId ||
    got.nonce !== proof.nonce ||
    got.runId !== proof.runId ||
    got.generation !== proof.generation ||
    got.targetCwd !== input.targetCwd ||
    got.bindingDigest !== input.bindingDigest ||
    !(await allowed())
  )
    return fail();
  // Never retry this call on unknown delivery; the caller must reconcile the run.
  const out = await deps.hub.call(
    input.machineId,
    { ...turn, op: "paperclip.brain.turn", agent: input.agent, paperclipProof: proof },
    { signal: deps.signal },
  );
  if (out.runId !== turn.runId) return fail();
  return out;
}
