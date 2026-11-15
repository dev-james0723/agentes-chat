/** Local owner control only; do not expose a generic file reader/writer to the machine RPC. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (): never => {
  throw new Error("owner registry refused");
};
function safeHome(home: string) {
  const uid = process.getuid?.();
  if (uid === undefined || !path.isAbsolute(home)) return fail();
  const dir = path.resolve(home);
  for (let at = dir; ; at = path.dirname(at)) {
    const st = lstatSync(at),
      sticky = at !== dir && st.uid === 0 && (st.mode & 0o1000) !== 0;
    if (
      st.isSymbolicLink() ||
      !st.isDirectory() ||
      (st.uid !== 0 && st.uid !== uid) ||
      ((st.mode & 0o022) !== 0 && !sticky)
    )
      return fail();
    if (at === dir && (st.uid !== uid || (st.mode & 0o077) !== 0)) return fail();
    if (at === path.dirname(at)) break;
  }
  return dir;
}
function registry(home: string, create: boolean) {
  const dir = path.join(safeHome(home), "paperclip-projects");
  if (create)
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    return fail();
  return dir;
}
function file(home: string, id: string, create = false) {
  if (!uuid.test(id)) return fail();
  return path.join(registry(home, create), `${id}.json`);
}
export function writeOwnerBinding(home: string, id: string, value: unknown) {
  if (typeof value !== "object" || value === null || (value as { id?: unknown }).id !== id) return fail();
  const destination = file(home, id, true),
    tmp = path.join(path.dirname(destination), `.${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 256 * 1024) return fail();
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // A new UUID only: never silently replace an existing approved binding.
    linkSync(tmp, destination);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
export function readOwnerBinding(home: string, id: string): unknown {
  const dest = file(home, id),
    fd = openSync(dest, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 256 * 1024) return fail();
    const obj = JSON.parse(readFileSync(fd, "utf8"));
    if (!obj || typeof obj !== "object" || obj.id !== id) return fail();
    return obj;
  } finally {
    closeSync(fd);
  }
}
/** Local owner revocation. An outstanding proof re-reads this file before use. */
export function removeOwnerBinding(home: string, id: string): void {
  readOwnerBinding(home, id);
  unlinkSync(file(home, id));
}
