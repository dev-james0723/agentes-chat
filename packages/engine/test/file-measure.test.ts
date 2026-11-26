import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, schema } from "@agenteschat/db";
import { MEASURE_SCRIPT, type Measured, measureCommand, parseMeasureOutput } from "../src/file-measure";
import { postPersonMessage } from "../src/messages";
import { registerFilesTool } from "../src/run-files";
import type { ToolContext } from "../src/tools/types";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close?.();
  f = undefined;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The script itself, run for real with python3 in a folder made for the test. */
describe("the computer's reading (MEASURE_SCRIPT)", () => {
  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const measure = (cwd: string, paths: string[], fileBytes = 1024 ** 3, totalBytes = 4 * 1024 ** 3) => {
    const arg = Buffer.from(JSON.stringify({ paths, fileBytes, totalBytes })).toString("base64");
    const r = spawnSync("python3", ["-I", "-c", MEASURE_SCRIPT, arg], { cwd, encoding: "utf8" });
    expect(r.status).toBe(0);
    return parseMeasureOutput(r.stdout, paths);
  };

  test.skipIf(!hasPython)("plain files get size and hash; links, folders, hidden and missing files don't", () => {
    const cwd = mkdtempSync(join(tmpdir(), "measure-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "scratch/sub"), { recursive: true });
    mkdirSync(join(cwd, ".config"));
    writeFileSync(join(cwd, "scratch/a.png"), "same bytes");
    writeFileSync(join(cwd, "scratch/b.png"), "same bytes");
    writeFileSync(join(cwd, "scratch/sub/c.md"), "other");
    writeFileSync(join(cwd, ".env"), "KEY=short");
    writeFileSync(join(cwd, ".config/app.json"), "{}");
    symlinkSync(join(cwd, "scratch/a.png"), join(cwd, "scratch/link.png"));
    symlinkSync(join(cwd, "scratch"), join(cwd, "linked-dir"));
    const got = measure(cwd, [
      "scratch/a.png",
      "scratch/b.png",
      "scratch/sub/c.md",
      "scratch/link.png",
      "linked-dir/a.png",
      "scratch/sub",
      ".env",
      ".config/app.json",
      "gone.md",
      "../escape.md",
    ]);
    expect(got.get("scratch/a.png")).toEqual({ size: 10, sha256: sha("same bytes") });
    expect(got.get("scratch/b.png")?.sha256).toBe(got.get("scratch/a.png")?.sha256);
    expect(got.get("scratch/sub/c.md")).toEqual({ size: 5, sha256: sha("other") });
    // A hidden file is sized, never hashed: its hash could give a short secret away.
    expect(got.get(".env")).toEqual({ size: 9 });
    expect(got.get(".config/app.json")).toEqual({ size: 2 });
    for (const p of ["scratch/link.png", "linked-dir/a.png", "scratch/sub", "gone.md", "../escape.md"])
      expect(got.has(p)).toBe(false);
  });

  test.skipIf(!hasPython)("over the limits a file keeps its size and goes unhashed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "measure-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "big.mp4"), "x".repeat(100));
    writeFileSync(join(cwd, "small.md"), "y".repeat(10));
    writeFileSync(join(cwd, "more.md"), "z".repeat(10));
    expect(measure(cwd, ["big.mp4", "small.md"], 50)).toEqual(
      new Map<string, Measured>([
        ["big.mp4", { size: 100 }],
        ["small.md", { size: 10, sha256: sha("y".repeat(10)) }],
      ]),
    );
    // The total stops hashing once reached.
    const capped = measure(cwd, ["small.md", "more.md"], 50, 15);
    expect(capped.get("small.md")?.sha256).toBeDefined();
    expect(capped.get("more.md")).toEqual({ size: 10 });
  });

  test("the command carries the paths as base64 only, and odd answers are dropped", () => {
    const cmd = measureCommand(["it's $(rm -rf ~)/x.md"]);
    expect(cmd.startsWith("python3 -I -c '")).toBe(true);
    expect(cmd).not.toContain("$(rm");
    const parsed = parseMeasureOutput(
      `noise\n${JSON.stringify({
        "a.md": { size: 3, sha256: sha("abc") },
        "b.md": { size: -1 },
        "c.md": { size: 2, sha256: "not-a-hash" },
        "not-asked.md": { size: 1 },
      })}`,
      ["a.md", "b.md", "c.md"],
    );
    expect([...parsed]).toEqual([
      ["a.md", { size: 3, sha256: sha("abc") }],
      ["c.md", { size: 2 }],
    ]);
    expect(parseMeasureOutput("not json", ["a.md"]).size).toBe(0);
  });
});

describe("register_files with the computer's reading", () => {
  const ctxFor = async (fx: Fixture) => {
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
    return {
      run,
      ctx: {
        db: fx.db,
        orgId: fx.org.id,
        agentId: fx.agent.id,
        runId: run.id,
        channelId: run.channelId,
        threadRootId: run.threadRootId,
        triggerMessageId: run.triggerMessageId,
      } as ToolContext,
    };
  };

  test("what the computer read wins over what the agent typed; what it couldn't read stays as given", async () => {
    f = await setup();
    const fx = f;
    const [machine] = await fx.db
      .insert(schema.machines)
      .values({ orgId: fx.org.id, name: "m", os: "darwin" } as typeof schema.machines.$inferInsert)
      .returning();
    if (!machine) throw new Error("no machine");
    const { run, ctx } = await ctxFor(fx);
    const asked: string[][] = [];
    const tool = registerFilesTool(
      fx.db,
      async () => machine.id,
      async (_c, _named, paths) => {
        asked.push(paths);
        return new Map<string, Measured>([
          ["scratch/a.png", { size: 10, sha256: sha("same bytes") }],
          ["scratch/big.mp4", { size: 9_000 }],
        ]);
      },
    );
    const out = await tool.execute(
      {
        files: [
          { path: "scratch/a.png", role: "scratch", size: 1, sha256: sha("a claim") },
          { path: "scratch//big.mp4", role: "scratch", sha256: sha("typed") },
          { path: "notes.md", role: "scratch", size: 7 },
        ],
      },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Measured 2 on the computer");
    expect(asked).toEqual([["scratch/a.png", "scratch/big.mp4", "notes.md"]]);
    const rows = await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.runId, run.id));
    const byPath = Object.fromEntries(rows.map((r) => [r.path, [r.size, r.sha256]]));
    expect(byPath).toEqual({
      "scratch/a.png": [10, sha("same bytes")],
      "scratch/big.mp4": [9_000, sha("typed")],
      "notes.md": [7, null],
    });
  });

  test("a computer that can't read registers the files anyway", async () => {
    f = await setup();
    const fx = f;
    const [machine] = await fx.db
      .insert(schema.machines)
      .values({ orgId: fx.org.id, name: "m", os: "darwin" } as typeof schema.machines.$inferInsert)
      .returning();
    if (!machine) throw new Error("no machine");
    const { run, ctx } = await ctxFor(fx);
    const tool = registerFilesTool(
      fx.db,
      async () => machine.id,
      async () => {
        throw new Error("the command policy held it");
      },
    );
    const out = await tool.execute({ files: [{ path: "a.md", role: "scratch" }] }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content).not.toContain("Measured");
    const rows = await fx.db.select().from(schema.runFiles).where(eq(schema.runFiles.runId, run.id));
    expect(rows.map((r) => [r.path, r.size, r.sha256, r.machineId])).toEqual([["a.md", null, null, machine.id]]);
  });
});
