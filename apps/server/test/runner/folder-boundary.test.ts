import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FOLDER_BOUNDARY_REFUSAL, outsideFolders } from "../../runner/folder-boundary";
import { claudeMcpConfig, mcpScopeFromEnv, permissionPrompt } from "../../runner/mcp";

// The machine's folder allow-list at the runner's own boundary (ADR 0205): every call Claude Code asks our prompt
// tool about is refused when it names a path in people's files outside the agent's folders, read or write, a link
// that leads out included. Negative controls first; allowed work must still pass.

const posix = process.platform !== "win32";
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "folder-boundary-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// `people` stands for /Users (or /home): the root where people's files live. Temp is not opened for these tests.
const people = path.join(root, "Users");
const agent = path.join(people, "ws", "dev");
const granted = path.join(people, "shared");
const outside = path.join(people, "other");
for (const d of [agent, granted, outside]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(agent, "a.txt"), "mine");
writeFileSync(path.join(granted, "g.txt"), "granted");
writeFileSync(path.join(outside, "secret.txt"), "not yours");
if (posix) {
  symlinkSync(path.join(outside, "secret.txt"), path.join(agent, "link.txt"));
  symlinkSync(outside, path.join(agent, "linkdir"));
}

const scope = (confined: string[]) => ({ cwd: agent, folders: [agent], home: path.join(people, "me"), confined });
const opts = { privateRoots: [people], tempRoots: [] as string[] };
const check = (tool: string, input: Record<string, unknown>, confined = [agent, granted]) =>
  outsideFolders(tool, input, scope(confined), opts);

test("negative: a file tool reading or writing outside the allowed folders is refused", () => {
  expect(check("Read", { file_path: path.join(outside, "secret.txt") })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Grep", { pattern: "x", path: outside })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Glob", { pattern: `${outside}/**` })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Write", { file_path: path.join(outside, "new.txt"), content: "x" })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Edit", { file_path: path.join(outside, "secret.txt") })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Read", { file_path: "../other/secret.txt" })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Read", { file_path: "~/notes.txt" })).toContain(FOLDER_BOUNDARY_REFUSAL);
});

test("negative: a shell command naming a path outside, to read or to write, is refused", () => {
  for (const command of [
    `cat ${path.join(outside, "secret.txt")}`,
    "cat ../other/secret.txt",
    "head -n 1 ../../other/secret.txt",
    `cp a.txt ${path.join(outside, "copy.txt")}`,
    "echo hi > ../other/planted.txt",
    `grep -r key --include=x ${outside}`,
    `python3 tool.py --input=${path.join(outside, "secret.txt")}`,
    "cat ~/Documents/private.txt",
    // Unparsable lines (variables, substitution) that point at a home or an outside path are refused too.
    "cat $HOME/.zsh_history",
    `cat "$(echo ${outside})/secret.txt"`,
  ]) {
    expect({ command, why: check("Bash", { command }) }).toEqual({
      command,
      why: expect.stringContaining(FOLDER_BOUNDARY_REFUSAL),
    });
  }
});

test.if(posix)("negative: a link inside the folder that leads outside is refused (symlink escape)", () => {
  expect(check("Read", { file_path: path.join(agent, "link.txt") })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Read", { file_path: "linkdir/secret.txt" })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Bash", { command: "cat link.txt" })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Bash", { command: "ls linkdir" })).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Write", { file_path: "linkdir/planted.txt" })).toContain(FOLDER_BOUNDARY_REFUSAL);
});

test("positive: work in the agent's folder, a granted folder and system paths goes on", () => {
  expect(check("Read", { file_path: path.join(agent, "a.txt") })).toBeNull();
  expect(check("Read", { file_path: "a.txt" })).toBeNull();
  expect(check("Read", { file_path: path.join(granted, "g.txt") })).toBeNull();
  expect(check("Write", { file_path: path.join(agent, "new.txt") })).toBeNull();
  expect(check("Edit", { file_path: path.join(granted, "g.txt") })).toBeNull();
  for (const command of [
    "cat a.txt",
    "ls",
    "git status",
    "git log --oneline origin/main",
    `cat ${path.join(granted, "g.txt")}`,
    "ls /usr/bin",
    "cat /etc/hosts",
    "bun test src/x.test.ts",
    "curl -s https://example.com/a/b",
    "echo done > out.txt",
  ]) {
    expect({ command, why: check("Bash", { command }) }).toEqual({ command, why: null });
  }
  // Tools that name no path pass.
  expect(check("WebFetch", { url: "https://example.com" })).toBeNull();
});

test("revocation: a folder taken back is refused on the very next call", () => {
  const read = { file_path: path.join(granted, "g.txt") };
  expect(check("Read", read, [agent, granted])).toBeNull();
  expect(check("Read", read, [agent])).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(check("Bash", { command: `cat ${path.join(granted, "g.txt")}` }, [agent])).toContain(FOLDER_BOUNDARY_REFUSAL);
});

test("the prompt tool refuses before anyone is asked, and before plain reads are allowed", async () => {
  let asked = 0;
  const call = async () => {
    asked++;
    return { ok: true as const, text: JSON.stringify({ behavior: "allow" }) };
  };
  const out = await permissionPrompt({ tool_name: "Bash", input: { command: "cat ../other/secret.txt" } }, call, {
    scope: scope([agent]),
    boundary: opts,
  });
  expect(out).toMatchObject({ behavior: "deny" });
  expect((out as { message: string }).message).toContain(FOLDER_BOUNDARY_REFUSAL);
  expect(asked).toBe(0);
  // A plain read inside is still allowed at once, with nobody asked.
  const ok = await permissionPrompt({ tool_name: "Bash", input: { command: "cat a.txt" } }, call, {
    scope: scope([agent]),
    boundary: opts,
  });
  expect(ok).toMatchObject({ behavior: "allow" });
  expect(asked).toBe(0);
  // Without the allow-list in force (the owner turned it off), the same read is allowed as before.
  const off = await permissionPrompt({ tool_name: "Bash", input: { command: "cat ../other/secret.txt" } }, call, {
    scope: { cwd: agent, folders: [agent] },
  });
  expect(off).toMatchObject({ behavior: "allow" });
});

test("our MCP process learns the allow-list from its config, and nothing when it is off", () => {
  const base = { command: ["agentes-runner", "mcp"], taskId: "t", socketPath: "/s", token: "k", cwd: agent };
  const on = claudeMcpConfig({ ...base, folders: [agent], confined: [agent, granted] });
  const env = (on.mcpServers as Record<string, { env: NodeJS.ProcessEnv }>).agentes?.env ?? {};
  expect(mcpScopeFromEnv(env)?.confined).toEqual([agent, granted]);
  const off = claudeMcpConfig({ ...base, folders: [agent] });
  const offEnv = (off.mcpServers as Record<string, { env: NodeJS.ProcessEnv }>).agentes?.env ?? {};
  expect(mcpScopeFromEnv(offEnv)?.confined).toBeUndefined();
});
