/**
 * What `register_files` measures on the computer itself (ADR 0213): each file's size and SHA-256, so the report can
 * tell true duplicates apart and a cleanup can check the bytes it removes are the ones registered. An agent rarely
 * passes them, and a value an agent typed is a claim; the computer's reading is a fact.
 *
 * Read-only and best effort: a file it can't open plainly (a link, a folder, gone) is left unmeasured, and when the
 * computer can't run the check at all the registration still goes through as before.
 */

/** Per call: files larger than `fileBytes` get their size only, and hashing stops once `totalBytes` were read. */
export const MEASURE_LIMITS = { fileBytes: 2 * 1024 ** 3, totalBytes: 4 * 1024 ** 3, seconds: 60 } as const;

export interface Measured {
  size: number;
  sha256?: string;
}

/**
 * Python with `-I`, run in the agent's folder. Opens each path folder by folder without following a link, keeps
 * regular files only, and never hashes a hidden file or one under a hidden folder (a key or a settings file: its
 * hash could give a short secret away). Prints one JSON object, path to `{size, sha256?}`.
 */
export const MEASURE_SCRIPT = `
import base64, hashlib, json, os, stat, sys
req = json.loads(base64.b64decode(sys.argv[1]))
out = {}
total = 0
for p in req["paths"]:
    parts = p.split("/")
    if not parts or any(x in ("", ".", "..") for x in parts):
        continue
    fd = f = None
    try:
        fd = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
        for d in parts[:-1]:
            nfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nfd
        f = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0), dir_fd=fd)
        st = os.fstat(f)
        if not stat.S_ISREG(st.st_mode):
            continue
        entry = {"size": st.st_size}
        hidden = any(x.startswith(".") for x in parts)
        if not hidden and st.st_size <= req["fileBytes"] and total + st.st_size <= req["totalBytes"]:
            h = hashlib.sha256()
            while True:
                b = os.read(f, 1 << 20)
                if not b:
                    break
                h.update(b)
            total += st.st_size
            if os.fstat(f).st_size == st.st_size:
                entry["sha256"] = h.hexdigest()
        out[p] = entry
    except OSError:
        pass
    finally:
        if f is not None:
            os.close(f)
        if fd is not None:
            os.close(fd)
print(json.dumps(out))
`;

/** The command for a POSIX shell: the paths go as one base64 argument, so the shell sees nothing an agent chose. */
export function measureCommand(paths: string[]) {
  const payload = { paths, fileBytes: MEASURE_LIMITS.fileBytes, totalBytes: MEASURE_LIMITS.totalBytes };
  const arg = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `python3 -I -c '${MEASURE_SCRIPT.replace(/'/g, `'\\''`)}' ${arg}`;
}

/** The script's answer, keeping only well-formed entries for the paths asked about. */
export function parseMeasureOutput(stdout: string, paths: string[]): Map<string, Measured> {
  const found = new Map<string, Measured>();
  const line = stdout.trim().split("\n").pop() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return found;
  }
  if (!parsed || typeof parsed !== "object") return found;
  const asked = new Set(paths);
  for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!asked.has(path) || !value || typeof value !== "object") continue;
    const { size, sha256 } = value as { size?: unknown; sha256?: unknown };
    if (!Number.isSafeInteger(size) || (size as number) < 0) continue;
    found.set(path, {
      size: size as number,
      ...(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) ? { sha256 } : {}),
    });
  }
  return found;
}
