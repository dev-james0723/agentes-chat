import { afterEach, expect, test } from "bun:test";
import { enableCaches, TtlCache } from "../src/cache";

afterEach(() => enableCaches(false));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

for (const operation of [
  "delete",
  "deletePrefix",
  "clear",
  "remote-delete",
  "remote-deletePrefix",
  "remote-clear",
  "set",
] as const) {
  test(`a late load cannot repopulate an entry after ${operation}`, async () => {
    enableCaches();
    const cache = new TtlCache<string>(30_000);
    const held = deferred<string>();
    const pending = cache.getOrLoad("org1:key", () => held.promise);
    if (operation === "set") cache.set("org1:key", "fresh-set");
    else if (operation === "delete") cache.delete("org1:key");
    else if (operation === "deletePrefix") cache.deletePrefix("org1:");
    else if (operation === "clear") cache.clear();
    else if (operation === "remote-delete") cache.apply("delete", "org1:key");
    else if (operation === "remote-deletePrefix") cache.apply("deletePrefix", "org1:");
    else cache.apply("clear", "");
    held.resolve("old");
    // The original caller may finish its read; it cannot write that snapshot back into the current cache.
    expect(await pending).toBe("old");
    expect(cache.get("org1:key")).toBe(operation === "set" ? "fresh-set" : undefined);
    expect(await cache.getOrLoad("org1:key", async () => "fresh-load")).toBe(
      operation === "set" ? "fresh-set" : "fresh-load",
    );
  });
}

test("an invalidation fences every concurrent load of that key without evicting another key's load", async () => {
  enableCaches();
  const cache = new TtlCache<string>(30_000);
  const first = deferred<string>();
  const second = deferred<string>();
  const other = deferred<string>();
  const pending = [cache.getOrLoad("org1:key", () => first.promise), cache.getOrLoad("org1:key", () => second.promise)];
  const unrelated = cache.getOrLoad("org2:key", () => other.promise);
  cache.deletePrefix("org1:");
  expect(await cache.getOrLoad("org1:key", async () => "fresh")).toBe("fresh");
  first.resolve("old-first");
  second.resolve("old-second");
  other.resolve("unrelated");
  await Promise.all([...pending, unrelated]);
  expect(cache.get("org1:key")).toBe("fresh");
  expect(cache.get("org2:key")).toBe("unrelated");
});

test("a loader rejection still propagates and later reads can populate the cache", async () => {
  enableCaches();
  const cache = new TtlCache<string | null>(30_000);
  await expect(
    cache.getOrLoad("org:key", async () => {
      throw new Error("read failed");
    }),
  ).rejects.toThrow("read failed");
  expect(await cache.getOrLoad("org:key", async () => null)).toBeNull();
  expect(await cache.getOrLoad("org:key", async () => "must stay null")).toBeNull();
});

test("turning caching off while a read is pending prevents a late cache fill", async () => {
  enableCaches();
  const cache = new TtlCache<string>(30_000);
  const held = deferred<string>();
  const pending = cache.getOrLoad("org:key", () => held.promise);
  enableCaches(false);
  held.resolve("old");
  await pending;
  expect(cache.get("org:key")).toBeUndefined();
});
