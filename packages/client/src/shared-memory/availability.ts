import type { SharedMemoryConsumer, SharedMemorySnapshot, SharedMemoryVerification } from "./types";

type Profile = SharedMemorySnapshot["profile"];

/** Source withdrawal can change availability without changing the control revision. */
export function sameSharedMemoryRevision(first: Profile | undefined, next: Profile | undefined) {
  return (
    first?.id === next?.id &&
    first?.version === next?.version &&
    first?.availabilityRevision === next?.availabilityRevision
  );
}

/** An old retrieval receipt cannot vouch for an unavailable or not-yet-loaded native head. */
export function availableMemoryVerification(snapshot: SharedMemorySnapshot): SharedMemoryVerification {
  const verification = snapshot.verification;
  if (verification.status === "not_run") return verification;
  const available = new Set(
    snapshot.entries.filter((entry) => entry.status === "active" && entry.readable === true).map((entry) => entry.id),
  );
  if (
    !snapshot.pagination.complete ||
    verification.verifiedEntryIds.some((id) => !available.has(id)) ||
    (verification.status === "passed" && verification.verifiedEntryIds.length === 0)
  ) {
    return { ...verification, status: "not_run", verifiedEntryIds: [], missingEntryIds: [], detail: "" };
  }
  return verification;
}

/** A file receipt must bind both the content revision and the present availability digest. */
export function availableMemoryConsumerStatus(
  consumer: SharedMemoryConsumer,
  profile: Profile,
): SharedMemoryConsumer["status"] {
  if (
    consumer.kind === "file" &&
    consumer.status === "current" &&
    (!profile?.availabilityRevision ||
      consumer.revision !== profile.version ||
      consumer.availabilityRevision !== profile.availabilityRevision)
  )
    return "pending";
  return consumer.status;
}
