import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createArtifactToolSource } from "../src/artifact-tools";
import { FILES_GUIDANCE } from "../src/capabilities";
import { createIssue, updateIssue } from "../src/issues";
import { postPersonMessage } from "../src/messages";
import type { OutboxJob } from "../src/outbox";
import { cleanRunPath, kindOfPath, RETENTION_REPORT_JOB, registerRunFiles, retentionDecision } from "../src/run-files";
import { toolKind } from "../src/tools/run-policy";
import type { ToolContext } from "../src/tools/types";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close?.();
  f = undefined;
});

const person = (userId: string) => ({ type: "person" as const, userId });

async function runOn(fx: Fixture, issueId: string | null) {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      issueId,
    })
    .returning();
  return run!;
}

describe("what stays and what could go", () => {
  test("a file's kind comes from its path", () => {
    expect(kindOfPath("shots/home.png")).toBe("image");
    expect(kindOfPath("demo.mp4")).toBe("video");
    expect(kindOfPath("report.html")).toBe("html");
    expect(kindOfPath("NOTES.md")).toBe("markdown");
    expect(kindOfPath("run.log")).toBe("log");
    expect(kindOfPath("app/.next/server/page.js")).toBe("build");
    expect(kindOfPath("data.bin")).toBe("other");
  });

  test("only workspace-relative paths are taken", () => {
    expect(cleanRunPath("./out/a.png")).toBe("out/a.png");
    for (const bad of ["/etc/passwd", "~/x", "../up.txt", "a/../../b", "C:\\x", ""])
      expect(() => cleanRunPath(bad)).toThrow();
  });

  test("deliverables, evidence, unknowns, Drive files and dependencies stay; scratch and rebuildable output are candidates", () => {
    const at = (role: string, path = "x.png", where: "drive" | "computer" = "computer") =>
      retentionDecision({ where, path, role, kind: kindOfPath(path) }).decision;
    expect(at("canonical")).toBe("keep");
    expect(at("evidence")).toBe("keep");
    expect(at("unknown")).toBe("keep");
    expect(at("whatever")).toBe("keep");
    expect(at("scratch", "x.png", "drive")).toBe("keep");
    expect(at("scratch", "node_modules/left-pad/index.js")).toBe("keep");
    expect(at("scratch")).toBe("candidate");
    expect(at("derived", "dist/app.js")).toBe("candidate");
    expect(retentionDecision({ where: "computer", path: "dist/a.js", role: "derived", kind: "build" }).why).toMatch(
      /free space before and after/,
    );
  });
});

describe("register_files and the report", () => {
  test("the tool is the agent's own bookkeeping, for every agent, and agents with a computer are told about it", async () => {
    f = await setup({ artifactTools: true });
    const tool = (await createArtifactToolSource(f.artifactDeps).tools({} as ToolContext)).find((t) => t.name === "register_files");
    expect(tool?.scope).toBe("");
    // Offered only where the agent may also run commands on a computer: a chat-only agent never sees it.
    expect(tool?.needs).toEqual({ name: "run_code", scope: "sandbox:run" });
    expect(toolKind(tool!)).toEqual({ kind: "self" });
    expect(FILES_GUIDANCE).toContain("register_files");
    expect(FILES_GUIDANCE.length).toBeLessThan(500);
  });

  test("registering twice updates the row; a bad path registers nothing", async () => {
    f = await setup();
    const run = await runOn(f, null);
    const who = { orgId: f.org.id, agentId: f.agent.id, runId: run.id };
    await registerRunFiles(f.db, who, [{ path: "tmp/a.png", role: "scratch" }]);
    await registerRunFiles(f.db, who, [{ path: "tmp/a.png", role: "evidence", size: 10 }]);
    const rows = await f.db.select().from(schema.runFiles).where(eq(schema.runFiles.runId, run.id));
    expect(rows.map((r) => [r.path, r.role, r.kind, r.size])).toEqual([["tmp/a.png", "evidence", "image", 10]]);
    await expect(
      registerRunFiles(f.db, who, [
        { path: "ok.md", role: "scratch" },
        { path: "/abs.md", role: "scratch" },
      ]),
    ).rejects.toThrow();
    expect(await f.db.select().from(schema.runFiles).where(eq(schema.runFiles.path, "ok.md"))).toEqual([]);
  });

  test("a task that ends queues one dry-run report: kept and candidate files with reasons, nothing deleted", async () => {
    f = await setup();
    const fx = f;
    const deps = { db: fx.db, pubsub: fx.pubsub };
    const issue = await createIssue(deps, person(fx.owner.id), fx.org.id, { title: "Página nova" });
    const run = await runOn(fx, issue.id);
    await registerRunFiles(fx.db, { orgId: fx.org.id, agentId: fx.agent.id, runId: run.id }, [
      { path: "site/index.html", role: "canonical" },
      { path: "evidence/after.png", role: "evidence" },
      { path: "scratch/frame-001.png", role: "scratch", size: 2048 },
      { path: "site/dist/app.js", role: "derived", size: 4096 },
      { path: "notes.txt", role: "unknown" },
    ]);
    const jobs = () => fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, RETENTION_REPORT_JOB));
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "in_progress" });
    expect(await jobs()).toEqual([]);
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "done" });
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    await fx.handlers[RETENTION_REPORT_JOB]?.(queued[0] as OutboxJob, {} as never);
    const [row] = await fx.db
      .select()
      .from(schema.retentionReports)
      .where(and(eq(schema.retentionReports.subjectType, "issue"), eq(schema.retentionReports.subjectId, issue.id)));
    const report = row!.report as {
      dryRun: boolean;
      kept: number;
      candidates: number;
      candidateBytes: number;
      items: { path: string; decision: string; why: string }[];
    };
    expect(row!.outcome).toBe("done");
    expect(report.dryRun).toBe(true);
    expect(report.kept).toBe(3);
    expect(report.candidates).toBe(2);
    expect(report.candidateBytes).toBe(6144);
    expect(
      report.items
        .filter((i) => i.decision === "candidate")
        .map((i) => i.path)
        .sort(),
    ).toEqual(["scratch/frame-001.png", "site/dist/app.js"]);
    expect(report.items.every((i) => i.why.length > 0)).toBe(true);
    // The registered rows are still there: a report never deletes.
    expect(await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.runId, run.id))).toHaveLength(5);
    // Running the job again rewrites the same row.
    await fx.handlers[RETENTION_REPORT_JOB]?.(queued[0] as OutboxJob, {} as never);
    expect(await fx.db.select().from(schema.retentionReports)).toHaveLength(1);
  });
});
