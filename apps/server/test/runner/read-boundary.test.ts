import { expect, test } from "bun:test";
import { CODEX_READ_PROFILE, codexFolderPermissions, codexTurnArgs } from "../../runner/brain-codex";
import { grokTurnArgs } from "../../runner/brain-grok";
import { normalizeStored } from "../../runner/config";
import { configFromGrant } from "../../runner/daemon";
import { claudePermissionSettings } from "../../runner/mcp";

// The machine's folder allow-list enforced by each CLI itself (`readsOnlyInFolders`): off unless the owner turns it on.

test("config: readsOnlyInFolders is kept only when true, and survives pairing again", () => {
  expect(normalizeStored({ readsOnlyInFolders: true })).toEqual({ readsOnlyInFolders: true });
  expect(normalizeStored({ readsOnlyInFolders: "yes" })).toEqual({});
  expect(normalizeStored({})).toEqual({});
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
