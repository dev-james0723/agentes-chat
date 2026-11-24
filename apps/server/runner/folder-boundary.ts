import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CommandScope, simpleCommands } from "@agenteschat/adapters/command-policy";

/**
 * The machine's folder allow-list at the runner's own boundary (ADR 0205). Claude Code's file tools keep to their
 * working directories by themselves (`blockReadsOutsideWorkingDirectories`, `blockWritesOutsideWorkingDirectories`)
 * and ask our prompt tool about any shell command naming a path outside them; this is what the prompt tool answers
 * before anything else. A call is refused when a path it names, as written or once its links are followed, is in
 * people's files (the homes and volumes, `privateRoots`) but in none of the agent's folders (`confined`: its own and
 * the ones a person allowed it). System paths and temp stay readable, as in Codex's folder profile. A line we can't
 * read word by word (variables, substitutions) is refused when its text points at a home or such a path.
 *
 * `confined` is the turn's: grants are read per request, so a folder taken back is refused on the next call.
 */

/** A scope with the allow-list in force: the folders the agent may touch. */
export type BoundScope = CommandScope & { confined?: string[] };

/** The start of every refusal (tests look for it). */
export const FOLDER_BOUNDARY_REFUSAL = "This computer keeps agents inside their own folders";

/** Where people's files live, per platform: outside the allowed folders, nothing there is read or written. */
const PRIVATE_ROOTS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Users", "/Volumes"],
  linux: ["/home", "/root", "/mnt", "/media"],
};

export interface BoundaryOptions {
  /** Default: the platform's homes and volumes, and the person's home. */
  privateRoots?: string[];
  /** Default: the system's temp folders (always allowed). */
  tempRoots?: string[];
}

const caseless = process.platform === "darwin" || process.platform === "win32";
const within = (root: string, p: string) => {
  const r = caseless ? root.toLowerCase() : root;
  const t = caseless ? p.toLowerCase() : p;
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/** The real path of `p`, following links as far as the path exists (the rest kept as written). */
function realOf(p: string): string {
  let head = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...rest);
    } catch {
      const up = path.dirname(head);
      if (up === head) return p;
      rest.unshift(path.basename(head));
      head = up;
    }
  }
}

const realAll = (dirs: string[]) => [...new Set(dirs.flatMap((d) => [d, realOf(d)]))];

function tempRoots(): string[] {
  return realAll(["/tmp", "/private/tmp", os.tmpdir()]);
}

/** Paths a file tool's input names. */
const PATH_KEYS: Record<string, readonly string[]> = {
  Read: ["file_path"],
  NotebookRead: ["notebook_path"],
  LS: ["path"],
  Grep: ["path", "glob"],
  Glob: ["pattern", "path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Write: ["file_path"],
  NotebookEdit: ["notebook_path"],
};

/** Whether a word reads as a path: absolute, from a home (`~`), relative with a folder in it, or `..`. */
const pathish = (w: string) => w.startsWith("/") || w.startsWith("~") || w.includes("/") || w === "..";

/** The path parts of a shell word: itself, or the value of `--flag=value` / `-I/path`. */
function wordPaths(word: string): string[] {
  const out: string[] = [];
  if (pathish(word) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) out.push(word);
  const eq = word.indexOf("=");
  if (word.startsWith("-") && eq > 0) out.push(word.slice(eq + 1));
  else if (/^-[A-Za-z]\//.test(word)) out.push(word.slice(2));
  return out.filter((w) => pathish(w) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w));
}

/** Absolute paths, homes and home variables a line we can't parse mentions. */
function rawMentions(line: string): { paths: string[]; home: boolean } {
  const home = /(^|[^A-Za-z0-9_])(\$HOME\b|\$\{HOME\}|~[/\s"']|~$)/.test(line);
  const paths = [...line.matchAll(/(?:^|[\s'"=:(<>|;&`])(\/[^\s'"`;|&()<>$]+)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  return { paths, home };
}

/**
 * Why a call would leave the allowed folders (a refusal for the agent), or null. Only with `scope.confined`: without
 * it the owner turned the allow-list off and nothing here applies.
 */
export function outsideFolders(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: BoundScope | undefined,
  opts: BoundaryOptions = {},
): string | null {
  if (!scope?.confined || process.platform === "win32") return null;
  const home = scope.home ?? os.homedir();
  const priv = realAll(opts.privateRoots ?? [...(PRIVATE_ROOTS[process.platform] ?? []), home]);
  const allowed = realAll([...scope.confined, ...(opts.tempRoots ?? tempRoots())]);
  const resolve = (p: string) =>
    path.resolve(scope.cwd, p === "~" || p.startsWith("~/") ? path.join(home, p.slice(1)) : p);
  const outside = (p: string) => {
    const abs = resolve(p);
    return [abs, realOf(abs)].some((x) => priv.some((r) => within(r, x)) && !allowed.some((a) => within(a, x)));
  };
  const refuse = (p: string) =>
    `${FOLDER_BOUNDARY_REFUSAL} (and the folders a person allowed them): ${p} is outside them, so this call was refused. Work inside your folder; if you need that folder, ask the person in the chat to allow it for you on this computer.`;

  const keys = Object.hasOwn(PATH_KEYS, toolName) ? PATH_KEYS[toolName] : undefined;
  if (keys) {
    for (const k of keys) {
      const v = input?.[k];
      if (typeof v !== "string" || !v) continue;
      // A glob pattern is checked by the folder it starts from.
      const p = k === "pattern" || k === "glob" ? v.split(/[*?[{]/)[0] || "" : v;
      if (p && (k === "file_path" || k === "notebook_path" || k === "path" || pathish(p)) && outside(p)) {
        return refuse(v);
      }
    }
    return null;
  }
  if (toolName !== "Bash") return null;
  const command = typeof input?.command === "string" ? input.command : "";
  const cmds = simpleCommands(command);
  if (!cmds) {
    const seen = rawMentions(command);
    if (seen.home && !allowed.some((a) => within(a, home))) return refuse("your home folder");
    const p = seen.paths.find(outside);
    return p ? refuse(p) : null;
  }
  for (const s of cmds) {
    // Every word, the program included (a script outside is read to run), and every file redirected to or from. A
    // bare name is checked too: it is a file in the working folder, and may be a link that leads out.
    for (const w of [...s.argv, ...s.writes, ...s.reads]) {
      const p = [...(w.startsWith("-") ? [] : [w]), ...wordPaths(w)].find(outside);
      if (p) return refuse(p);
    }
  }
  return null;
}
