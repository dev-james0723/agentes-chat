import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_READ_PROFILE,
  CODEX_TOOLCHAINS,
  codexFolderPermissions,
  codexToolchainDirs,
  codexTurnArgs,
} from "../../runner/brain-codex";
import { grokTurnArgs } from "../../runner/brain-grok";
import { foldersEnforced, normalizeStored } from "../../runner/config";
import { configFromGrant } from "../../runner/daemon";
import { claudePermissionSettings } from "../../runner/mcp";

// The machine's folder allow-list enforced by each CLI itself (`readsOnlyInFolders`): off unless the owner turns it on.

test("config: readsOnlyInFolders is kept only when true, and survives pairing again", () => {
  expect(normalizeStored({ readsOnlyInFolders: true })).toEqual({ readsOnlyInFolders: true });
  expect(normalizeStored({ readsOnlyInFolders: "yes" })).toEqual({});
  expect(normalizeStored({})).toEqual({});
  // ADR 0205: the owner's explicit `false` is kept too (the one way to turn the allow-list off).
  expect(normalizeStored({ readsOnlyInFolders: false })).toEqual({ readsOnlyInFolders: false });
  const again = configFromGrant(
    { readsOnlyInFolders: true },
    {
      server: "https://example.test",
      grant: {
        machineId: "m1",
        token: "agm_x",
        org: { id: "o1", name: "O" },
      } as unknown as Parameters<typeof configFromGrant>[1]["grant"],
      workspace: "/w",
      tools: { claude: true, codex: true, commands: true },
      desktop: false,
    },
  );
  expect(again.readsOnlyInFolders).toBe(true);
  const off = configFromGrant(
    { readsOnlyInFolders: false },
    {
      server: "https://example.test",
      grant: { machineId: "m1", token: "agm_x", org: { id: "o1", name: "O" } } as unknown as Parameters<
        typeof configFromGrant
      >[1]["grant"],
      workspace: "/w",
      tools: { claude: true, codex: true, commands: true },
      desktop: false,
    },
  );
  expect(off.readsOnlyInFolders).toBe(false);
});

test("ADR 0205: the allow-list is in force unless the owner turned it off", () => {
  expect(foldersEnforced({})).toBe(true);
  expect(foldersEnforced({ readsOnlyInFolders: true })).toBe(true);
  expect(foldersEnforced({ readsOnlyInFolders: false })).toBe(false);
});

test("Claude Code: with the allow-list, its file tools also refuse writes outside its working directories", () => {
  for (const mode of ["work", "plan"] as const) {
    const on = claudePermissionSettings(mode, [], undefined, { promptReads: true, readsOnlyInFolders: true });
    expect(on.permissions).toMatchObject({
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    });
    const off = claudePermissionSettings(mode, [], undefined, { promptReads: true });
    expect("blockWritesOutsideWorkingDirectories" in off.permissions).toBe(false);
  }
});

test("Claude Code: file-tool reads outside the working directories are blocked only when asked", () => {
  for (const mode of ["work", "plan", "chat"] as const) {
    const on = claudePermissionSettings(mode, [], undefined, { promptReads: true, readsOnlyInFolders: true });
    expect(on.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: true });
    const off = claudePermissionSettings(mode, [], undefined, { promptReads: true });
    expect("blockReadsOutsideWorkingDirectories" in off.permissions).toBe(false);
  }
  const asks = claudePermissionSettings("work", [], undefined, { asksFirst: true, readsOnlyInFolders: true });
  expect(asks.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: true });
});

test("Codex: a permission profile reads the system, hides the homes and volumes, opens the agent's folders", () => {
  const work = codexFolderPermissions({
    profile: "work",
    cwd: "/Users/a/ws/agent",
    roots: ["/Users/a/ws/agent", "/Users/a/shared"],
    readable: ["/Users/a/.codex/packages/standalone/releases/1/bin"],
    platform: "darwin",
  });
  expect(work[0]).toBe(`default_permissions="${CODEX_READ_PROFILE}"`);
  const fs = work[1] as string;
  expect(fs.startsWith(`permissions.${CODEX_READ_PROFILE}.filesystem={`)).toBe(true);
  expect(fs).toContain('":root"="read"');
  expect(fs).toContain('"/Users"="none"');
  expect(fs).toContain('"/Volumes"="none"');
  expect(fs).toContain('":tmpdir"="write"');
  expect(fs).toContain('":slash_tmp"="write"');
  expect(fs).toContain('"/Users/a/ws/agent"="write"');
  expect(fs).toContain('"/Users/a/shared"="write"');
  expect(fs).toContain('"/Users/a/.codex/packages/standalone/releases/1/bin"="read"');
  // The agent's folder appears once.
  expect(fs.split('"/Users/a/ws/agent"').length).toBe(2);
  // A plan turn writes nowhere: its folders are read, temp is not opened for writing.
  const plan = codexFolderPermissions({ profile: "plan", cwd: "/Users/a/ws/agent", roots: [], platform: "darwin" })[1];
  expect(plan).toContain('"/Users/a/ws/agent"="read"');
  expect(plan).not.toContain('"write"');
  // Linux hides its homes and mounts instead.
  const linux = codexFolderPermissions({ profile: "work", cwd: "/home/a/w", roots: [], platform: "linux" })[1];
  expect(linux).toContain('"/home"="none"');
  expect(linux).not.toContain('"/Users"');
});

test("Codex: with the profile, the turn names no legacy sandbox; without it, nothing changes", () => {
  const base = { cwd: "/Users/a/ws/agent", lastFile: "/tmp/last", runId: "run-1", writableRoots: ["/Users/a/shared"] };
  const off = codexTurnArgs(base);
  expect(off).toContain("--sandbox");
  expect(off.some((a) => a.startsWith("default_permissions="))).toBe(false);
  const on = codexTurnArgs({ ...base, readable: ["/opt/codex/bin"], readsOnlyInFolders: true });
  expect(on).not.toContain("--sandbox");
  expect(on.some((a) => a.startsWith("sandbox_workspace_write."))).toBe(false);
  expect(on).toContain(`default_permissions="${CODEX_READ_PROFILE}"`);
  const fs = on.find((a) => a.startsWith(`permissions.${CODEX_READ_PROFILE}.filesystem=`)) ?? "";
  expect(fs).toContain('"/Users/a/ws/agent"="write"');
  expect(fs).toContain('"/Users/a/shared"="write"');
  expect(fs).toContain('"/opt/codex/bin"="read"');
  // A chat turn keeps its own read-only, config-less flags: the profile is for plan and work turns.
  const chat = codexTurnArgs({ ...base, chat: true, readsOnlyInFolders: true });
  expect(chat).toContain("--sandbox");
});

test("Grok Build: the strict profile (reads the working folder and system paths only) when asked", () => {
  const off = grokTurnArgs({ prompt: "hi" });
  expect(off[off.indexOf("--sandbox") + 1]).toBe("workspace");
  for (const profile of ["work", "plan"] as const) {
    const on = grokTurnArgs({ prompt: "hi", profile, readsOnlyInFolders: true });
    expect(on[on.indexOf("--sandbox") + 1]).toBe("strict");
  }
});

test("Codex: the fixed toolchain folders that exist are read (never written); nothing else of the home is", () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codex-tools-")));
  try {
    for (const d of [".bun/bin", ".cargo/bin", ".nvm", "Documents"]) mkdirSync(path.join(home, d), { recursive: true });
    const dirs = codexToolchainDirs(home, "darwin");
    expect(dirs).toEqual([".bun", ".cargo", ".nvm"].map((d) => path.join(home, d)));
    expect(dirs.some((d) => d.endsWith("Documents"))).toBe(false);
    // Only names from the fixed list, all inside the home or Homebrew.
    expect(CODEX_TOOLCHAINS).toEqual([".bun", ".cargo", ".rustup", ".nvm", ".local/bin"]);
    const fs = codexFolderPermissions({ profile: "work", cwd: "/Users/a/ws/agent", roots: [], readable: dirs })[1];
    for (const d of dirs) expect(fs).toContain(`${JSON.stringify(d)}="read"`);
    expect(fs).not.toContain(`${JSON.stringify(path.join(home, ".bun"))}="write"`);
    // Linux's Homebrew lives under /home, which the profile hides: it is on the list there.
    expect(codexToolchainDirs(home, "linux", (p) => p === "/home/linuxbrew/.linuxbrew")).toContain(
      "/home/linuxbrew/.linuxbrew",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const codexBin = (() => {
  if (process.platform !== "darwin") return null;
  const found = spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).stdout.trim();
  try {
    return found ? realpathSync(found) : null;
  } catch {
    return null;
  }
})();

// A live check of the profile in Codex's own Seatbelt sandbox, no model: only where Codex is installed (a Mac).
test.if(Boolean(codexBin))(
  "Codex (live sandbox): a toolchain in the home runs, its folder isn't written, a file outside the list is refused",
  () => {
    const home = realpathSync(mkdtempSync(path.join(os.homedir(), ".codex-tools-live-")));
    try {
      const agent = path.join(home, "ws", "agent");
      mkdirSync(agent, { recursive: true });
      mkdirSync(path.join(home, ".bun", "bin"), { recursive: true });
      const tool = path.join(home, ".bun", "bin", "tool");
      writeFileSync(tool, "#!/bin/sh\necho TOOL_OK\n");
      chmodSync(tool, 0o755);
      writeFileSync(path.join(home, "private.txt"), "SECRET");
      const readable = [path.dirname(codexBin as string), ...codexToolchainDirs(home, "darwin")];
      const cfg = codexFolderPermissions({ profile: "work", cwd: agent, roots: [], readable });
      const run = (cmd: string) =>
        spawnSync(codexBin as string, ["sandbox", ...cfg.flatMap((c) => ["-c", c]), "--", "sh", "-c", cmd], {
          cwd: agent,
          encoding: "utf8",
        });
      const ran = run(tool);
      expect(ran.stdout).toContain("TOOL_OK");
      expect(run(`cat ${path.join(home, "private.txt")}`).status).not.toBe(0);
      expect(run(`echo x > ${path.join(home, ".bun", "planted")}`).status).not.toBe(0);
      expect(run("echo ok > own.txt && cat own.txt").stdout).toContain("ok");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);
