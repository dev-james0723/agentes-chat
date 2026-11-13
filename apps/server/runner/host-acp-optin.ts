/** Local-only record for an explicitly enabled host-account candidate. No credential data. */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

type Binding = {
  server: string;
  orgId: string;
  machineId: string;
  mode: "user" | "system";
  platform: string;
  phones: boolean;
};
type RecordValue = {
  version: 1;
  id: string;
  uid: number;
  server: string;
  orgId: string;
  machineId: string;
  verifiedAt?: number;
};
const FILE = "host-acp-optin.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function identity(root: string, binding: Binding) {
  if (
    binding.platform !== "darwin" ||
    binding.mode !== "user" ||
    binding.phones ||
    !process.getuid ||
    process.getuid() === 0
  )
    throw new Error("Host ACP is unavailable");
  const u = new URL(binding.server);
  if (
    (u.protocol !== "https:" &&
      !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("Invalid pairing origin");
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(binding.orgId) || !/^[a-zA-Z0-9-]{8,64}$/.test(binding.machineId))
    throw new Error("Invalid pairing");
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0)
    throw new Error("Runner home must be private");
  return { uid: process.getuid(), server: u.origin, orgId: binding.orgId, machineId: binding.machineId };
}
export function createHostAcpOptIn(root: string, binding: Binding): RecordValue {
  const who = identity(root, binding);
  const record: RecordValue = { version: 1, id: randomUUID(), ...who };
  const fd = openSync(
    path.join(root, FILE),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(record) + "\n", { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
  return record;
}
export function readHostAcpOptIn(root: string, binding: Binding): RecordValue | null {
  try {
    const who = identity(root, binding);
    const fd = openSync(path.join(root, FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: any;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== who.uid || (st.mode & 0o077) !== 0 || st.size > 4096) return null;
      value = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    if (
      value?.version !== 1 ||
      typeof value.id !== "string" ||
      !UUID.test(value.id) ||
      value.uid !== who.uid ||
      value.server !== who.server ||
      value.orgId !== who.orgId ||
      value.machineId !== who.machineId
    )
      return null;
    return {
      version: 1,
      id: value.id,
      ...who,
      ...(Number.isSafeInteger(value.verifiedAt) && value.verifiedAt > 0 ? { verifiedAt: value.verifiedAt } : {}),
    };
  } catch {
    return null;
  }
}
export function removeHostAcpOptIn(root: string, binding: Binding): boolean {
  if (!readHostAcpOptIn(root, binding)) return false;
  unlinkSync(path.join(root, FILE));
  return true;
}

/** Call only after a successful local no-tools ACP prompt in the same opted-in pairing. */
function setHostAcpVerification(root: string, binding: Binding, id: string, verifiedAt?: number): RecordValue {
  const current = readHostAcpOptIn(root, binding);
  if (!current || current.id !== id) throw new Error("Host ACP opt-in changed during verification");
  const fd = openSync(path.join(root, FILE), constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== current.uid || (st.mode & 0o077) !== 0 || st.size > 4096)
      throw new Error("Invalid host ACP opt-in");
    const atOpen = JSON.parse(readFileSync(fd, "utf8"));
    if (
      atOpen.id !== id ||
      atOpen.uid !== current.uid ||
      atOpen.server !== current.server ||
      atOpen.orgId !== current.orgId ||
      atOpen.machineId !== current.machineId
    )
      throw new Error("Host ACP opt-in changed during verification");
    const { verifiedAt: _prior, ...withoutVerification } = current;
    const verified: RecordValue = { ...withoutVerification, ...(verifiedAt ? { verifiedAt } : {}) };
    ftruncateSync(fd, 0);
    // readFileSync advanced this descriptor; write at an explicit offset after truncation.
    const data = Buffer.from(JSON.stringify(verified) + "\n");
    writeSync(fd, data, 0, data.length, 0);
    return verified;
  } finally {
    closeSync(fd);
  }
}

export function markHostAcpVerified(root: string, binding: Binding, id: string): RecordValue {
  return setHostAcpVerification(root, binding, id, Date.now());
}

export function clearHostAcpVerified(root: string, binding: Binding, id: string): RecordValue {
  return setHostAcpVerification(root, binding, id);
}

/** A local verification expires even when no file changes. */
export function hostAcpVerified(value: RecordValue | null, now = Date.now()): boolean {
  return (
    !!value &&
    typeof value.verifiedAt === "number" &&
    value.verifiedAt <= now &&
    now - value.verifiedAt < 24 * 60 * 60 * 1000
  );
}
