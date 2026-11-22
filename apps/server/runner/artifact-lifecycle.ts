/** The runner binds this identity to one live execution, independently of the artifact generation. */
export interface ArtifactActor {
  readonly taskId: string;
  readonly agentId: string;
  readonly executionId: string;
}

interface ArtifactEventKey {
  readonly eventId: string;
  readonly artifactId: string;
  readonly generation: number;
}

export type ArtifactEvent = ArtifactEventKey &
  (
    | { readonly type: "artifact_created" | "write_closed" | "artifact_sealed_disposable" }
    | { readonly type: "consumer_acquired" | "consumer_released"; readonly claimId: string }
    | { readonly type: "checkpoint_verified"; readonly checkpointId: string }
  );

const KEEP = Object.freeze({ status: "KEEP" } as const);

export type ArtifactEventReceipt =
  | typeof KEEP
  | (ArtifactEventKey & { readonly status: "RECORDED"; readonly executionId: string });

/**
 * Producer-only port for an owner-controlled broker. The broker authenticates the caller,
 * checks actor admission, the execution and artifact fences, ownership/sharing, and proof
 * in one transaction with event deduplication. A duplicate acquire returns a receipt only while
 * the original claim is held. Only the broker may authorize collection.
 * Refusals and ambiguous effects must preserve the artifact pending reconciliation.
 */
export interface ClosedArtifactBroker {
  record(actor: ArtifactActor, event: ArtifactEvent, signal: AbortSignal): Promise<ArtifactEventReceipt>;
}

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_PENDING_EVENTS = 16;
const EVENT_TIMEOUT_MS = 1_500;
const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

function parseEvent(input: unknown): ArtifactEvent | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const event = input as Record<string, unknown>;
  const { type, eventId, artifactId, generation, claimId, checkpointId } = event;
  if (
    !isId(eventId) ||
    !isId(artifactId) ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return null;
  const key = { eventId, artifactId, generation };
  const keys = ["type", "eventId", "artifactId", "generation"];
  if (type === "consumer_acquired" || type === "consumer_released") keys.push("claimId");
  if (type === "checkpoint_verified") keys.push("checkpointId");
  if (Object.keys(event).length !== keys.length || !keys.every((name) => Object.hasOwn(event, name))) return null;
  switch (type) {
    case "artifact_created":
    case "write_closed":
    case "artifact_sealed_disposable":
      return { ...key, type };
    case "consumer_acquired":
    case "consumer_released":
      return isId(claimId) ? { ...key, type, claimId } : null;
    case "checkpoint_verified":
      return isId(checkpointId) ? { ...key, type, checkpointId } : null;
    default:
      return null;
  }
}

/** An in-memory producer binding. Acquiring a claim requires a receipt before use. */
export class TaskArtifactLifecycle {
  private readonly lifetime = new AbortController();
  private readonly actor: ArtifactActor;
  private pending = 0;

  constructor(
    private readonly broker: ClosedArtifactBroker,
    actor: ArtifactActor,
    private readonly onAttempt: () => void = () => {},
  ) {
    this.actor = Object.freeze({ taskId: actor.taskId, agentId: actor.agentId, executionId: actor.executionId });
  }

  close() {
    this.lifetime.abort();
  }

  async record(input: unknown): Promise<ArtifactEventReceipt> {
    if (this.lifetime.signal.aborted || this.pending >= MAX_PENDING_EVENTS) return KEEP;
    let event: ArtifactEvent | null;
    try {
      event = parseEvent(input);
    } catch {
      return KEEP;
    }
    if (!event) return KEEP;

    try {
      this.onAttempt();
    } catch {
      // If the journal cannot persist the potential effect, do not send.
      this.close();
      return KEEP;
    }
    this.pending++;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(EVENT_TIMEOUT_MS)]);
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const receipt = await Promise.race([this.broker.record(this.actor, Object.freeze(event), signal), aborted]);
      if (!signal.aborted && receipt?.status === "KEEP") return KEEP;
      if (
        !signal.aborted &&
        receipt?.status === "RECORDED" &&
        receipt.eventId === event.eventId &&
        receipt.artifactId === event.artifactId &&
        receipt.generation === event.generation &&
        receipt.executionId === this.actor.executionId
      ) {
        return {
          status: "RECORDED",
          eventId: event.eventId,
          artifactId: event.artifactId,
          generation: event.generation,
          executionId: this.actor.executionId,
        };
      }
    } catch {
      // The broker may have received the event. Leave recovery to the owner.
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      this.pending--;
    }
    this.close();
    return KEEP;
  }
}
