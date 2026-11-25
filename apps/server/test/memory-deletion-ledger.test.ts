import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemoryDeletion, readMemoryDeletions } from "../src/memory-deletion-ledger";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("deletions kept in the files folder read back in order; a torn last line is skipped", async () => {
  dir = await mkdtemp(join(tmpdir(), "memory-ledger-"));
  expect(await readMemoryDeletions(dir)).toEqual([]);
  expect(await readMemoryDeletions(undefined)).toEqual([]);
  await appendMemoryDeletion(dir, { itemId: "a", orgId: "o", deletedAt: "2026-11-19T00:00:00.000Z" });
  await appendMemoryDeletion(dir, { itemId: "b", orgId: "o", deletedAt: "2026-11-19T00:00:01.000Z" });
  await appendFile(join(dir, "memory-deletions.jsonl"), '{"itemId":"c","or');
  expect((await readMemoryDeletions(dir)).map((d) => d.itemId)).toEqual(["a", "b"]);
});
