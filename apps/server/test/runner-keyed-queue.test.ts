import { expect, test } from "bun:test";
import { KeyedQueue } from "../runner/queue";

test("the existing keyed executor overlaps independent targets and serializes a conflicting target", async () => {
  const queue = new KeyedQueue();
  const events: string[] = [];
  const aStarted = Promise.withResolvers<void>();
  const bStarted = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const first = queue.run("writer-a", async () => {
    events.push("a1:start");
    aStarted.resolve();
    await releaseA.promise;
    events.push("a1:end");
  });
  const conflict = queue.run("writer-a", async () => {
    events.push("a2:start");
  });
  const independent = queue.run("writer-b", async () => {
    events.push("b:start");
    bStarted.resolve();
  });
  await Promise.all([aStarted.promise, bStarted.promise]);
  expect(events).toEqual(["a1:start", "b:start"]);
  releaseA.resolve();
  await Promise.all([first, conflict, independent]);
  expect(events.indexOf("a2:start")).toBeGreaterThan(events.indexOf("a1:end"));
  expect(queue.busy("writer-a")).toBe(false);
});
