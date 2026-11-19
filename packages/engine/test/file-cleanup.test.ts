import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, schema } from "@agenteschat/db";
import {
  approveCleanup,
  approveFileCleanup,
  CLEANUP_SCRIPT,
  cleanupCommand,
  cleanWorkspaceView,
  FILE_CLEANUP_JOB,
  parseCleanupOutput,
  runFileCleanup,
  shellWord,
} from "../src/file-cleanup";
import { createIssue, updateIssue } from "../src/issues";
import { postPersonMessage } from "../src/messages";
import {
  evidenceSnapshot,
  markDuplicates,
  type RetentionItem,
  registerRunFiles,
  writeRetentionReport,
} from "../src/run-files";
import { captureGate, MAX_SCREENSHOTS_PER_RUN, pressureOf } from "../src/storage-pressure";
import { addMember, type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close?.();
  f = undefined;
});

const person = (userId: string) => ({ type: "person" as const, userId });
const now = Date.parse("2026-11-19T12:00:00Z");
const at = new Date(now - 60_000).toISOString();

describe("disk pressure", () => {
  test("three levels from free space and share used; an old or missing reading is unknown", () => {
    expect(pressureOf({ diskFreeGb: 120, diskUse: 0.7, at }, now).level).toBe("ok");
    expect(pressureOf({ diskFreeGb: 25, diskUse: 0.7, at }, now).level).toBe("low");
    expect(pressureOf({ diskFreeGb: 200, diskUse: 0.96, at }, now).level).toBe("low");
    expect(pressureOf({ diskFreeGb: 12, diskUse: 0.9, at }, now).level).toBe("critical");
    expect(pressureOf({ diskFreeGb: 40, diskUse: 0.985, at }, now).level).toBe("critical");
    expect(pressureOf({ diskFreeGb: 1, diskUse: 0.99, at: "2026-11-10T00:00:00Z" }, now).level).toBe("unknown");
    expect(pressureOf(null, now).level).toBe("unknown");
  });
});

describe("the report's snapshot and duplicates", () => {
  const item = (p: Partial<RetentionItem>): RetentionItem => ({
    where: "computer",
    path: "a",
    kind: "image",
    role: "scratch",
    size: 1,
    runId: null,
    decision: "keep",
    why: "x",
    ...p,
  });

  test("only the same bytes are duplicates; the first keeps its place", () => {
    const h = "a".repeat(64);
    const items = [
      item({ path: "shots/1.png", sha256: h, role: "evidence" }),
      item({ path: "shots/2.png", sha256: h }),
      item({ path: "shots/3.png", sha256: "b".repeat(64) }),
      item({ path: "shots/4.png" }),
    ];
    expect(markDuplicates(items)).toBe(1);
    expect(items[1]?.sameAs).toBe("computer:shots/1.png");
    expect(items[0]?.sameAs).toBeUndefined();
    expect(items[3]?.sameAs).toBeUndefined();
  });

  test("a manifest is not a backup: only Drive files with their hash are restorable", () => {
    const snap = evidenceSnapshot([
      item({ where: "drive", path: "report.html", role: "canonical", sha256: "c".repeat(64) }),
      item({ path: "evidence/after.png", role: "evidence", sha256: "d".repeat(64) }),
      item({ path: "scratch/x.png", role: "scratch" }),
    ]);
    expect(snap.items.map((i) => [i.path, i.restorable])).toEqual([
      ["report.html", true],
      ["evidence/after.png", false],
    ]);
    expect(snap).toMatchObject({ restorable: 1, manifestOnly: 1 });
  });
});

/** The script itself, run for real with python3 against a folder made for the test. */
describe("the computer's checks (CLEANUP_SCRIPT)", () => {
  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  const old = (p: string) => utimesSync(p, new Date(now - 3600_000), new Date(now - 3600_000));
  const run = (
    cwd: string,
    files: { path: string; size?: number; sha256?: string }[],
    options: { notAfter?: number; maxBytes?: number } = {},
  ) => {
    const payload = {
      seconds: 60,
      notAfter: options.notAfter ?? Math.floor(Date.now() / 1000),
      maxBytes: options.maxBytes ?? 2 * 1024 ** 3,
      files,
    };
    const arg = Buffer.from(JSON.stringify(payload)).toString("base64");
    const r = spawnSync("python3", ["-I", "-c", CLEANUP_SCRIPT, arg], { cwd, encoding: "utf8" });
    const out = parseCleanupOutput(r.stdout);
    if (!out) throw new Error(`no output: ${r.stderr}`);
    return Object.fromEntries(out.results.map((x) => [x.path, x]));
  };

  test.skipIf(!hasPython)(
    "removes only plain, stable, unreferenced files and says why it keeps the rest",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
      try {
        const w = (p: string, text = "data") => {
          mkdirSync(join(dir, p, ".."), { recursive: true });
          writeFileSync(join(dir, p), text);
          old(join(dir, p));
        };
        w("scratch/frame-1.png", "frame");
        w("scratch/fresh.png");
        utimesSync(join(dir, "scratch/fresh.png"), new Date(), new Date());
        w("scratch/linked.png");
        linkSync(join(dir, "scratch/linked.png"), join(dir, "scratch/linked-2.png"));
        w("protected/real.md", "important");
        symlinkSync(join(dir, "protected/real.md"), join(dir, "scratch/link.md"));
        mkdirSync(join(dir, "elsewhere"));
        w("elsewhere/target.png");
        symlinkSync(join(dir, "elsewhere"), join(dir, "via"));
        w("scratch/changed.png", "new bytes");
        w("scratch/state.sqlite");
        w("scratch/open.log");
        const held = openSync(join(dir, "scratch/open.log"), "r");
        // Held open under one spelling, registered under another (a case-insensitive disk sees one file).
        w("scratch/Shot.png");
        const heldShot = openSync(join(dir, "scratch/Shot.png"), "r");
        w("scratch/api-token.txt");
        w("scratch/.settings");
        // A Git work tree: the tracked file and an untracked, not ignored one stay; an ignored build file may go.
        const repo = join(dir, "repo");
        mkdirSync(repo);
        const git = (...a: string[]) =>
          spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
        git("init", "-q");
        writeFileSync(join(repo, ".gitignore"), "dist/\n.env\n");
        w("repo/src.md");
        git("add", ".gitignore", "src.md");
        git("commit", "-qm", "x");
        w("repo/notes.md");
        w("repo/dist/app.js");
        w("repo/.env", "KEY=1");
        const r = run(dir, [
          { path: "scratch/shot.png" },
          { path: "scratch/api-token.txt" },
          { path: "scratch/.settings" },
          { path: "repo/.env" },
          { path: "scratch/frame-1.png", size: 5 },
          { path: "scratch/fresh.png" },
          { path: "scratch/linked.png" },
          { path: "scratch/link.md" },
          { path: "via/target.png" },
          { path: "scratch/changed.png", sha256: "0".repeat(64) },
          { path: "scratch/state.sqlite" },
          { path: "scratch/open.log" },
          { path: "repo/src.md" },
          { path: "repo/notes.md" },
          { path: "repo/dist/app.js" },
          { path: "../outside.png" },
          { path: "repo/.git/config" },
          { path: "scratch/gone.png" },
        ]);
        closeSync(held);
        closeSync(heldShot);
        // Never removed under the other spelling: held open (a case-insensitive disk) or simply not there.
        expect(r["scratch/shot.png"]?.status).not.toBe("done");
        expect(existsSync(join(dir, "scratch/Shot.png"))).toBe(true);
        expect(r["scratch/frame-1.png"]?.status).toBe("done");
        expect(existsSync(join(dir, "scratch/frame-1.png"))).toBe(false);
        expect(r["repo/dist/app.js"]?.status).toBe("done");
        expect(r["scratch/gone.png"]).toMatchObject({ status: "skipped", reason: "already gone" });
        const kept: [string, RegExp][] = [
          ["scratch/fresh.png", /ten minutes/],
          ["scratch/linked.png", /hard links/],
          ["scratch/link.md", /link/],
          ["via/target.png", /link or not a folder/],
          ["scratch/changed.png", /contents changed/],
          ["scratch/state.sqlite", /database/],
          ["scratch/open.log", /open/],
          ["repo/src.md", /Git tracks it/],
          ["repo/notes.md", /not ignored/],
          ["../outside.png", /plain path/],
          ["repo/.git/config", /protected/],
          ["scratch/api-token.txt", /secret/],
          ["scratch/.settings", /hidden/],
          ["repo/.env", /hidden/],
        ];
        for (const [path, why] of kept) {
          expect(r[path]?.status).toBe("blocked");
          expect(r[path]?.reason).toMatch(why);
        }
        for (const p of [
          "protected/real.md",
          "elsewhere/target.png",
          "repo/src.md",
          "repo/notes.md",
          "scratch/open.log",
          "repo/.env",
        ])
          expect(existsSync(join(dir, p))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test.skipIf(!hasPython)(
    "a file changed after the work ended stays; past the byte budget the rest wait for the next round",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
      try {
        for (const n of ["a.bin", "b.bin", "c.bin"]) {
          writeFileSync(join(dir, n), "x".repeat(10_000));
          old(join(dir, n));
        }
        const ended = run(dir, [{ path: "a.bin" }], { notAfter: Math.floor((now - 2 * 3600_000) / 1000) });
        expect(ended["a.bin"]).toMatchObject({
          status: "blocked",
          reason: expect.stringMatching(/after the work ended/),
        });
        const r = run(dir, [{ path: "a.bin" }, { path: "b.bin" }, { path: "c.bin" }], { maxBytes: 1 });
        // One file alone may exceed the budget; the next ones wait.
        expect(r["a.bin"]?.status).toBe("done");
        expect(r["b.bin"]?.status).toBe("later");
        expect(existsSync(join(dir, "b.bin"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test("the shell sees only base64, whatever the paths hold", () => {
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
    const cmd = cleanupCommand([{ path: `scratch/a b'c"&calc&%x%.png`, size: 3 }], new Date(now));
    expect(cmd.startsWith("python3 -I -c '")).toBe(true);
    const arg = cmd.slice(cmd.lastIndexOf(" ") + 1);
    expect(arg).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(JSON.parse(Buffer.from(arg, "base64").toString()).files[0].path).toBe(`scratch/a b'c"&calc&%x%.png`);
  });
});

describe("approving and running a cleanup", () => {
  async function endedTaskWithFiles(fx: Fixture) {
    const deps = { db: fx.db, pubsub: fx.pubsub };
    const { paired } = await connectedComputer(fx, {
      exec: (req) => {
        calls.push(req);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            freeBefore: 1000,
            freeAfter: 5096,
            results: [
              { path: "scratch/frame-1.png", status: "done", bytes: 4096, identity: { ino: 1 } },
              { path: "dist/app.js", status: "blocked", reason: "a program has it open" },
            ],
          }),
          stderr: "",
        };
      },
    });
    const issue = await createIssue(deps, person(fx.owner.id), fx.org.id, { title: "Página" });
    const msg = await postPersonMessage(deps, fx.owner.id, fx.org.id, fx.general.id, { body: "x" });
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
        issueId: issue.id,
        status: "done",
      })
      .returning();
    if (!run) throw new Error("no run");
    await registerRunFiles(
      fx.db,
      { orgId: fx.org.id, agentId: fx.agent.id, runId: run.id, machineId: paired.machineId },
      [
        { path: "site/index.html", role: "canonical" },
        { path: "scratch/frame-1.png", role: "scratch", size: 4096 },
        { path: "dist/app.js", role: "derived" },
      ],
    );
    await updateIssue(deps, person(fx.owner.id), fx.org.id, issue.id, { status: "done" });
    await writeRetentionReport(fx.db, fx.org.id, { type: "issue", id: issue.id });
    const [report] = await fx.db.select().from(schema.retentionReports);
    if (!report) throw new Error("no report");
    // Whatever the messages above started has ended: an agent at work makes the job wait.
    await fx.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.agentId, fx.agent.id));
    return { issue, report, run, machineId: paired.machineId };
  }
  const calls: unknown[] = [];

  test("a person approves the report's candidates; the job checks them on the computer and keeps receipts", async () => {
    f = await setup({ machines: true });
    const fx = f;
    calls.length = 0;
    const { report } = await endedTaskWithFiles(fx);
    const bia = await addMember(fx.db, fx.org.id, "member", "bia");
    await expect(approveFileCleanup(fx.db, bia.id, fx.org.id, report.id)).rejects.toThrow();
    // A deliverable is not a candidate: it can't be approved by name.
    await expect(
      approveCleanup(fx.db, { orgId: fx.org.id, reportId: report.id, userId: fx.owner.id, paths: ["site/index.html"] }),
    ).rejects.toThrow(/candidates/);
    const approved = await approveFileCleanup(fx.db, fx.owner.id, fx.org.id, report.id);
    expect(approved).toEqual({ approved: 2, notOnAComputer: 0 });
    // Again: nothing new.
    expect((await approveFileCleanup(fx.db, fx.owner.id, fx.org.id, report.id)).approved).toBe(0);
    const jobs = await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FILE_CLEANUP_JOB));
    expect(jobs.length).toBeGreaterThan(0);
    await runFileCleanup({ db: fx.db, hub: fx.machineHub }, fx.org.id, report.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "exec", approved: true, agent: { id: fx.agent.id } });
    const rows = await fx.db.select().from(schema.fileCleanups);
    const by = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(by["scratch/frame-1.png"]).toMatchObject({ status: "done", bytes: 4096, freeBefore: 1000, freeAfter: 5096 });
    expect(by["dist/app.js"]).toMatchObject({ status: "blocked", reason: "a program has it open" });
    const view = await cleanWorkspaceView(fx.db, fx.owner.id, fx.org.id);
    expect(view.reports[0]?.removedBytes).toBe(4096);
    expect(view.reports[0]?.cleanups).toHaveLength(2);
  });

  test("a reopened task, a file re-registered as evidence, or a busy agent: nothing is removed", async () => {
    f = await setup({ machines: true });
    const fx = f;
    calls.length = 0;
    const { issue, report, run, machineId } = await endedTaskWithFiles(fx);
    await approveFileCleanup(fx.db, fx.owner.id, fx.org.id, report.id);
    // The agent now says the frame is evidence: the approval no longer holds for it.
    await registerRunFiles(fx.db, { orgId: fx.org.id, agentId: fx.agent.id, runId: run.id, machineId }, [
      { path: "scratch/frame-1.png", role: "evidence" },
    ]);
    // The agent is at work: the job waits, sends nothing.
    await fx.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
    await runFileCleanup({ db: fx.db, hub: fx.machineHub }, fx.org.id, report.id);
    expect(calls).toHaveLength(0);
    const frame = (await fx.db.select().from(schema.fileCleanups)).find((r) => r.path === "scratch/frame-1.png");
    expect(frame?.status).toBe("blocked");
    expect((await fx.db.select().from(schema.fileCleanups)).find((r) => r.path === "dist/app.js")?.status).toBe(
      "approved",
    );
    // Reopened: everything still waiting is refused.
    await updateIssue({ db: fx.db, pubsub: fx.pubsub }, person(fx.owner.id), fx.org.id, issue.id, {
      status: "in_progress",
    });
    await runFileCleanup({ db: fx.db, hub: fx.machineHub }, fx.org.id, report.id);
    expect(calls).toHaveLength(0);
    expect((await fx.db.select().from(schema.fileCleanups)).every((r) => r.status === "blocked")).toBe(true);
    await expect(approveFileCleanup(fx.db, fx.owner.id, fx.org.id, report.id)).rejects.toThrow(/reopened/);
  });

  test("another run's evidence at the same path, or a use after the work ended, keeps the file", async () => {
    f = await setup({ machines: true });
    const fx = f;
    calls.length = 0;
    const { report, run, machineId } = await endedTaskWithFiles(fx);
    await approveFileCleanup(fx.db, fx.owner.id, fx.org.id, report.id);
    // Later work by the same agent names the same files: one as its deliverable, one as scratch again.
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "y",
    });
    const [next] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    if (!next) throw new Error("no run");
    await fx.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.agentId, fx.agent.id));
    await registerRunFiles(fx.db, { orgId: fx.org.id, agentId: fx.agent.id, runId: next.id, machineId }, [
      { path: "scratch/frame-1.png", role: "canonical" },
      { path: "dist/app.js", role: "derived" },
    ]);
    await runFileCleanup({ db: fx.db, hub: fx.machineHub }, fx.org.id, report.id);
    expect(calls).toHaveLength(0);
    const by = Object.fromEntries((await fx.db.select().from(schema.fileCleanups)).map((r) => [r.path, r]));
    expect(by["scratch/frame-1.png"]).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/deliverable/),
    });
    expect(by["dist/app.js"]).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(/after the work ended/),
    });
    expect(run.id).not.toBe(next.id);
  });

  test("two jobs at once send each file once", async () => {
    f = await setup({ machines: true });
    const fx = f;
    calls.length = 0;
    const { report } = await endedTaskWithFiles(fx);
    await approveFileCleanup(fx.db, fx.owner.id, fx.org.id, report.id);
    await Promise.all([
      runFileCleanup({ db: fx.db, hub: fx.machineHub }, fx.org.id, report.id),
      runFileCleanup({ db: fx.db, hub: fx.machineHub }, fx.org.id, report.id),
    ]);
    expect(calls).toHaveLength(1);
    const frame = (await fx.db.select().from(schema.fileCleanups)).find((r) => r.path === "scratch/frame-1.png");
    expect(frame?.status).toBe("done");
  });

  test("a Windows computer is never sent a cleanup", async () => {
    f = await setup({ machines: true });
    const fx = f;
    calls.length = 0;
    const { report, machineId } = await endedTaskWithFiles(fx);
    await fx.db.update(schema.machines).set({ os: "windows" }).where(eq(schema.machines.id, machineId));
    await approveFileCleanup(fx.db, fx.owner.id, fx.org.id, report.id);
    await runFileCleanup({ db: fx.db, hub: fx.machineHub }, fx.org.id, report.id);
    expect(calls).toHaveLength(0);
    expect((await fx.db.select().from(schema.fileCleanups)).every((r) => r.status === "blocked")).toBe(true);
  });

  test("captures are refused on a nearly full disk and past the run's budget", async () => {
    f = await setup({ machines: true });
    const fx = f;
    const { paired } = await connectedComputer(fx);
    const load = (diskFreeGb: number) =>
      fx.db
        .update(schema.machines)
        .set({
          load: {
            loadAvg: 0,
            loadPeak: 0,
            memoryAvg: 0,
            memoryPeak: 0,
            hours: 1,
            diskFreeGb,
            diskUse: 0.5,
            at: new Date().toISOString(),
          },
        })
        .where(eq(schema.machines.id, paired.machineId));
    await load(10);
    const ctx = { orgId: fx.org.id, runId: null };
    expect(await captureGate(fx.db, ctx, paired.machineId, "recording")).toMatchObject({ refused: expect.any(String) });
    await load(20);
    expect(await captureGate(fx.db, ctx, paired.machineId, "screenshot")).toMatchObject({
      warning: expect.stringMatching(/short/),
    });
    await load(200);
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
      })
      .returning();
    if (!run) throw new Error("no run");
    await fx.db.insert(schema.runFiles).values(
      Array.from({ length: MAX_SCREENSHOTS_PER_RUN }, (_, i) => ({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        runId: run.id,
        path: `screenshots/${i}.png`,
        kind: "image",
        role: "unknown",
        capturedBy: "browser_screenshot",
      })),
    );
    expect(await captureGate(fx.db, { orgId: fx.org.id, runId: run.id }, paired.machineId, "screenshot")).toMatchObject(
      { refused: expect.stringMatching(/screenshots already/) },
    );
  });
});
