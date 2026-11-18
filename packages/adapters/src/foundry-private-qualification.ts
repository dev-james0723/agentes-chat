import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { FoundryProbeAttestation, TrustedFoundryQualificationStore } from "./foundry-executor";

/** A read-only operator authority, NOT a qualification generator. Only the
 * operator probe command may write the proof. Candidate/scorer containers get
 * no mount, credential or tool path to this file. This protects enrolled native
 * builder runs; it is not a claim against the OS owner or other privileged jobs. */
export function createPrivateFoundryQualificationStore(options: {
  filename: string;
  authorityId: string;
}): TrustedFoundryQualificationStore {
  const { filename, authorityId } = Object.freeze({ ...options });
  if (!isAbsolute(filename) || !authorityId || authorityId.length > 512)
    throw new Error("Invalid protected qualification store");
  return {
    authorityId,
    async read(identity) {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const parent = await lstat(dirname(filename));
        if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) return null;
        file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.size > 65536 ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          return null;
        const bytes = Buffer.alloc(65537);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 65536 || bytesRead !== stat.size) return null;
        const doc = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
        const p = doc.attestation as FoundryProbeAttestation;
        if (
          doc.schema !== "foundry-qualification/1" ||
          !p ||
          p.authorityId !== authorityId ||
          p.runnerId !== identity.runnerId ||
          p.runtimeDigest !== identity.runtimeDigest ||
          p.profileDigest !== identity.profileDigest
        )
          return null;
        return p;
      } catch {
        return null;
      } finally {
        await file?.close();
      }
    },
  };
}
