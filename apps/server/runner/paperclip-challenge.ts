/** Connection-bound, one-use authority for owner-registered workspace launches (ADR 0181). */
import { createHash } from "node:crypto";

type Paired = { orgId: string; machineId: string; ownerId: string; connectionId: string };
type Request = Paired & {
  bindingId: string;
  agentId: string;
  generation: string;
  runId: string;
  nonce: string;
  expiresAt: number;
};
type RecordValue = { id: string; version: number; target: { real: string }; [k: string]: unknown };
type Options = {
  paired: Paired;
  read: (id: string) => RecordValue;
  verify: (binding: RecordValue, expected: Request) => true;
  now: () => number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (): never => {
  throw new Error("workspace attestation refused");
};
const keys = [
  "agentId",
  "bindingId",
  "connectionId",
  "expiresAt",
  "generation",
  "machineId",
  "nonce",
  "orgId",
  "ownerId",
  "runId",
]
  .sort()
  .join(",");
function valid(req: Request, o: Options) {
  const now = o.now();
  if (!req || typeof req !== "object" || Object.keys(req).sort().join(",") !== keys) return fail();
  if (
    ![req.bindingId, req.orgId, req.machineId, req.agentId, req.generation, req.runId, req.connectionId].every(
      (x) => typeof x === "string" && uuid.test(x),
    )
  )
    return fail();
  if (
    typeof req.ownerId !== "string" ||
    !req.ownerId ||
    req.ownerId.length > 256 ||
    [...req.ownerId].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail();
  if (
    req.orgId !== o.paired.orgId ||
    req.machineId !== o.paired.machineId ||
    req.ownerId !== o.paired.ownerId ||
    req.connectionId !== o.paired.connectionId
  )
    return fail();
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(req.nonce) ||
    !Number.isSafeInteger(req.expiresAt) ||
    req.expiresAt <= now ||
    req.expiresAt > now + 30000
  )
    return fail();
}
export function createChallengeGate(o: Options) {
  type Ticket = { request: Request; digest: string; cwd: string };
  const used = new Map<string, number>(),
    tickets = new Map<string, Ticket>(),
    active = new Map<string, Ticket>();
  const clean = () => {
    for (const [k, v] of used) if (v <= o.now()) used.delete(k);
    for (const table of [tickets, active])
      for (const [k, v] of table) if (v.request.expiresAt <= o.now()) table.delete(k);
  };
  const read = (req: Request) => {
    const b = o.read(req.bindingId);
    if (!b || b.id !== req.bindingId || b.version !== 1 || typeof b.target?.real !== "string") return fail();
    o.verify(b, req);
    return b;
  };
  return {
    attest(req: Request) {
      valid(req, o);
      clean();
      if (used.has(req.nonce) || used.size >= 1024 || tickets.size >= 128) return fail();
      used.set(req.nonce, req.expiresAt);
      const b = read(req),
        digest = createHash("sha256").update(JSON.stringify(b)).digest("hex");
      tickets.set(req.nonce, { request: { ...req }, digest, cwd: b.target.real });
      return {
        bindingId: req.bindingId,
        nonce: req.nonce,
        runId: req.runId,
        generation: req.generation,
        targetCwd: b.target.real,
        bindingDigest: digest,
        sourceCompanyId: b.sourceCompanyId as string,
        sourceProjectId: b.sourceProjectId as string,
        sourceWorkspaceId: b.sourceWorkspaceId as string,
        projectDigest: b.projectDigest as string,
        snapshotDigest: b.snapshotDigest as string,
        agentIds: b.agentIds as string[],
      };
    },
    consume(input: Request & { cwd: string }) {
      const { cwd, ...req } = input;
      valid(req, o);
      clean();
      const ticket = tickets.get(req.nonce);
      if (
        !ticket ||
        keys.split(",").some((k) => ticket.request[k as keyof Request] !== req[k as keyof Request]) ||
        ticket.cwd !== cwd
      )
        return fail();
      // Invalidate before rechecking: an unknown result cannot be replayed as new authority.
      tickets.delete(req.nonce);
      const b = read(req);
      if (createHash("sha256").update(JSON.stringify(b)).digest("hex") !== ticket.digest || b.target.real !== cwd)
        return fail();
      active.set(req.nonce, ticket);
      return true as const;
    },
    recheck(input: Request & { cwd: string }) {
      const { cwd, ...req } = input;
      valid(req, o);
      clean();
      const ticket = active.get(req.nonce);
      if (
        !ticket ||
        keys.split(",").some((k) => ticket.request[k as keyof Request] !== req[k as keyof Request]) ||
        ticket.cwd !== cwd
      )
        return fail();
      const b = read(req);
      if (createHash("sha256").update(JSON.stringify(b)).digest("hex") !== ticket.digest || b.target.real !== cwd)
        return fail();
      return true as const;
    },
    finish(nonce: string) {
      active.delete(nonce);
    },
    clear() {
      tickets.clear();
      active.clear();
    },
  };
}
