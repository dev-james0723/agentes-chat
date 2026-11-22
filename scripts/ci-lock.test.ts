import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "ci-lock.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lockPath() {
  const dir = mkdtempSync(join(tmpdir(), "ci-lock-"));
  dirs.push(dir);
  return join(dir, "ci.lock");
}

/** A shell that takes the lock, runs `body`, and gives it back on exit. */
const run = (lock: string, body: string, wait = "14400") =>
  Bun.spawn(["bash", "-c", `. "${script}" && ci_lock test || exit $?; ${body}`], {
    env: {
      ...process.env,
      AGENTES_CI_STATE_DIR: join(lock, "..", "host-state"),
      AGENTES_CI_MAX_PARALLEL: "2",
      AGENTES_CI_LEGACY_EXCLUDED: "1",
      AGENTES_CI_LOCK: lock,
      AGENTES_CI_LOCK_WAIT: wait,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

test("a second run waits until the first gives the lock back, and says whose run it waits on", async () => {
  const lock = lockPath();
  const order = join(lock, "..", "order");
  const first = run(lock, `echo first-start >> "${order}"; sleep 2; echo first-end >> "${order}"`);
  await Bun.sleep(300);
  const second = run(lock, `echo second >> "${order}"`);
  expect(await first.exited).toBe(0);
  expect(await second.exited).toBe(0);
  expect(readFileSync(order, "utf8").trim().split("\n")).toEqual(["first-start", "first-end", "second"]);
  expect(await new Response(second.stderr).text()).toContain("ci lock: waiting for pid=");
  expect(existsSync(lock)).toBe(false);
}, 60_000);

test("a lock whose run is gone is taken over at once", async () => {
  const lock = lockPath();
  mkdirSync(lock);
  // No process has this id: the run that held it ended without giving it back.
  writeFileSync(join(lock, "owner"), "pid=999999\nlabel=crashed\n");
  const p = run(lock, "echo ran", "0");
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toContain("ran");
  expect(await new Response(p.stderr).text()).toContain("taking over from a run that is gone");
});

test("with no wait allowed, a run held by a live process fails at once and leaves the lock alone", async () => {
  const lock = lockPath();
  const holder = run(lock, "sleep 3");
  await Bun.sleep(300);
  const p = run(lock, "echo ran", "0");
  expect(await p.exited).toBe(1);
  expect(await new Response(p.stdout).text()).not.toContain("ran");
  expect(existsSync(lock)).toBe(true);
  await holder.exited;
  expect(existsSync(lock)).toBe(false);
}, 30_000);

test("a run that fails still gives the lock back", async () => {
  const lock = lockPath();
  expect(await run(lock, "exit 3").exited).toBe(3);
  expect(existsSync(lock)).toBe(false);
});

/** Default admission uses a unique mutex for each checkout but one host budget. */
function runScoped(root: string, name: string, body: string, wait = "20", extraEnv: Record<string, string> = {}) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  return Bun.spawn(["bash", "-c", `. "${script}" && ci_lock scoped || exit $?; ${body}`], {
    cwd,
    env: {
      ...process.env,
      AGENTES_CI_LOCK: "",
      AGENTES_CI_STATE_DIR: join(root, "host-state"),
      AGENTES_CI_MAX_PARALLEL: "2",
      AGENTES_CI_LEGACY_EXCLUDED: "1",
      AGENTES_CI_LOCK_WAIT: wait,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("two independent CI worktrees run at once; third waits for a host slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-parallel-"));
  dirs.push(root);
  const order = join(root, "order");
  const a = runScoped(root, "work-a", `echo a-start >> "${order}"; sleep 3; echo a-end >> "${order}"`);
  await Bun.sleep(350);
  const b = runScoped(root, "work-b", `echo b-start >> "${order}"; sleep 3; echo b-end >> "${order}"`);
  await Bun.sleep(350);
  const c = runScoped(root, "work-c", `echo c-start >> "${order}"; echo c-end >> "${order}"`);
  await Bun.sleep(900);
  const mid = readFileSync(order, "utf8").trim().split("\n");
  expect(mid).toContain("a-start");
  expect(mid).toContain("b-start");
  expect(mid).not.toContain("c-start");
  expect(await Promise.all([a.exited, b.exited, c.exited])).toEqual([0, 0, 0]);
  const all = readFileSync(order, "utf8").trim().split("\n");
  expect(all.indexOf("c-start")).toBeGreaterThan(Math.min(all.indexOf("a-end"), all.indexOf("b-end")));
  expect(existsSync(join(root, "host-state", "ci-slots", "slot-1.lock"))).toBe(false);
  expect(existsSync(join(root, "host-state", "ci-slots", "slot-2.lock"))).toBe(false);
}, 30_000);

test("the same worktree never runs two full CI scripts simultaneously", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-worktree-"));
  dirs.push(root);
  const order = join(root, "order");
  const first = runScoped(root, "same", `echo first-start >> "${order}"; sleep 2; echo first-end >> "${order}"`);
  await Bun.sleep(350);
  const second = runScoped(root, "same", `echo second >> "${order}"`);
  expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
  expect(readFileSync(order, "utf8").trim().split("\n")).toEqual(["first-start", "first-end", "second"]);
  expect(await new Response(second.stderr).text()).toContain("ci lock: waiting for pid=");
}, 20_000);

test("a live pre-migration global CI counts toward two-slot host capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-legacy-"));
  dirs.push(root);
  const legacy = join(root, "host-state", "ci.lock");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "owner"), `pid=${process.pid}\ndir=${join(root, "legacy-worktree")}\n`);
  const first = runScoped(root, "new-one", "sleep 2");
  await Bun.sleep(500);
  const second = runScoped(root, "new-two", "echo should-not-run", "0");
  expect(await second.exited).toBe(1);
  expect(await new Response(second.stderr).text()).toContain("parallel limit reached");
  expect(await first.exited).toBe(0);
}, 20_000);

test("a live legacy CI blocks reentry into its exact worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-legacy-same-"));
  dirs.push(root);
  const cwd = join(root, "same");
  mkdirSync(cwd);
  const legacy = join(root, "host-state", "ci.lock");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "owner"), `pid=${process.pid}\ndir=${cwd}\n`);
  const attempt = runScoped(root, "same", "echo should-not-run", "0");
  expect(await attempt.exited).toBe(1);
  expect(await new Response(attempt.stderr).text()).toContain("same worktree has a legacy running CI");
}, 20_000);

function worktreeLock(root: string, name: string) {
  const cwd = realpathSync(join(root, name));
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  return join(root, "host-state", "ci-worktrees", `${key}.lock`);
}

test("regression: a live high-numbered slot plus a legacy runner never permits slot one", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-overadmission-"));
  dirs.push(root);
  const legacy = join(root, "host-state", "ci.lock");
  const slots = join(root, "host-state", "ci-slots");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(slots, { recursive: true });
  writeFileSync(join(legacy, "owner"), `pid=${process.pid}\ndir=${join(root, "legacy")}\n`);
  const slotTwo = join(slots, "slot-2.lock");
  writeFileSync(slotTwo, `pid=${process.pid}\ndir=${join(root, "other")}\ntoken=owned\n`);
  const blocked = runScoped(root, "candidate", "echo FORBIDDEN", "0");
  expect(await blocked.exited).toBe(1);
  expect(await new Response(blocked.stdout).text()).not.toContain("FORBIDDEN");
  expect(existsSync(join(slots, "slot-1.lock"))).toBe(false);
  expect(readFileSync(slotTwo, "utf8")).toContain("token=owned");
});

test("an unmanaged legacy runner is conservatively reserved until cutover is verified", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-legacy-reserve-"));
  dirs.push(root);
  const first = runScoped(root, "first", "sleep 2", "15", { AGENTES_CI_LEGACY_EXCLUDED: "0" });
  await Bun.sleep(450);
  const next = runScoped(root, "second", "echo FORBIDDEN", "0", { AGENTES_CI_LEGACY_EXCLUDED: "0" });
  expect(await next.exited).toBe(1);
  expect(await new Response(next.stdout).text()).not.toContain("FORBIDDEN");
  expect(await new Response(next.stderr).text()).toContain("reserved=1");
  expect(await first.exited).toBe(0);
}, 15_000);

test("an atomically recorded dead lock is reclaimed; an active slot is never removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-dead-atomic-"));
  dirs.push(root);
  mkdirSync(join(root, "target"), { recursive: true });
  const lock = worktreeLock(root, "target");
  const slots = join(root, "host-state", "ci-slots");
  mkdirSync(join(root, "host-state", "ci-worktrees"), { recursive: true });
  mkdirSync(slots, { recursive: true });
  writeFileSync(lock, `pid=999999\ndir=${realpathSync(join(root, "target"))}\ntoken=old\n`);
  writeFileSync(join(slots, "slot-1.lock"), "pid=999999\ndir=old\ntoken=old\n");
  const p = runScoped(root, "target", "echo RECOVERED");
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toContain("RECOVERED");
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(join(slots, "slot-1.lock"))).toBe(false);
});

test("unknown owner records fail closed without deleting any unverified lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-unknown-owner-"));
  dirs.push(root);
  mkdirSync(join(root, "candidate"), { recursive: true });
  const lock = worktreeLock(root, "candidate");
  mkdirSync(join(root, "host-state", "ci-worktrees"), { recursive: true });
  writeFileSync(lock, "nonstandard data: do not delete\n");
  const p = runScoped(root, "candidate", "echo FORBIDDEN", "0");
  expect(await p.exited).toBe(1);
  expect(readFileSync(lock, "utf8")).toBe("nonstandard data: do not delete\n");
  expect(await new Response(p.stdout).text()).not.toContain("FORBIDDEN");
});

test("an unrecognized dead-PID lock record cannot be disposed of by recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-foreign-"));
  dirs.push(root);
  mkdirSync(join(root, "candidate"), { recursive: true });
  const lock = worktreeLock(root, "candidate");
  mkdirSync(join(root, "host-state", "ci-worktrees"), { recursive: true });
  writeFileSync(lock, "pid=999999\nthis-is-foreign-file\n");
  const p = runScoped(root, "candidate", "echo FORBIDDEN", "0");
  expect(await p.exited).toBe(1);
  expect(readFileSync(lock, "utf8")).toBe("pid=999999\nthis-is-foreign-file\n");
  expect(await new Response(p.stdout).text()).not.toContain("FORBIDDEN");
});
