import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Memory a person deleted for good, also kept outside the database: in the files folder (`FILES_DIR`, its own
 * volume), so restoring the database from an older backup can't roll it back (A19). One JSON object per line.
 */
const FILE = "memory-deletions.jsonl";

export interface MemoryDeletion {
  itemId: string;
  orgId: string;
  deletedAt: string;
}

export async function appendMemoryDeletion(dir: string | undefined, entry: MemoryDeletion) {
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, FILE), `${JSON.stringify(entry)}\n`);
}

/** Every recorded deletion; a line that isn't one (a torn last write) is skipped. */
export async function readMemoryDeletions(dir: string | undefined): Promise<MemoryDeletion[]> {
  if (!dir) return [];
  let text: string;
  try {
    text = await readFile(join(dir, FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: MemoryDeletion[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<MemoryDeletion>;
      if (typeof e.itemId === "string" && typeof e.orgId === "string")
        out.push({ itemId: e.itemId, orgId: e.orgId, deletedAt: String(e.deletedAt ?? "") });
    } catch {
      // A torn line: the rest still counts.
    }
  }
  return out;
}
