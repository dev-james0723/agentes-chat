import { type Database, type Executor, eq, like, schema } from "@agenteschat/db";
import type { BlobStore } from "./blob";

const { blobs } = schema;
/** An org's files (`orgs/{orgId}/…`) and its logo (`org-logos/{orgId}/…`). */
const ORG_KEY = /^(?:orgs|org-logos)\/([0-9a-f-]{36})\//i;
/** A person's photo (`avatars/{userId}/…`): theirs in every org, so it belongs to none. */
const PERSON_KEY = /^avatars\/[^/]+\//;

const orgOf = (key: string) => {
  const orgId = ORG_KEY.exec(key)?.[1];
  if (orgId) return orgId;
  if (PERSON_KEY.test(key)) return null;
  throw new Error(`blob key must start with orgs/{orgId}/, org-logos/{orgId}/ or avatars/{userId}/: ${key}`);
};

/**
 * Writes one blob of the Postgres store through `db`. A caller already in a transaction passes it, so the blob
 * commits or rolls back with the rows that name it and never waits for a second connection (with a pool of one,
 * as PGlite has, it would wait forever).
 */
export async function putPostgresBlob(
  db: Executor,
  key: string,
  body: Uint8Array,
  { contentType }: { contentType: string },
) {
  const row = {
    key,
    orgId: orgOf(key),
    contentType,
    size: body.byteLength,
    content: Buffer.from(body).toString("base64"),
  };
  await db
    .insert(blobs)
    .values(row)
    .onConflictDoUpdate({
      target: blobs.key,
      set: { contentType: row.contentType, size: row.size, content: row.content },
    });
}

/**
 * Platform storage in Postgres, for deployments without a bucket. A key
 * starts with `orgs/{orgId}/` or `org-logos/{orgId}/` (the row carries that
 * org and is deleted with it) or `avatars/{userId}/` (no org); any other key
 * is refused. Can't sign URLs: downloads are streamed by the server after its
 * checks.
 */
export function createPostgresBlobStore(db: Database): BlobStore {
  return {
    kind: "postgres",
    put: (key, body, options) => putPostgresBlob(db, key, body, options),
    async get(key) {
      const [row] = await db.select().from(blobs).where(eq(blobs.key, key));
      if (!row) return null;
      return { body: new Uint8Array(Buffer.from(row.content, "base64")), contentType: row.contentType };
    },
    async delete(key) {
      await db.delete(blobs).where(eq(blobs.key, key));
    },
    async list(prefix, limit = 1000) {
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = await db
        .select({ key: blobs.key })
        .from(blobs)
        .where(like(blobs.key, `${escaped}%`))
        .orderBy(blobs.key)
        .limit(limit);
      return rows.map((r) => r.key);
    },
    async signedUrl() {
      return null;
    },
  };
}
