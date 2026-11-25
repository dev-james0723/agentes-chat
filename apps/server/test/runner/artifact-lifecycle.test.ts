import { expect, test } from "bun:test";
import {
  type ArtifactActor,
  type ArtifactEvent,
  type ArtifactEventReceipt,
  type ClosedArtifactBroker,
  TaskArtifactLifecycle,
} from "../../runner/artifact-lifecycle";

const producer = { taskId: "task-producer", agentId: "agent-a", executionId: "execution-a" };
const reader = { taskId: "task-consumer", agentId: "agent-b", executionId: "execution-b" };
const artifactId = "scratch-1";
const checkpointId = "verified-copy-1";

function event<T extends ArtifactEvent["type"]>(type: T, eventId: string) {
  return { type, eventId, artifactId, generation: 1 };
}

/** Models the owner-side transaction. Only this fake owns or mutates artifact storage. */
class FakeBroker implements ClosedArtifactBroker {
  readonly actors = new Map([producer, reader].map((actor) => [actor.taskId, actor]));
  readonly store = new Map([
    [
      artifactId,
      {
        owner: producer,
        generation: 1,
        registered: false,
        closed: false,
        verified: false,
        sealed: false,
        claims: new Map<string, { executionId: string; active: boolean }>(),
      },
    ],
  ]);
  readonly receipts = new Map<string, string>();
  calls = 0;

  async record(actor: ArtifactActor, input: ArtifactEvent): Promise<ArtifactEventReceipt> {
    this.calls++;
    const item = this.store.get(input.artifactId);
    const current = this.actors.get(actor.taskId);
    if (
      !item ||
      item.generation !== input.generation ||
      current?.agentId !== actor.agentId ||
      current.executionId !== actor.executionId
    )
      return { status: "KEEP" };

    const key = `${actor.executionId}:${input.eventId}`;
    const fingerprint = JSON.stringify(input);
    const receipt = {
      status: "RECORDED" as const,
      eventId: input.eventId,
      artifactId: input.artifactId,
      generation: input.generation,
      executionId: actor.executionId,
    };
    const previous = this.receipts.get(key);
    if (previous) {
      const active = input.type !== "consumer_acquired" || item.claims.get(input.claimId)?.active;
      return previous === fingerprint && active ? receipt : { status: "KEEP" };
    }

    if (input.type === "consumer_acquired" || input.type === "consumer_released") {
      const holder = item.claims.get(input.claimId);
      // This fixture has an owner-approved grant for reader and uses generation-bound claims.
      if (!item.registered || actor.taskId !== reader.taskId) return { status: "KEEP" };
      if (input.type === "consumer_acquired") {
        if (holder) return { status: "KEEP" };
        item.claims.set(input.claimId, { executionId: actor.executionId, active: true });
      } else {
        if (!holder?.active || holder.executionId !== actor.executionId) return { status: "KEEP" };
        holder.active = false;
      }
    } else {
      if (item.owner.taskId !== actor.taskId || item.owner.executionId !== actor.executionId) return { status: "KEEP" };
      switch (input.type) {
        case "artifact_created":
          if (item.registered) return { status: "KEEP" };
          item.registered = true;
          break;
        case "write_closed":
          if (!item.registered || item.closed) return { status: "KEEP" };
          item.closed = true;
          break;
        case "checkpoint_verified":
          if (!item.closed || input.checkpointId !== checkpointId) return { status: "KEEP" };
          item.verified = true;
          break;
        case "artifact_sealed_disposable":
          if (!item.verified) return { status: "KEEP" };
          item.sealed = true;
          break;
      }
    }
    this.receipts.set(key, fingerprint);
    return receipt;
  }

  collect() {
    const item = this.store.get(artifactId);
    if (
      !item?.registered ||
      !item.closed ||
      !item.verified ||
      !item.sealed ||
      [...item.claims.values()].some((claim) => claim.active)
    )
      return false;
    return this.store.delete(artifactId);
  }
}

test("keeps sealed scratch while another AC task has a claim, until its last release", async () => {
  const broker = new FakeBroker();
  const owner = new TaskArtifactLifecycle(broker, producer);
  const consumer = new TaskArtifactLifecycle(broker, reader);
  const register = event("artifact_created", "create-1");
  const claim = { ...event("consumer_acquired", "acquire-1"), claimId: "reader-1" };
  const lease = { ...event("consumer_acquired", "acquire-2"), claimId: "lease-1" };
  const close = event("write_closed", "close-1");
  const seal = event("artifact_sealed_disposable", "seal-1");

  expect(await owner.record(register)).toMatchObject({ status: "RECORDED" });
  expect(broker.collect()).toBe(false);
  expect(await owner.record(register)).toMatchObject({ status: "RECORDED" });
  expect(await owner.record({ ...register, generation: 2 })).toEqual({ status: "KEEP" });
  expect(await owner.record({ ...close, eventId: register.eventId })).toEqual({ status: "KEEP" });
  expect(await consumer.record(claim)).toMatchObject({ status: "RECORDED" });
  expect(await consumer.record(lease)).toMatchObject({ status: "RECORDED" });
  expect(await owner.record(close)).toMatchObject({ status: "RECORDED" });
  expect(await owner.record(seal)).toEqual({ status: "KEEP" });
  expect(await owner.record({ ...event("checkpoint_verified", "verify-bad"), checkpointId: "unverified" })).toEqual({
    status: "KEEP",
  });
  expect(await owner.record({ ...event("checkpoint_verified", "verify-1"), checkpointId })).toMatchObject({
    status: "RECORDED",
  });
  expect(await owner.record({ ...seal, eventId: "seal-2" })).toMatchObject({ status: "RECORDED" });
  expect(broker.collect()).toBe(false);

  const release = { ...event("consumer_released", "release-1"), claimId: claim.claimId };
  expect(await owner.record(release)).toEqual({ status: "KEEP" });
  expect(await consumer.record(release)).toMatchObject({ status: "RECORDED" });
  expect(await consumer.record(release)).toMatchObject({ status: "RECORDED" });
  expect(await consumer.record(claim)).toEqual({ status: "KEEP" });
  expect(await consumer.record({ ...claim, eventId: "late-acquire" })).toEqual({ status: "KEEP" });
  expect(broker.collect()).toBe(false);
  expect(await consumer.record({ ...release, eventId: "release-2", claimId: lease.claimId })).toMatchObject({
    status: "RECORDED",
  });
  expect(broker.collect()).toBe(true);
  expect(broker.receipts.size).toBe(8);
  expect(broker.store.has(artifactId)).toBe(false);
});

test("checks both fences before replaying a recorded receipt", async () => {
  const broker = new FakeBroker();
  const owner = new TaskArtifactLifecycle(broker, producer);
  const register = event("artifact_created", "create-1");
  expect(await owner.record(register)).toMatchObject({ status: "RECORDED" });
  const item = broker.store.get(artifactId);
  if (!item) throw new Error("missing fake artifact");
  item.generation++;
  expect(await owner.record(register)).toEqual({ status: "KEEP" });
  broker.actors.set(producer.taskId, { ...producer, executionId: "new-execution" });
  expect(await owner.record({ ...event("write_closed", "close-1"), generation: item.generation })).toEqual({
    status: "KEEP",
  });
  expect(item.closed).toBe(false);
});

test("rejects paths, caller-selected identities and destructive operations before any broker call", async () => {
  const broker = new FakeBroker();
  const scope = new TaskArtifactLifecycle(broker, producer);
  for (const invalid of [
    { ...event("artifact_created", "create-1"), path: "/tmp/original" },
    { ...event("artifact_created", "create-1"), agentId: "agent-b" },
    { ...event("artifact_created", "create-1"), artifactId: "../original" },
    { ...event("artifact_created", "create-1"), generation: 0 },
    { ...event("artifact_created", "create-1"), type: "unlink" },
  ])
    expect(await scope.record(invalid)).toEqual({ status: "KEEP" });
  expect(broker.calls).toBe(0);
});

test("never replays an unknown effect, and a stalled broker call does not hold another task", async () => {
  let sent = 0;
  let signal: AbortSignal | undefined;
  const broker = new FakeBroker();
  const blocked = new TaskArtifactLifecycle(
    {
      record(_actor, _event, requestSignal) {
        sent++;
        signal = requestSignal;
        return new Promise(() => {});
      },
    },
    reader,
  );
  const acquire = blocked.record({ ...event("consumer_acquired", "acq-1"), claimId: "reader-1" });
  expect(await new TaskArtifactLifecycle(broker, producer).record(event("artifact_created", "create-1"))).toMatchObject(
    { status: "RECORDED" },
  );
  blocked.close();
  expect(await acquire).toEqual({ status: "KEEP" });
  expect(signal?.aborted).toBe(true);
  expect(await blocked.record(event("write_closed", "close-1"))).toEqual({ status: "KEEP" });
  expect(sent).toBe(1);
});

test("fails closed for a rejected transport or a receipt for a different event", async () => {
  for (const record of [
    async () => {
      throw new Error("unknown effect");
    },
    async () => ({
      status: "RECORDED" as const,
      eventId: "another-event",
      artifactId,
      generation: 1,
      executionId: producer.executionId,
    }),
  ]) {
    let sent = 0;
    const scope = new TaskArtifactLifecycle(
      {
        record: () => {
          sent++;
          return record();
        },
      },
      producer,
    );
    expect(await scope.record(event("artifact_created", "create-1"))).toEqual({ status: "KEEP" });
    expect(await scope.record(event("write_closed", "close-1"))).toEqual({ status: "KEEP" });
    expect(sent).toBe(1);
  }
});

test("bounds outstanding work and stops submitting after a deadline", async () => {
  let sent = 0;
  const scope = new TaskArtifactLifecycle(
    {
      record() {
        sent++;
        return new Promise(() => {});
      },
    },
    producer,
  );
  const pending = Array.from({ length: 16 }, (_, index) => scope.record(event("artifact_created", `pending-${index}`)));
  expect(await scope.record(event("artifact_created", "over-capacity"))).toEqual({ status: "KEEP" });
  expect(sent).toBe(16);
  expect(await Promise.all(pending)).toEqual(Array.from({ length: 16 }, () => ({ status: "KEEP" })));
  expect(await scope.record(event("artifact_created", "after-deadline"))).toEqual({ status: "KEEP" });
  expect(sent).toBe(16);
});
