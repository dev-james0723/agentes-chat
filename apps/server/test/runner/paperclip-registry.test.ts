import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnerBinding, removeOwnerBinding, writeOwnerBinding } from "../../runner/paperclip-registry";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function home() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-registry-")));
  dirs.push(h);
  return h;
}
test("owner registry stores a private immutable record and reads only its exact ID", () => {
  const h = home(),
    id = randomUUID(),
    data = { version: 1, id, orgId: randomUUID() };
  writeOwnerBinding(h, id, data);
  expect(readOwnerBinding(h, id)).toEqual(data);
  expect(() => writeOwnerBinding(h, id, data)).toThrow();
  expect(() => readOwnerBinding(h, randomUUID())).toThrow();
  expect(() => readOwnerBinding(h, "../../anything")).toThrow();
  removeOwnerBinding(h, id);
  expect(() => readOwnerBinding(h, id)).toThrow();
});
test("symlink, loose permissions and untrusted home are refused", () => {
  const h = home(),
    id = randomUUID(),
    data = { version: 1, id };
  writeOwnerBinding(h, id, data);
  const file = join(h, "paperclip-projects", `${id}.json`);
  chmodSync(file, 0o644);
  expect(() => readOwnerBinding(h, id)).toThrow();
  rmSync(file);
  symlinkSync("/etc/passwd", file);
  expect(() => readOwnerBinding(h, id)).toThrow();
  rmSync(file);
  writeFileSync(file, "{}", { mode: 0o600 });
  chmodSync(h, 0o777);
  expect(() => readOwnerBinding(h, id)).toThrow();
});
