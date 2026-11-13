/** Single-user, owner-registered prototype. A remote request can name a binding, never a source path. */
import { randomUUID } from "node:crypto";
import type { MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import { checkFolder, foldersFor } from "./access";
import { createChallengeGate } from "./paperclip-challenge";
import { type Binding, verifyBinding } from "./paperclip-identity";
import { readOwnerBinding } from "./paperclip-registry";
import { isInside } from "./paths";

type Opts = { runnerHome: string; workspaceReal: string; orgId: string; machineId: string; access: () => RunnerAccess };
export function createPaperclipGateway(opts: Opts) {
  let connectionId = randomUUID();
  const gates = new Map<string, ReturnType<typeof createChallengeGate>>();
  const gateFor = (ownerId: string) => {
    const prior = gates.get(ownerId);
    if (prior) return prior;
    if (gates.size >= 32) throw new Error("project proof unavailable");
    const gate = createChallengeGate({
      paired: { orgId: opts.orgId, machineId: opts.machineId, ownerId, connectionId },
      now: () => Date.now(),
      read: (id) => readOwnerBinding(opts.runnerHome, id) as any,
      verify: (data, req) => {
        const b = data as unknown as Binding;
        const access = opts.access();
        if (access.tools.commands !== true) throw new Error("project commands unavailable");
        const roots = foldersFor(access, req.agentId).map((root) => checkFolder(root, { runnerHome: opts.runnerHome }));
        if (
          !b.source?.real ||
          isInside(opts.workspaceReal, b.source.real) ||
          isInside(b.source.real, opts.workspaceReal) ||
          roots.some((root) => isInside(root, b.source.real) || isInside(b.source.real, root))
        )
          throw new Error("source workspace is granted");
        return verifyBinding(
          b,
          req,
          (agent, target) => agent === req.agentId && roots.some((root) => isInside(root, target)),
        );
      },
    });
    gates.set(ownerId, gate);
    return gate;
  };
  return {
    reset() {
      for (const gate of gates.values()) gate.clear();
      gates.clear();
      connectionId = randomUUID();
    },
    probe() {
      return { version: 1 as const, connectionId };
    },
    async attest(req: Extract<MachineRequest, { op: "paperclip.workspace.attest" }>) {
      if (!req.agent || req.agent.id !== req.proof.agentId) throw new Error("agent mismatch");
      return gateFor(req.proof.ownerId).attest(req.proof);
    },
    async consume(req: Extract<MachineRequest, { op: "paperclip.brain.turn" }>) {
      const proof = req.paperclipProof;
      if (
        !req.agent ||
        req.agent.id !== proof.agentId ||
        req.runId !== proof.runId ||
        req.keepAlive !== false ||
        req.session.resume !== false
      )
        throw new Error("project turn unsupported");
      const gate = gates.get(proof.ownerId);
      if (!gate) throw new Error("project proof unavailable");
      gate.consume({ ...proof, cwd: req.cwd });
    },
    async recheck(req: Extract<MachineRequest, { op: "paperclip.brain.turn" }>, cwd: string) {
      const gate = gates.get(req.paperclipProof.ownerId);
      if (!gate) throw new Error("project proof unavailable");
      gate.recheck({ ...req.paperclipProof, cwd });
    },
    finish(req: Extract<MachineRequest, { op: "paperclip.brain.turn" }>) {
      gates.get(req.paperclipProof.ownerId)?.finish(req.paperclipProof.nonce);
    },
  };
}
