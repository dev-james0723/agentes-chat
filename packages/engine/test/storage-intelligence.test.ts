import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, schema } from "@agenteschat/db";
import { grantScopes, setAgentComputerTarget } from "../src";
import { createAgent } from "../src/agents";
import { FILES_GUIDANCE } from "../src/capabilities";
import { postPersonMessage } from "../src/messages";
import { registerRunFiles } from "../src/run-files";
import {
  type ArtifactFacts,
  decide,
  gcBudget,
  gcMode,
  LIFECYCLE_STATES,
  protectedPath,
  STORAGE_ACTIONS,
} from "../src/storage-decision";
import {
  decideStorageReview,
  fileLifecycleTool,
  type LifecycleOp,
  lifecycleEvent,
  reserve,
  runStorageGc,
  STORAGE_GC_JOB,
  setStorageGc,
  setStorageScope,
  storageGuardianView,
  storageReview,
} from "../src/storage-guardian";
import type { ToolContext } from "../src/tools/types";
import { addMember, type Fixture, setup } from "./fixtures";
import { connectedComputer } from "./machine-fixtures";

/** Real files, a real shell and the script's own 2 s settle per cycle: these take seconds, more on a busy computer. */
/**
 * Acceptance tests A–L for continuous cleanup (ADR 0214). The fake computer runs the real `CLEANUP_SCRIPT` with
 * the real shell in a real temporary folder, so every "removed" and "kept" below is a file that is or is not on disk.
 */

let f: Fixture | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close?.();
  f = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const LATER = () => Date.now() + 120_000;

async function world(fx: Fixture, options: { exec?: "real" | "throw"; mode?: "shadow" | "enforce" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sg-"));
  dirs.push(dir);
  const execs: string[][] = [];
  const { paired } = await connectedComputer(fx, {
    exec: (req) => {
      // An unclear answer: the connection dropped mid-command, nothing parseable came back.
      if (options.exec === "throw") return { exitCode: 255, stdout: "", stderr: "connection reset" };
      const payload = JSON.parse(Buffer.from(req.command.trim().split(" ").pop() ?? "", "base64").toString("utf8"));
      execs.push((payload.files as { path: string }[]).map((x) => x.path));
      const r = spawnSync("sh", ["-c", req.command], { cwd: dir, encoding: "utf8" });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
  });
  const machineId = paired.machineId;
  await setStorageScope(fx.db, fx.owner.id, fx.org.id, {
    machineId,
    root: "scratch/",
    mode: options.mode ?? "enforce",
  });
  const [lia] = await fx.db
    .insert(schema.agents)
    .values({
      orgId: fx.org.id,
      name: "Lia",
      handle: "lia",
      role: "Review",
      instructions: "",
      model: "claude-sonnet-5-5",
      ownerUserId: fx.owner.id,
    })
    .returning();
  if (!lia) throw new Error("no agent");
  const runOf = async (agentId: string) => {
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "work",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId,
        channelId: fx.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    if (!run) throw new Error("no run");
    return run;
  };
  const runA = await runOf(fx.agent.id);
  const runB = await runOf(lia.id);
  const write = (p: string, bytes = 1024) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), Buffer.alloc(bytes, 7));
    utimesSync(join(dir, p), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  };
  const A = { orgId: fx.org.id, agentId: fx.agent.id, runId: runA.id, machineId };
  const B = { orgId: fx.org.id, agentId: lia.id, runId: runB.id, machineId };
  const reg = (who: typeof A, files: { path: string; role: string; size?: number }[]) =>
    registerRunFiles(fx.db, who, files);
  const ev = (who: typeof A, op: LifecycleOp, paths: string[], stage?: string) =>
    lifecycleEvent(fx.db, who, op, paths, stage);
  const gc = (now = LATER()) => runStorageGc({ db: fx.db, hub: fx.machineHub }, fx.org.id, machineId, { now });
  const on = (p: string) => existsSync(join(dir, p));
  const state = async (p: string, agentId = fx.agent.id) =>
    (
      await fx.db
        .select()
        .from(schema.runFiles)
        .where(and(eq(schema.runFiles.path, p), eq(schema.runFiles.agentId, agentId)))
    )[0]?.state;
  return { dir, machineId, lia, runA, runB, A, B, write, reg, ev, gc, on, state, execs };
}

const facts = (over: Partial<ArtifactFacts> = {}): ArtifactFacts => ({
  role: "scratch",
  path: "scratch/a.bin",
  state: "sealed",
  sealed: true,
  sealedAgeSeconds: 600,
  openWriters: 0,
  openReaders: 0,
  futureStages: 0,
  expiredLeases: 0,
  otherRegistrationKeeps: false,
  siblingBlocks: 0,
  review: "none",
  machineKnown: true,
  machinePosix: true,
  scope: { mode: "enforce" },
  collectorEnabled: true,
  pressure: "ok",
  ...over,
});

describe("the decision engine (§7, §9)", () => {
  test("deterministic, one code per rule; only verified disposable scratch is DELETE", () => {
    expect(decide(facts()).action).toBe("DELETE");
    expect(decide(facts({ role: "canonical" })).code).toBe("deliverable");
    expect(decide(facts({ role: "evidence" })).code).toBe("evidence");
    expect(decide(facts({ role: "unknown" })).action).toBe("REVIEW");
    expect(decide(facts({ sealed: false })).code).toBe("in_use_writer");
    expect(decide(facts({ openReaders: 1 })).code).toBe("in_use_reader");
    expect(decide(facts({ futureStages: 1 })).code).toBe("reserved_future_stage");
    expect(decide(facts({ expiredLeases: 1 })).code).toBe("lease_expired_uncertain");
    expect(decide(facts({ scope: null })).action).toBe("RELEASE");
    expect(decide(facts({ collectorEnabled: false })).action).toBe("RELEASE");
    expect(decide(facts({ sealedAgeSeconds: 5 })).action).toBe("DEFER");
    expect(decide(facts({ review: "open" })).code).toBe("review_pending");
    expect(decide(facts({ otherRegistrationKeeps: true })).action).toBe("PROTECT");
    expect(decide(facts({ machinePosix: false })).code).toBe("not_posix");
    expect(decide(facts({ review: "archive" })).action).toBe("ARCHIVE");
    expect(STORAGE_ACTIONS).toHaveLength(8);
    expect(LIFECYCLE_STATES).toContain("unknown");
  }, 120_000);

  test("storage pressure never weakens protection; it only changes the collector's budget", () => {
    const keepers: Partial<ArtifactFacts>[] = [
      { role: "canonical" },
      { role: "evidence" },
      { role: "unknown" },
      { openReaders: 2 },
      { futureStages: 1 },
      { expiredLeases: 1 },
      { review: "open" },
      { path: "scratch/.git/x" },
      { path: "scratch/node_modules/a.js" },
    ];
    for (const k of keepers) {
      const base = decide(facts(k));
      for (const pressure of ["ok", "low", "critical", "unknown"] as const) {
        const d = decide(facts({ ...k, pressure }));
        expect(d.action).toBe(base.action);
        expect(d.action).not.toBe("DELETE");
      }
    }
    expect(decide(facts({ role: "evidence", pressure: "critical" })).suggestion).toBe("relocate");
    expect(gcMode("ok")).toBe("normal");
    expect(gcMode("low")).toBe("elevated");
    expect(gcMode("critical")).toBe("critical");
    expect(gcMode("critical", "performance")).toBe("performance");
    expect(gcBudget("performance").files).toBeLessThan(gcBudget("normal").files);
    expect(gcBudget("critical").files).toBeGreaterThan(gcBudget("normal").files);
  }, 120_000);
});

describe("acceptance", () => {
  test.skipIf(!hasPython)(
    "A: scratch is removed while its agent is still working; what it writes stays",
    async () => {
      f = await setup({ machines: true });
      const w = await world(f);
      w.write("scratch/a1.bin", 4096);
      w.write("scratch/a2.bin", 4096);
      await w.reg(w.A, [
        { path: "scratch/a1.bin", role: "scratch", size: 4096 },
        { path: "scratch/a2.bin", role: "scratch", size: 4096 },
      ]);
      await w.ev(w.A, "seal", ["scratch/a1.bin"]);
      const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, STORAGE_GC_JOB));
      expect(jobs.length).toBeGreaterThan(0);
      const cycle = await w.gc();
      expect(cycle.removed).toBe(1);
      expect(w.on("scratch/a1.bin")).toBe(false);
      expect(w.on("scratch/a2.bin")).toBe(true);
      expect(await w.state("scratch/a1.bin")).toBe("deleted");
      expect(await w.state("scratch/a2.bin")).toBe("created");
      const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, w.runA.id));
      expect(run?.status).toBe("running");
      // The receipt is in the agent's own conversation, quiet: it starts no run.
      const notices = (await f.db.select().from(schema.messages)).filter(
        (m) => (m.meta as { notice?: { kind?: string } } | null)?.notice?.kind === "cleanup_receipt",
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.threadId).toBe(w.runA.threadRootId);
      const meta = notices[0]?.meta as { notice?: { text?: string } } | undefined;
      expect(String(meta?.notice?.text)).toContain("scratch/a1.bin removed");
      const journal = await f.db.select().from(schema.artifactTransitions);
      expect(journal.map((j) => j.toState)).toEqual(expect.arrayContaining(["sealed", "reserved", "deleted"]));
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "B: another agent's reader keeps the file until it releases; only the maker seals",
    async () => {
      f = await setup({ machines: true });
      const w = await world(f);
      w.write("scratch/shared.bin");
      await w.reg(w.A, [{ path: "scratch/shared.bin", role: "scratch" }]);
      const sealByB = await w.ev(w.B, "seal", ["scratch/shared.bin"]);
      expect(sealByB.files[0]?.note).toContain("only the agent that made it");
      await w.ev(w.A, "seal", ["scratch/shared.bin"]);
      await w.ev(w.B, "read", ["scratch/shared.bin"]);
      const kept = await w.gc();
      expect(kept.decisions.in_use_reader).toBe(1);
      expect(w.on("scratch/shared.bin")).toBe(true);
      await w.ev(w.B, "release", ["scratch/shared.bin"]);
      await w.gc();
      expect(w.on("scratch/shared.bin")).toBe(false);
    },
  );

  test.skipIf(!hasPython)(
    "C: a later stage's reservation keeps the file until that stage releases it",
    async () => {
      f = await setup({ machines: true });
      const w = await world(f);
      w.write("scratch/stage1.out");
      await w.reg(w.A, [{ path: "scratch/stage1.out", role: "derived" }]);
      await w.ev(w.A, "seal", ["scratch/stage1.out"]);
      await w.ev(w.A, "future", ["scratch/stage1.out"], "stage 3: packaging");
      expect((await w.gc()).decisions.reserved_future_stage).toBe(1);
      expect(w.on("scratch/stage1.out")).toBe(true);
      // Its turn ends: a later stage is a later run, so the reservation outlives this one.
      await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, w.runA.id));
      expect((await w.gc()).decisions.reserved_future_stage).toBe(1);
      expect(w.on("scratch/stage1.out")).toBe(true);
      // Even after the run ends a future reservation of a finished run is released by evidence, not by a timeout.
      await w.ev(w.A, "release", ["scratch/stage1.out"]);
      await w.gc();
      expect(w.on("scratch/stage1.out")).toBe(false);
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "D: review — uncertain files wait for a person; bulk decisions keep a history",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      for (const p of ["scratch/u1.png", "scratch/u2.png", "scratch/u3.png"]) w.write(p);
      await w.reg(w.A, [
        { path: "scratch/u1.png", role: "unknown" },
        { path: "scratch/u2.png", role: "unknown" },
        { path: "scratch/u3.png", role: "unknown" },
      ]);
      await w.ev(w.A, "seal", ["scratch/u1.png", "scratch/u2.png", "scratch/u3.png"]);
      await w.gc();
      await w.gc();
      for (const p of ["scratch/u1.png", "scratch/u2.png", "scratch/u3.png"]) expect(w.on(p)).toBe(true);
      const queue = await storageReview(fx.db, fx.owner.id, fx.org.id);
      expect(queue).toHaveLength(3);
      expect(queue.every((i) => i.status === "open" && i.code === "role_unknown")).toBe(true);
      const member = await addMember(fx.db, fx.org.id, "member", "bia");
      await expect(storageReview(fx.db, member.id, fx.org.id)).rejects.toThrow();
      const id = (p: string) => queue.find((i) => i.file.path === p)?.id as string;
      await decideStorageReview(fx.db, fx.owner.id, fx.org.id, [id("scratch/u1.png"), id("scratch/u2.png")], "delete");
      await decideStorageReview(fx.db, fx.owner.id, fx.org.id, [id("scratch/u3.png")], "protect");
      const cycle = await w.gc();
      expect(cycle.removed).toBe(2);
      expect(w.on("scratch/u1.png")).toBe(false);
      expect(w.on("scratch/u3.png")).toBe(true);
      expect(await w.state("scratch/u3.png")).toBe("protected");
      const rows = await fx.db.select().from(schema.fileCleanups).where(eq(schema.fileCleanups.source, "review"));
      expect(rows.every((r) => r.approvedByUserId === fx.owner.id)).toBe(true);
      const again = await decideStorageReview(fx.db, fx.owner.id, fx.org.id, [id("scratch/u1.png")], "restore");
      expect(again.results[0]).toMatchObject({ ok: false });
      await decideStorageReview(fx.db, fx.owner.id, fx.org.id, [id("scratch/u3.png")], "restore");
      const after = await storageReview(fx.db, fx.owner.id, fx.org.id);
      expect(after.find((i) => i.file.path === "scratch/u3.png")?.history.map((h) => h.action)).toEqual([
        "protect",
        "restore",
      ]);
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "E: caches, build state and simulators are never removed, nor authorized",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      const risky = [
        "scratch/DerivedData/App/Build/x.o",
        "scratch/node_modules/pkg/index.js",
        "scratch/.next/cache/a.pack",
        "scratch/Library/Developer/CoreSimulator/Devices/D1/data.img",
        "scratch/run/app.sqlite",
        "scratch/keys/id_ed25519",
        "scratch/src/main.ts",
      ];
      for (const p of risky) w.write(p);
      await w.reg(
        w.A,
        risky.map((path) => ({ path, role: "derived" })),
      );
      await w.ev(w.A, "seal", risky);
      const cycle = await w.gc();
      expect(cycle.removed).toBe(0);
      expect(cycle.decisions.protected_path).toBe(risky.length);
      for (const p of risky) expect(w.on(p)).toBe(true);
      await expect(
        setStorageScope(fx.db, fx.owner.id, fx.org.id, { machineId: w.machineId, root: "DerivedData/" }),
      ).rejects.toThrow(/can't be authorized/);
      await expect(
        setStorageScope(fx.db, fx.owner.id, fx.org.id, { machineId: w.machineId, root: "../" }),
      ).rejects.toThrow();
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "F: crash recovery — a stale claim is checked again, an unclear answer is never counted",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      w.write("scratch/f1.bin", 2048);
      w.write("scratch/f2.bin", 2048);
      await w.reg(w.A, [
        { path: "scratch/f1.bin", role: "scratch", size: 2048 },
        { path: "scratch/f2.bin", role: "scratch", size: 2048 },
      ]);
      await w.ev(w.A, "seal", ["scratch/f1.bin", "scratch/f2.bin"]);
      // A collector reserved both and died; f2 had even been removed before the crash.
      for (const p of ["scratch/f1.bin", "scratch/f2.bin"]) {
        const [row] = await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.path, p));
        if (!row) throw new Error("no row");
        expect(await reserve(fx.db, row, "dead-collector")).toBe(true);
      }
      rmSync(join(w.dir, "scratch/f2.bin"));
      // Fresh claim: nothing happens yet.
      expect((await w.gc()).reserved).toBe(0);
      await fx.db
        .update(schema.runFiles)
        .set({ reservedAt: new Date(Date.now() - 20 * 60_000) })
        .where(eq(schema.runFiles.state, "reserved"));
      const cycle = await w.gc();
      expect(cycle.removed).toBe(1);
      expect(await w.state("scratch/f1.bin")).toBe("deleted");
      expect(await w.state("scratch/f2.bin")).toBe("deleted");
      const rows = await fx.db.select().from(schema.fileCleanups);
      expect(rows.find((r) => r.path === "scratch/f2.bin")?.status).toBe("skipped");
      // Only the file this cycle removed counts.
      expect(cycle.logicalBytes).toBe(2048);

      // An unclear answer from the computer: the file stays reserved, is not counted, and is still on disk.
      await fx.machineHub?.stop();
      await fx.close?.();
      f = await setup({ machines: true });
      const g = f;
      const v = await world(g, { exec: "throw" });
      v.write("scratch/u.bin");
      await v.reg(v.A, [{ path: "scratch/u.bin", role: "scratch" }]);
      await v.ev(v.A, "seal", ["scratch/u.bin"]);
      const unclear = await v.gc();
      expect(unclear.unknown).toBe(1);
      expect(unclear.removed).toBe(0);
      expect(await v.state("scratch/u.bin")).toBe("reserved");
      expect(v.on("scratch/u.bin")).toBe(true);
    },
  );

  test.skipIf(!hasPython)(
    "G: 100 contexts at once — one reservation wins, every file is sent once",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      w.write("scratch/race.bin");
      await w.reg(w.A, [{ path: "scratch/race.bin", role: "scratch" }]);
      await w.ev(w.A, "seal", ["scratch/race.bin"]);
      const [row] = await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.path, "scratch/race.bin"));
      if (!row) throw new Error("no row");
      const wins = await Promise.all(Array.from({ length: 100 }, (_, i) => reserve(fx.db, row, `c${i}`)));
      expect(wins.filter(Boolean)).toHaveLength(1);
      const versions = await fx.db
        .select()
        .from(schema.artifactTransitions)
        .where(eq(schema.artifactTransitions.runFileId, row.id));
      expect(new Set(versions.map((v) => v.version)).size).toBe(versions.length);

      // 100 readers on one file from 100 runs; 99 release; the last one alone keeps it.
      const paths = Array.from({ length: 30 }, (_, i) => `scratch/many/${i}.bin`);
      for (const p of paths) w.write(p);
      await w.reg(
        w.A,
        paths.map((path) => ({ path, role: "scratch" })),
      );
      await w.ev(w.A, "seal", paths);
      const readers = Array.from({ length: 100 }, (_, i) => ({ ...w.B, runId: `${w.runB.id}`, i }));
      await Promise.all(readers.map((r) => w.ev(r, "read", ["scratch/many/0.bin"])));
      const open = await fx.db.select().from(schema.artifactLeases).where(eq(schema.artifactLeases.status, "open"));
      expect(open.length).toBe(100);
      // 100 collectors at once over 30 files: each file reaches the computer at most once.
      await Promise.all(Array.from({ length: 100 }, () => w.gc()));
      const sent = w.execs.flat();
      expect(sent.length).toBe(new Set(sent).size);
      expect(w.on("scratch/many/0.bin")).toBe(true);
      for (const p of paths.slice(1)) expect(w.on(p)).toBe(false);
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "H: adversarial — links, swaps, rewrites, lies and traversal are refused",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      w.write("private/real.md", 100);
      w.write("scratch/hard.bin");
      linkSync(join(w.dir, "scratch/hard.bin"), join(w.dir, "private/hard-copy.bin"));
      mkdirSync(join(w.dir, "scratch"), { recursive: true });
      symlinkSync(join(w.dir, "private/real.md"), join(w.dir, "scratch/link.md"));
      w.write("scratch/sub/target.bin");
      w.write("scratch/rewritten.bin");
      w.write("scratch/liar.bin");
      const files = ["scratch/link.md", "scratch/hard.bin", "scratch/sub/target.bin", "scratch/rewritten.bin"];
      await w.reg(w.A, [
        ...files.map((path) => ({ path, role: "scratch" })),
        { path: "scratch/liar.bin", role: "scratch", size: 999_999 },
      ]);
      await w.ev(w.A, "seal", [...files, "scratch/liar.bin"]);
      // After sealing: the folder is swapped for a link to private data, and a file is written again.
      w.write("private/sub/target.bin", 50);
      rmSync(join(w.dir, "scratch/sub"), { recursive: true });
      symlinkSync(join(w.dir, "private/sub"), join(w.dir, "scratch/sub"));
      writeFileSync(join(w.dir, "scratch/rewritten.bin"), "new");
      // Another run calls the same path a deliverable.
      await w.reg(w.B, [{ path: "scratch/deliver.bin", role: "canonical" }]);
      w.write("scratch/deliver.bin");
      await w.reg(w.A, [{ path: "scratch/deliver.bin", role: "scratch" }]);
      await w.ev(w.A, "seal", ["scratch/deliver.bin"]);
      const cycle = await w.gc();
      expect(cycle.removed).toBe(0);
      expect(w.on("private/real.md")).toBe(true);
      expect(w.on("private/hard-copy.bin")).toBe(true);
      expect(w.on("private/sub/target.bin")).toBe(true);
      expect(w.on("scratch/rewritten.bin")).toBe(true);
      expect(w.on("scratch/liar.bin")).toBe(true);
      expect(w.on("scratch/deliver.bin")).toBe(true);
      const reasons = Object.fromEntries(
        (await fx.db.select().from(schema.fileCleanups)).map((r) => [r.path, r.reason ?? ""]),
      );
      expect(reasons["scratch/link.md"]).toMatch(/link/);
      expect(reasons["scratch/hard.bin"]).toMatch(/hard links/);
      expect(reasons["scratch/sub/target.bin"]).toMatch(/link|folder/);
      expect(reasons["scratch/rewritten.bin"]).toMatch(/changed/);
      expect(reasons["scratch/liar.bin"]).toMatch(/size/);
      const review = await storageReview(fx.db, fx.owner.id, fx.org.id);
      expect(review.filter((r) => r.code === "computer_refused").length).toBe(5);
      expect(await w.state("scratch/deliver.bin")).toBe("protected");
      // Paths an agent might try.
      await expect(w.reg(w.A, [{ path: "scratch/../../etc/passwd", role: "scratch" }])).rejects.toThrow();
      await expect(w.reg(w.A, [{ path: "/etc/hosts", role: "scratch" }])).rejects.toThrow();
      expect(protectedPath("scratch/.git/HEAD")).not.toBeNull();
      expect(protectedPath("scratch/backup-2026.tar")).not.toBeNull();
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "I: measured recovery — logical, allocated and free space are kept apart",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      const mib = 1024 * 1024;
      w.write("scratch/big1.bin", 8 * mib);
      w.write("scratch/big2.bin", 4 * mib);
      await w.reg(w.A, [
        { path: "scratch/big1.bin", role: "scratch", size: 8 * mib },
        { path: "scratch/big2.bin", role: "scratch", size: 4 * mib },
      ]);
      await w.ev(w.A, "seal", ["scratch/big1.bin", "scratch/big2.bin"]);
      const cycle = await w.gc();
      expect(cycle.removed).toBe(2);
      expect(cycle.logicalBytes).toBe(12 * mib);
      expect(cycle.allocatedBytes).toBeGreaterThan(0);
      expect(cycle.freeBefore).not.toBeNull();
      expect(cycle.freeAfter).not.toBeNull();
      const view = await storageGuardianView(fx.db, fx.owner.id, fx.org.id);
      expect(view.figures.unlinked).toBe(2);
      expect(view.figures.logicalBytes).toBe(12 * mib);
      expect(view.figures.allocatedBytes).toBe(cycle.allocatedBytes);
      // Two files, one round: the round's free-space change is counted once.
      expect(view.figures.measuredRounds).toBe(1);
      expect(view.figures.freeDeltaBytes).toBe((cycle.freeAfter ?? 0) - (cycle.freeBefore ?? 0));
      console.log(
        `[I] logical=${cycle.logicalBytes} allocated=${cycle.allocatedBytes} freeDelta=${(cycle.freeAfter ?? 0) - (cycle.freeBefore ?? 0)}`,
      );
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "J: an agent's own tool call drives the whole loop to a receipt",
    async () => {
      f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
      const fx = f;
      const w = await world(fx);
      const ctx = {
        db: fx.db,
        orgId: fx.org.id,
        agentId: fx.agent.id,
        runId: w.runA.id,
        channelId: w.runA.channelId,
        threadRootId: w.runA.threadRootId,
        triggerMessageId: w.runA.triggerMessageId,
      } as ToolContext;
      const listed = ((await fx.tools?.list(ctx)) ?? []).map((t) => t.name);
      expect(listed).toContain("register_files");
      expect(listed).toContain("file_lifecycle");
      w.write("scratch/tool.bin");
      await w.reg(w.A, [{ path: "scratch/tool.bin", role: "scratch" }]);
      const tool = fileLifecycleTool(fx.db, async () => w.machineId);
      const out = await tool.execute({ op: "seal", paths: ["scratch/tool.bin"] }, ctx);
      expect(out.isError).toBeFalsy();
      expect(String(out.content)).toContain("sealed");
      await w.gc();
      expect(w.on("scratch/tool.bin")).toBe(false);
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "K: performance — decisions are cheap, events are light, a cycle keeps its budget",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      const t0 = performance.now();
      for (let i = 0; i < 100_000; i++) decide(facts({ openReaders: i % 3 }));
      const perDecisionUs = ((performance.now() - t0) * 1000) / 100_000;
      expect(perDecisionUs).toBeLessThan(50);
      const paths = Array.from({ length: 120 }, (_, i) => `scratch/k/${i}.bin`);
      for (const p of paths) w.write(p, 256);
      for (let i = 0; i < paths.length; i += 100)
        await w.reg(
          w.A,
          paths.slice(i, i + 100).map((path) => ({ path, role: "scratch" })),
        );
      const lat: number[] = [];
      for (const p of paths) {
        const s = performance.now();
        await w.ev(w.A, "seal", [p]);
        lat.push(performance.now() - s);
      }
      lat.sort((a, b) => a - b);
      const p95 = lat[Math.floor(lat.length * 0.95)] ?? 0;
      const c0 = performance.now();
      const cycle = await w.gc();
      const cycleMs = performance.now() - c0;
      // Normal mode: at most 50 files a cycle; the rest wait for the next.
      expect(cycle.removed).toBeLessThanOrEqual(gcBudget("normal").files);
      expect(cycle.removed).toBeGreaterThan(0);
      console.log(
        `[K] decide=${perDecisionUs.toFixed(2)}µs/eval eventP95=${p95.toFixed(1)}ms cycle=${cycleMs.toFixed(0)}ms removed=${cycle.removed}`,
      );
    },
  );

  test("L: a new agent inherits the tool and the guidance with no setup of its own", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const fx = f;
    const { paired } = await connectedComputer(fx);
    const agent = await createAgent(
      fx.db,
      fx.owner.id,
      fx.org.id,
      {
        name: "Nova",
        handle: "nova",
        role: "Builder",
        instructions: "",
        model: "claude-sonnet-5-5",
      } as Parameters<typeof createAgent>[3],
      { model: "claude-sonnet-5-5" },
    );
    await grantScopes(fx.db, fx.org.id, agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
    await setAgentComputerTarget({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, agent.id, paired.machineId);
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "x",
    });
    const ctx = {
      db: fx.db,
      orgId: fx.org.id,
      agentId: agent.id,
      runId: Bun.randomUUIDv7(),
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
    } as ToolContext;
    const listed = ((await fx.tools?.list(ctx)) ?? []).map((t) => t.name);
    expect(listed).toContain("file_lifecycle");
    expect(FILES_GUIDANCE).toContain("file_lifecycle");
    expect(FILES_GUIDANCE.length).toBeLessThan(500);
  }, 120_000);
});

describe("one file, many registrations (independent review)", () => {
  test.skipIf(!hasPython)(
    "a read or a pin on another run's registration of the same file keeps it",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      w.write("scratch/x.bin");
      w.write("scratch/y.bin");
      await w.reg(w.A, [
        { path: "scratch/x.bin", role: "scratch" },
        { path: "scratch/y.bin", role: "scratch" },
      ]);
      await w.ev(w.A, "seal", ["scratch/x.bin", "scratch/y.bin"]);
      // B registers the same paths in its own run (a new row each) and reads one, pins the other.
      await w.reg(w.B, [
        { path: "scratch/x.bin", role: "scratch" },
        { path: "scratch/y.bin", role: "scratch" },
      ]);
      await w.ev(w.B, "read", ["scratch/x.bin"]);
      await w.ev(w.B, "pin", ["scratch/y.bin"]);
      const cycle = await w.gc();
      expect(cycle.removed).toBe(0);
      expect(w.on("scratch/x.bin")).toBe(true);
      expect(w.on("scratch/y.bin")).toBe(true);
      expect(await w.state("scratch/y.bin")).toBe("protected");
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "another agent can't make someone else's unfinished file removable by sealing its own row",
    async () => {
      f = await setup({ machines: true });
      const w = await world(f);
      w.write("scratch/wip.bin");
      await w.reg(w.A, [{ path: "scratch/wip.bin", role: "scratch" }]);
      await w.reg(w.B, [{ path: "scratch/wip.bin", role: "scratch" }]);
      await w.ev(w.B, "seal", ["scratch/wip.bin"]);
      const cycle = await w.gc();
      expect(cycle.decisions.sibling_in_use).toBe(1);
      expect(w.on("scratch/wip.bin")).toBe(true);
    },
  );

  test.skipIf(!hasPython)(
    "a role change, or a pin or lease after the reservation, stops the removal",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      w.write("scratch/r.bin");
      await w.reg(w.A, [{ path: "scratch/r.bin", role: "scratch" }]);
      await w.ev(w.A, "seal", ["scratch/r.bin"]);
      const [seen] = await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.path, "scratch/r.bin"));
      if (!seen) throw new Error("no row");
      await w.reg(w.A, [{ path: "scratch/r.bin", role: "canonical" }]);
      expect(await reserve(fx.db, seen, "stale-decision")).toBe(false);
      expect(w.on("scratch/r.bin")).toBe(true);
    },
    120_000,
  );

  test.skipIf(!hasPython)(
    "files that stay never starve newer ones",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      const outside = Array.from({ length: 250 }, (_, i) => `elsewhere/${i}.bin`);
      for (let i = 0; i < outside.length; i += 100)
        await w.reg(
          w.A,
          outside.slice(i, i + 100).map((path) => ({ path, role: "scratch" })),
        );
      await w.ev(w.A, "seal", outside.slice(0, 100));
      await w.ev(w.A, "seal", outside.slice(100, 200));
      await w.ev(w.A, "seal", outside.slice(200));
      for (let i = 0; i < 3; i++) await w.gc();
      w.write("scratch/new.bin");
      await w.reg(w.A, [{ path: "scratch/new.bin", role: "scratch" }]);
      await w.ev(w.A, "seal", ["scratch/new.bin"]);
      await w.gc();
      await w.gc();
      expect(w.on("scratch/new.bin")).toBe(false);
    },
    120_000,
  );
});

describe("liveness and late readers (independent re-review)", () => {
  test.skipIf(!hasPython)(
    "a file still settling gets its own later cycle; a reader withdraws a pending claim",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      w.write("scratch/s1.bin");
      await w.reg(w.A, [{ path: "scratch/s1.bin", role: "scratch" }]);
      await w.ev(w.A, "seal", ["scratch/s1.bin"]);
      const at = Date.now();
      const cycle = await w.gc(at);
      expect(cycle.decisions.settling).toBe(1);
      const later = (await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, STORAGE_GC_JOB))).filter(
        (j) => j.nextAttemptAt.getTime() >= at + 60_000,
      );
      expect(later.length).toBeGreaterThan(0);
      const [row] = await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.path, "scratch/s1.bin"));
      if (!row) throw new Error("no row");
      expect(await reserve(fx.db, row, "pending")).toBe(true);
      await w.ev(w.B, "read", ["scratch/s1.bin"]);
      expect(await w.state("scratch/s1.bin")).toBe("released");
      await w.gc();
      expect(w.on("scratch/s1.bin")).toBe(true);
    },
  );
});

describe("rollout controls (§12, §17)", () => {
  test.skipIf(!hasPython)(
    "shadow records what would go and touches nothing; the kill switch stops it all",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx, { mode: "shadow" });
      w.write("scratch/s.bin");
      await w.reg(w.A, [{ path: "scratch/s.bin", role: "scratch", size: 1024 }]);
      await w.ev(w.A, "seal", ["scratch/s.bin"]);
      const one = await w.gc();
      await w.gc();
      expect(one.shadow).toBe(1);
      expect(w.on("scratch/s.bin")).toBe(true);
      expect(w.execs).toHaveLength(0);
      const shadow = await fx.db.select().from(schema.fileCleanups).where(eq(schema.fileCleanups.shadow, true));
      expect(shadow).toHaveLength(1);
      await setStorageScope(fx.db, fx.owner.id, fx.org.id, {
        machineId: w.machineId,
        root: "scratch/",
        mode: "enforce",
      });
      await setStorageGc(fx.db, fx.owner.id, fx.org.id, { enabled: false });
      const off = await w.gc();
      expect(off.decisions.collector_off).toBe(1);
      expect(w.on("scratch/s.bin")).toBe(true);
      await setStorageGc(fx.db, fx.owner.id, fx.org.id, { enabled: true });
      await w.gc();
      expect(w.on("scratch/s.bin")).toBe(false);
      const member = await addMember(fx.db, fx.org.id, "member", "rui");
      await expect(setStorageGc(fx.db, member.id, fx.org.id, { enabled: false })).rejects.toThrow();
    },
  );

  test.skipIf(!hasPython)(
    "a lease whose heartbeat stopped proves nothing: the file goes to review",
    async () => {
      f = await setup({ machines: true });
      const fx = f;
      const w = await world(fx);
      w.write("scratch/l.bin");
      await w.reg(w.A, [{ path: "scratch/l.bin", role: "scratch" }]);
      await w.ev(w.A, "seal", ["scratch/l.bin"]);
      await w.ev(w.B, "read", ["scratch/l.bin"]);
      await fx.db.update(schema.artifactLeases).set({ expiresAt: new Date(Date.now() - 1000) });
      const cycle = await w.gc();
      expect(cycle.removed).toBe(0);
      expect(w.on("scratch/l.bin")).toBe(true);
      const items = await fx.db
        .select()
        .from(schema.storageReviewItems)
        .where(and(eq(schema.storageReviewItems.orgId, fx.org.id), eq(schema.storageReviewItems.status, "open")));
      expect(items.map((i) => i.code)).toContain("lease_expired_uncertain");
    },
    120_000,
  );
});
