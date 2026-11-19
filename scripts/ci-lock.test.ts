import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    env: { ...process.env, AGENTES_CI_LOCK: lock, AGENTES_CI_LOCK_WAIT: wait },
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
  expect(existsSync(join(lock, "owner"))).toBe(true);
  await holder.exited;
  expect(existsSync(lock)).toBe(false);
}, 30_000);

test("a run that fails still gives the lock back", async () => {
  const lock = lockPath();
  expect(await run(lock, "exit 3").exited).toBe(3);
  expect(existsSync(lock)).toBe(false);
});
