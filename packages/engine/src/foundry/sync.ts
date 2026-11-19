import {
  FOUNDRY_VERSION_FILE,
  type FoundryCapabilityExport,
  type FoundryCapabilitySyncPort,
} from "@agenteschat/adapters";
import { and, desc, eq, isNull, schema } from "@agenteschat/db";
import { openPersonAgentDm } from "../dms";
import { insertMessage } from "../messages";
import { enqueue, PermanentJobError } from "../outbox";
import { type FoundryDependencies, loadFoundryBundle } from "./service";

/** SF-19: an ACTIVE version is saved to the skills repository and its approver is told by the creating agent. */
export const FOUNDRY_SYNC_JOB = "foundry.sync";

const { foundryVersions: versions, foundryCandidates: candidates, foundryBindings: bindings } = schema;
type Terminal = "SYNCED" | "REFUSED" | "FAILED";
const UNCONFIGURED = "No skills repository is connected to this server.";

const toBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

export function createFoundryCapabilitySync(
  deps: FoundryDependencies & { capabilitySync?: FoundryCapabilitySyncPort; now?: () => Date },
) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(orgId: string, versionId: string) {
    const [row] = await db
      .select({ version: versions, candidate: candidates, agent: schema.agents })
      .from(versions)
      .innerJoin(candidates, and(eq(candidates.id, versions.candidateId), eq(candidates.orgId, versions.orgId)))
      .innerJoin(schema.agents, eq(schema.agents.id, candidates.agentId))
      .where(and(eq(versions.orgId, orgId), eq(versions.id, versionId)));
    return row ?? null;
  }

  /** What the repository and the report say about this version: all of it from the frozen manifest. */
  async function exported(row: NonNullable<Awaited<ReturnType<typeof load>>>): Promise<FoundryCapabilityExport> {
    const bundle = await loadFoundryBundle(deps, row.version);
    const m = bundle.manifest;
    const files = bundle.files.map((file) => ({ path: file.path, base64: file.base64 }));
    const hasSkill = files.some((file) => file.path === "SKILL.md");
    const marker = {
      digest: row.version.digest,
      name: m.name,
      version: m.version,
      kind: m.kind,
      versionId: row.version.id,
      candidateId: row.candidate.id,
    };
    return {
      digest: row.version.digest,
      name: m.name,
      kind: m.kind === "instruction_skill" && hasSkill ? "skill" : "tool",
      agent: oneLine(row.agent.role ? `${row.agent.name} | ${row.agent.role}` : row.agent.name, 200),
      why: oneLine(m.scopeRequest.purpose, 500),
      use: oneLine(m.applicability.useFor.join("; "), 1000),
      files: [
        ...files.filter((file) => file.path !== "manifest.json" && file.path !== FOUNDRY_VERSION_FILE),
        { path: "manifest.json", base64: toBase64(`${bundle.manifestJson}\n`) },
        { path: FOUNDRY_VERSION_FILE, base64: toBase64(`${JSON.stringify(marker, null, 2)}\n`) },
      ],
    };
  }

  async function settle(versionId: string, state: Terminal | "UNKNOWN", detail: { commit?: string; reason?: string }) {
    await db
      .update(versions)
      .set({ syncState: state, syncCommit: detail.commit ?? null, syncReason: detail.reason ?? null })
      .where(and(eq(versions.id, versionId), isNull(versions.syncReportedAt)));
  }

  /** Once: claims the report and posts it in the same transaction, so a retry never sends a second one. */
  async function report(orgId: string, versionId: string, capability: FoundryCapabilityExport, url: string | null) {
    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(versions)
        .set({ syncReportedAt: now() })
        .where(and(eq(versions.orgId, orgId), eq(versions.id, versionId), isNull(versions.syncReportedAt)))
        .returning();
      if (!claimed) return;
      const [row] = await tx
        .select({ candidate: candidates, decidedBy: schema.approvals.decidedByUserId })
        .from(bindings)
        .innerJoin(candidates, eq(candidates.id, bindings.candidateId))
        .leftJoin(schema.approvals, eq(schema.approvals.id, bindings.approvalId))
        .where(and(eq(bindings.orgId, orgId), eq(bindings.versionId, versionId)))
        .orderBy(desc(bindings.createdAt))
        .limit(1);
      if (!row) throw new PermanentJobError("No binding for this capability version");
      const to = row.decidedBy ?? row.candidate.personId;
      const dm = await openPersonAgentDm(tx, orgId, to, row.candidate.agentId);
      const path = `${capability.kind === "skill" ? "skills" : "tools"}/${capability.name}`;
      const where =
        claimed.syncState === "SYNCED" && claimed.syncCommit
          ? `In the skills repository: ${url ? `${url}/tree/main/${path}` : path} (commit ${claimed.syncCommit.slice(0, 12)})`
          : claimed.syncState === "REFUSED"
            ? `Not saved to the skills repository: ${claimed.syncReason}. It is still active and in use.`
            : `Could not save it to the skills repository: ${claimed.syncReason}. It is still active and in use.`;
      const message = await insertMessage(tx, {
        orgId,
        channelId: dm.id,
        threadId: null,
        author: { type: "agent", agentId: row.candidate.agentId, runId: null, hop: 0, stretchId: null },
        body: [
          `New ${capability.kind} ready: ${capability.name}`,
          `Made by: ${capability.agent}`,
          `Why: ${capability.why}`,
          `How it will be used from now on: ${capability.use}`,
          where,
        ].join("\n"),
        meta: {
          agentDm: { fromChannelId: null, fromMessageId: null, fromThreadId: null },
          foundrySync: { versionId, state: claimed.syncState },
        },
      });
      await enqueue(tx, {
        orgId,
        kind: "notifications.message",
        payload: { messageId: message.id },
        dedupeKey: `notifications.message:${message.id}`,
        maxAttempts: 4,
      });
    });
  }

  return {
    /** Native outbox handler. A throw retries; the remote is always read before any second sync. */
    async run(orgId: string, payload: Record<string, unknown>, options: { finalAttempt: boolean }) {
      const versionId = payload.versionId;
      if (typeof versionId !== "string" || !/^[0-9a-f-]{36}$/i.test(versionId))
        throw new PermanentJobError("Invalid capability version reference");
      const row = await load(orgId, versionId);
      if (!row) throw new PermanentJobError("Capability version not found");
      if (row.version.syncReportedAt) return;
      let capability: FoundryCapabilityExport;
      try {
        capability = await exported(row);
      } catch (error) {
        if (!options.finalAttempt) throw error;
        // Its stored files can't be read any more: still tell the approver, never drop it silently.
        await settle(versionId, "FAILED", { reason: "its stored files could not be read" });
        const name = row.candidate.needKey.replace(/[^a-z0-9-]+/gi, "-").slice(0, 64) || "capability";
        const agent = row.agent.role ? `${row.agent.name} | ${row.agent.role}` : row.agent.name;
        capability = { digest: row.version.digest, name, kind: "tool", agent, why: "-", use: "-", files: [] };
        await report(orgId, versionId, capability, null);
        return;
      }
      let url: string | null = null;
      const state = row.version.syncState;
      if (state !== "SYNCED" && state !== "REFUSED" && state !== "FAILED") {
        const port = deps.capabilitySync;
        if (!port) await settle(versionId, "FAILED", { reason: UNCONFIGURED });
        else {
          try {
            const found = await port.lookup(capability);
            const result = found ? ({ state: "SYNCED", ...found } as const) : await port.sync(capability);
            if (result.state === "SYNCED") {
              url = result.url;
              await settle(versionId, "SYNCED", { commit: result.commit });
            } else await settle(versionId, "REFUSED", { reason: oneLine(result.reason, 500) });
          } catch (error) {
            if (!options.finalAttempt) {
              await settle(versionId, "UNKNOWN", {});
              throw error;
            }
            await settle(versionId, "FAILED", { reason: "the push did not finish and was not found on GitHub" });
          }
        }
      } else if (state === "SYNCED" && deps.capabilitySync) {
        url = (await deps.capabilitySync.lookup(capability).catch(() => null))?.url ?? null;
      }
      await report(orgId, versionId, capability, url);
    },
  };
}
