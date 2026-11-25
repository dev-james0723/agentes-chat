/**
 * What to do with one registered file now (ADR 0213): a pure, deterministic function of facts the registry holds.
 * No model takes part, and no fact here is a file's own word about itself. The rules run in a fixed order and the
 * first that applies decides; protection comes first and nothing later (storage pressure included) undoes it.
 *
 * Only one outcome removes anything: `DELETE`, for a `scratch` or `derived` file whose writer sealed it, that no
 * reader or later stage holds, inside a folder a person authorized on a known macOS or Linux computer, with the
 * collector switched on. Even then the computer checks the file again before it goes (`CLEANUP_SCRIPT`).
 */

export const STORAGE_ACTIONS = [
  "KEEP",
  "PROTECT",
  "RELEASE",
  "DELETE",
  "DEFER",
  "REVIEW",
  "ARCHIVE",
  "RELOCATE",
] as const;
export type StorageAction = (typeof STORAGE_ACTIONS)[number];

export const LIFECYCLE_STATES = [
  "created",
  "writing",
  "sealed",
  "released",
  "reserved",
  "deleted",
  "review",
  "protected",
  "kept",
  "archived",
  "relocated",
  "failed",
  "unknown",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export type PressureLevel = "ok" | "low" | "critical" | "unknown";
/** How hard the collector works (ADR 0213 §12). Never how much it protects. */
export type GcMode = "normal" | "elevated" | "critical" | "performance";

export interface ArtifactFacts {
  role: string;
  path: string;
  state: LifecycleState | string;
  /** Its writer sealed it (`file_lifecycle` seal). */
  sealed: boolean;
  /** Seconds since it was sealed (null when not sealed). */
  sealedAgeSeconds: number | null;
  openWriters: number;
  openReaders: number;
  /** A later stage of some work declared it needs this file. */
  futureStages: number;
  /** Leases whose heartbeat stopped without a release: nothing is known about those holders. */
  expiredLeases: number;
  /** Another registration of the same file (any run, same computer) calls it a deliverable, evidence or unknown. */
  otherRegistrationKeeps: boolean;
  /** Other registrations of the same file that are pinned, decided, under review, reserved or still being written. */
  siblingBlocks: number;
  /** A person kept or protected it in review, or it waits there. */
  review: "none" | "open" | "kept" | "protected" | "delete" | "archive";
  machineKnown: boolean;
  machinePosix: boolean;
  /** The authorized folder it lies in, if any. */
  scope: { mode: "shadow" | "enforce" } | null;
  collectorEnabled: boolean;
  pressure: PressureLevel;
}

export interface Decision {
  action: StorageAction;
  /** A stable code for receipts and tests. */
  code: string;
  reason: string;
  /** A move a person may choose in review; never done by the collector itself. */
  suggestion?: "relocate" | "archive";
}

/** Seconds a sealed file rests before the collector may take it (its last bytes settle; a late writer shows up). */
export const SETTLE_SECONDS = 60;

const DENY_PARTS = new Set([
  ".git",
  "node_modules",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config",
  ".password-store",
  // Caches and live build state (§E): their own tools invalidate them, never this collector.
  "deriveddata",
  "coresimulator",
  ".build",
  ".next",
  ".gradle",
  ".cache",
  "library",
]);
const DENY_EXT =
  /\.(sqlite3?|db|qcow2|vmdk|vdi|img|dmg|iso|raw|bak|backup|pem|key|p12|pfx|kdbx|keychain(-db)?|env|age|gpg|xcarchive|ipa|app|swift|ts|tsx|js|py|go|rs|c|h|m|java|kt)$/i;
const DENY_WORDS = /(backup|secret|credential|password|token|id_rsa|id_ed25519|id_ecdsa|\.git)/i;

/** A path the collector never touches, whatever any registration says (mirrors `CLEANUP_SCRIPT`'s refusals). */
export function protectedPath(path: string): string | null {
  const parts = path.split("/");
  if (path.startsWith("/") || parts.includes("..") || parts.includes("") || parts.includes("."))
    return "not a plain path inside the workspace";
  for (const p of parts) {
    const low = p.toLowerCase();
    if (DENY_PARTS.has(low) || low.startsWith(".git")) return "inside a protected folder (keys, settings, Git, caches)";
  }
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (name.startsWith(".")) return "a hidden file";
  if (DENY_EXT.test(name)) return "source code, a database, disk image, key or backup by its name";
  if (DENY_WORDS.test(name)) return "a backup, secret or key by its name";
  return null;
}

/** The collector's mode from the disk and whether a person asked it to stay out of the way (§12). */
export function gcMode(pressure: PressureLevel, override?: string | null): GcMode {
  if (override === "performance") return "performance";
  if (pressure === "critical") return "critical";
  if (pressure === "low") return "elevated";
  return "normal";
}

/** A cycle's budget per mode: few files, low priority, short; more only when the disk needs it. */
export function gcBudget(mode: GcMode) {
  switch (mode) {
    case "performance":
      return { files: 10, bytes: 64 * 1024 ** 2, seconds: 2 };
    case "elevated":
      return { files: 100, bytes: 1024 ** 3, seconds: 10 };
    case "critical":
      return { files: 200, bytes: 2 * 1024 ** 3, seconds: 20 };
    default:
      return { files: 50, bytes: 256 * 1024 ** 2, seconds: 5 };
  }
}

/** The decision (ADR 0213 §7). First rule that applies wins. */
export function decide(f: ArtifactFacts): Decision {
  const pathRefusal = protectedPath(f.path);
  if (pathRefusal) return { action: "PROTECT", code: "protected_path", reason: pathRefusal };
  if (f.role === "canonical" || f.role === "evidence")
    return {
      action: "PROTECT",
      code: f.role === "canonical" ? "deliverable" : "evidence",
      reason: f.role === "canonical" ? "a deliverable" : "evidence a check passed",
      ...(f.pressure === "critical" ? { suggestion: "relocate" as const } : {}),
    };
  if (f.review === "protected" || f.state === "protected")
    return { action: "PROTECT", code: "person_protected", reason: "a person protected it" };
  if (f.review === "kept" || f.state === "kept")
    return { action: "KEEP", code: "person_kept", reason: "a person kept it" };
  if (f.review === "archive")
    return { action: "ARCHIVE", code: "person_archive", reason: "a person asked to archive it" };
  if (f.review === "open")
    return {
      action: "KEEP",
      code: "review_pending",
      reason: "waiting for a person in review: never removed meanwhile",
    };
  if (f.state === "deleted" || f.state === "archived" || f.state === "relocated")
    return { action: "KEEP", code: "terminal", reason: `already ${f.state}` };
  if (f.state === "reserved")
    return { action: "DEFER", code: "reserved", reason: "a collector holds it; checked again if that claim is stale" };
  if (f.otherRegistrationKeeps)
    return { action: "PROTECT", code: "other_registration_keeps", reason: "other work calls the same file a keeper" };
  if (f.siblingBlocks > 0)
    return {
      action: "KEEP",
      code: "sibling_in_use",
      reason: "another registration of the same file is pinned, decided or still being written",
    };
  if (!f.machineKnown) return { action: "KEEP", code: "no_computer", reason: "on no known computer" };
  if (!f.machinePosix) return { action: "KEEP", code: "not_posix", reason: "only macOS and Linux are cleaned" };
  if (f.review === "delete") {
    // A person approved it in review: any role but a keeper's, still never while someone holds it.
    if (f.openWriters + f.openReaders + f.futureStages > 0)
      return { action: "KEEP", code: "in_use_after_approval", reason: "approved, but something holds it now" };
    if (!f.collectorEnabled)
      return { action: "DEFER", code: "collector_off", reason: "approved; continuous cleanup is switched off" };
    return { action: "DELETE", code: "person_approved", reason: "a person approved removing it in review" };
  }
  if (f.role !== "scratch" && f.role !== "derived")
    return { action: "REVIEW", code: "role_unknown", reason: "nobody said what it is for" };
  if (f.state === "unknown" || f.state === "failed")
    return { action: "REVIEW", code: "state_uncertain", reason: "its last outcome is unknown" };
  if (f.openWriters > 0 || !f.sealed)
    return { action: "KEEP", code: "in_use_writer", reason: "its writer has not sealed it" };
  if (f.openReaders > 0) return { action: "KEEP", code: "in_use_reader", reason: `${f.openReaders} reader(s) hold it` };
  if (f.futureStages > 0)
    return { action: "KEEP", code: "reserved_future_stage", reason: "a later stage of the work needs it" };
  if (f.expiredLeases > 0)
    return {
      action: "REVIEW",
      code: "lease_expired_uncertain",
      reason: "a holder stopped answering without releasing it; a timeout proves nothing",
    };
  // Sealed and nobody holds it: the registry can mark it released whatever happens next.
  if (!f.scope)
    return {
      action: "RELEASE",
      code: "outside_scope",
      reason: "released, but outside any folder a person authorized: removed only with a person's approval",
    };
  if (!f.collectorEnabled)
    return { action: "RELEASE", code: "collector_off", reason: "released; continuous cleanup is switched off" };
  if ((f.sealedAgeSeconds ?? 0) < SETTLE_SECONDS)
    return { action: "DEFER", code: "settling", reason: "sealed a moment ago; waits for its last bytes to settle" };
  return {
    action: "DELETE",
    code: "disposable_verified",
    reason: "scratch or rebuildable, sealed, released by every holder, inside an authorized folder",
  };
}
