import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { grantScopes, updateSandboxSettings } from "../src";
import { FILES_GUIDANCE } from "../src/capabilities";
import { createIssue, updateIssue } from "../src/issues";
import { postPersonMessage } from "../src/messages";
import type { OutboxJob } from "../src/outbox";
import {
  cleanRunPath,
  kindOfPath,
  RETENTION_REPORT_JOB,
  registerFilesTool,
  registerRunFiles,
  retentionDecision,
  writeRetentionReport,
} from "../src/run-files";
import { toolKind } from "../src/tools/run-policy";
import type { ToolContext } from "../src/tools/types";
import { type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close?.();
  f = undefined;
});

const person = (userId: string) => ({ type: "person" as const, userId });

async function runOn(fx: Fixture, values: { issueId?: string | null; threadRootId?: string; channelId?: string } = {}) {
  const channelId = values.channelId ?? fx.general.id;
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, channelId, {
    body: "x",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId,
      threadRootId: values.threadRootId ?? msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      issueId: values.issueId ?? null,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const ctxOf = (fx: Fixture, run: { id: string; channelId: string; threadRootId: string; triggerMessageId: string }) =>
  ({
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  }) as ToolContext;

type Report = {
  dryRun: boolean;
  outcome: string;
  kept: number;
  candidates: number;
  candidateBytes: number;
  items: { where: string; path: string; decision: string; why: string }[];
};

const reportOf = async (fx: Fixture, type: "issue" | "mission", id: string) => {
  const [row] = await fx.db
    .select()
    .from(schema.retentionReports)
    .where(
      and(
        eq(schema.retentionReports.orgId, fx.org.id),
        eq(schema.retentionReports.subjectType, type),
        eq(schema.retentionReports.subjectId, id),
      ),
    );
  return row ? { ...(row.report as Report), outcome: row.outcome } : null;
};

describe("what stays and what could go", () => {
  test("a file's kind comes from its path", () => {
    expect(kindOfPath("shots/home.png")).toBe("image");
    expect(kindOfPath("demo.mp4")).toBe("video");
    expect(kindOfPath("report.html")).toBe("html");
    expect(kindOfPath("NOTES.md")).toBe("markdown");
    expect(kindOfPath("run.log")).toBe("log");
    expect(kindOfPath("app/.next/server/page.js")).toBe("build");
    expect(kindOfPath("ios/DerivedData/x.o")).toBe("build");
    expect(kindOfPath("data.bin")).toBe("other");
  });

  test("one workspace-relative file, in one spelling; anything else is refused", () => {
    expect(cleanRunPath("./out/a.png")).toBe("out/a.png");
    expect(cleanRunPath("a/./b")).toBe("a/b");
    expect(cleanRunPath("a//b")).toBe("a/b");
    expect(cleanRunPath("a\\b.txt")).toBe("a/b.txt");
    for (const bad of [
      "",
      ".",
      "./",
      "scratch/",
      "/etc/passwd",
      "~/x",
      "../up.txt",
      "a/../../b",
      "a\\..\\b",
      "C:\\x",
      "C:foo",
      "\\\\server\\share\\x",
      "\\Windows\\x",
      "$HOME/x",
      "line\nbreak",
    ])
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
    expect(at("scratch", "Node_Modules/x.js")).toBe("keep");
    expect(at("scratch", cleanRunPath("node_modules\\pkg\\a.js"))).toBe("keep");
    expect(at("scratch")).toBe("candidate");
    expect(at("derived", "dist/app.js")).toBe("candidate");
    expect(retentionDecision({ where: "computer", path: "dist/a.js", role: "derived", kind: "build" }).why).toMatch(
      /free space before and after/,
    );
  });
});

describe("register_files", () => {
  test("the agent's own bookkeeping, and agents with a computer are told about it in one short line", async () => {
    f = await setup();
    const tool = registerFilesTool(f.db);
    expect(tool.scope).toBe("sandbox:run");
    expect(toolKind(tool)).toEqual({ kind: "self" });
    expect(FILES_GUIDANCE).toContain("register_files");
    expect(FILES_GUIDANCE.length).toBeLessThan(500);
  });

  test("offered only with a computer: not without one, nor when the workspace turned computers off", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const fx = f;
    const ctx = ctxOf(fx, await runOn(fx));
    const listed = async () => ((await fx.tools?.list(ctx)) ?? []).map((t) => t.name);
    await grantScopes(fx.db, fx.org.id, fx.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
    expect(await listed()).not.toContain("register_files");
    await connectedComputer(fx);
    expect(await listed()).toContain("register_files");
    await updateSandboxSettings(fx.db, fx.owner.id, fx.org.id, { enabled: false });
    expect(await listed()).not.toContain("register_files");
  });

  test("registering twice updates the row; one bad path registers nothing; big files fit", async () => {
    f = await setup();
    const run = await runOn(f);
    const who = { orgId: f.org.id, agentId: f.agent.id, runId: run.id };
    await registerRunFiles(f.db, who, [{ path: "tmp/a.png", role: "scratch" }]);
    await registerRunFiles(f.db, who, [{ path: "tmp//./a.png", role: "evidence", size: 5 * 1024 ** 3 }]);
    const rows = await f.db.select().from(schema.runFiles).where(eq(schema.runFiles.runId, run.id));
    expect(rows.map((r) => [r.path, r.role, r.kind, r.size])).toEqual([
      ["tmp/a.png", "evidence", "image", 5 * 1024 ** 3],
    ]);
    await expect(
      registerRunFiles(f.db, who, [
        { path: "ok.md", role: "scratch" },
        { path: "/abs.md", role: "scratch" },
      ]),
    ).rejects.toThrow();
    expect(await f.db.select().from(schema.runFiles).where(eq(schema.runFiles.path, "ok.md"))).toEqual([]);
    // A call with no run of its own (a mission task's bridge) registers nothing.
    const out = await registerFilesTool(f.db).execute(
      { files: [{ path: "a.md", role: "scratch" }] },
      {
        ...ctxOf(f, run),
        runId: "",
      },
    );
    expect(out.isError).toBe(true);
  });
});

describe("the report", () => {
  test("a task that ends queues one dry-run report with reasons, and nothing is deleted", async () => {
    f = await setup();
    const fx = f;
    const deps = { db: fx.db, pubsub: fx.pubsub };
    const issue = await createIssue(deps, person(fx.owner.id), fx.org.id, { title: "Página nova" });
    const run = await runOn(fx, { issueId: issue.id });
    await registerRunFiles(fx.db, { orgId: fx.org.id, agentId: fx.agent.id, runId: run.id }, [
      { path: "site/index.html", role: "canonical" },
      { path: "evidence/after.png", role: "evidence" },
      { path: "scratch/frame-001.png", role: "scratch", size: 2048 },
      { path: "site/dist/app.js", role: "derived", size: 4096 },
      { path: "notes.txt", role: "unknown" },
      // Registered as one file, yet it holds others: a folder after all, so it stays.
      { path: "scratch", role: "scratch", size: 1 },
    ]);
    const jobs = () => fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, RETENTION_REPORT_JOB));
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "in_progress" });
    expect(await jobs()).toEqual([]);
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "done" });
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    await fx.handlers[RETENTION_REPORT_JOB]?.(queued[0] as OutboxJob, {} as never);
    const report = await reportOf(fx, "issue", issue.id);
    expect(report?.outcome).toBe("done");
    expect(report?.dryRun).toBe(true);
    expect(report?.kept).toBe(4);
    expect(report?.candidates).toBe(2);
    expect(report?.candidateBytes).toBe(6144);
    expect(
      report?.items
        .filter((i) => i.decision === "candidate")
        .map((i) => i.path)
        .sort(),
    ).toEqual(["scratch/frame-001.png", "site/dist/app.js"]);
    expect(report?.items.find((i) => i.path === "scratch")?.why).toMatch(/folder/);
    expect(report?.items.every((i) => i.why.length > 0)).toBe(true);
    expect(await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.runId, run.id))).toHaveLength(6);
    // The job again rewrites the same row.
    await fx.handlers[RETENTION_REPORT_JOB]?.(queued[0] as OutboxJob, {} as never);
    expect(await fx.db.select().from(schema.retentionReports)).toHaveLength(1);
    // Reopened and closed again (canceled this time): a second job, and the report says how it ends now.
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "todo" });
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "canceled" });
    const again = await jobs();
    expect(again).toHaveLength(2);
    // The older job runs last: it still writes the current outcome.
    await fx.handlers[RETENTION_REPORT_JOB]?.(again[0] as OutboxJob, {} as never);
    expect((await reportOf(fx, "issue", issue.id))?.outcome).toBe("canceled");
  });

  test("a task reopened before its job ran gets no report", async () => {
    f = await setup();
    const fx = f;
    const deps = { db: fx.db, pubsub: fx.pubsub };
    const issue = await createIssue(deps, person(fx.owner.id), fx.org.id, { title: "Volta" });
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "done" });
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "in_progress" });
    expect(await writeRetentionReport(fx.db, fx.org.id, { type: "issue", id: issue.id })).toBeNull();
    expect(await reportOf(fx, "issue", issue.id)).toBeNull();
  });

  test("a mission's report covers the agent's runs in its thread", async () => {
    f = await setup();
    const fx = f;
    const root = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "missão",
    });
    const [mission] = await fx.db
      .insert(schema.missions)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: root.id,
        title: "Site",
        goal: "Um site novo",
        mainSessionId: "s1",
        status: "done",
        createdBy: fx.owner.id,
      } as typeof schema.missions.$inferInsert)
      .returning();
    if (!mission) throw new Error("no mission");
    const inThread = await runOn(fx, { threadRootId: root.id });
    const elsewhere = await runOn(fx);
    await registerRunFiles(fx.db, { orgId: fx.org.id, agentId: fx.agent.id, runId: inThread.id }, [
      { path: "frames/1.png", role: "scratch" },
    ]);
    await registerRunFiles(fx.db, { orgId: fx.org.id, agentId: fx.agent.id, runId: elsewhere.id }, [
      { path: "other/unrelated.png", role: "scratch" },
    ]);
    const report = await writeRetentionReport(fx.db, fx.org.id, { type: "mission", id: mission.id });
    expect(report?.items.map((i) => i.path)).toEqual(["frames/1.png"]);
  });

  test("another workspace's ids give an empty report, never this one's files", async () => {
    f = await setup();
    const fx = f;
    const deps = { db: fx.db, pubsub: fx.pubsub };
    const issue = await createIssue(deps, person(fx.owner.id), fx.org.id, { title: "Nosso" });
    const run = await runOn(fx, { issueId: issue.id });
    await registerRunFiles(fx.db, { orgId: fx.org.id, agentId: fx.agent.id, runId: run.id }, [
      { path: "a.png", role: "scratch" },
    ]);
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "done" });
    const other = { id: crypto.randomUUID() };
    expect(await writeRetentionReport(fx.db, other.id, { type: "issue", id: issue.id })).toBeNull();
    expect((await buildFor(fx, other.id, issue.id)).items).toEqual([]);
  });
});

async function buildFor(fx: Fixture, orgId: string, issueId: string) {
  const { buildRetentionReport } = await import("../src/run-files");
  return buildRetentionReport(fx.db, orgId, { type: "issue", id: issueId }, "done");
}
