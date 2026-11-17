import type { SearchDocument, SearchKind } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";

/**
 * Leaf module for search builders registered while other engine modules initialize.
 * Keeping these maps outside search.ts avoids its wiki/message import cycles.
 */
export type DocumentBuilder = (db: Database, orgId: string, sourceId: string) => Promise<SearchDocument | null>;
export type ReindexSource = (db: Database, orgId: string) => Promise<string[]>;

export const builders = new Map<SearchKind, DocumentBuilder>();
export const extraSources = new Map<SearchKind, ReindexSource>();

export function registerDocumentBuilder(kind: SearchKind, builder: DocumentBuilder) {
  builders.set(kind, builder);
}

export function registerReindexSource(kind: SearchKind, source: ReindexSource) {
  extraSources.set(kind, source);
}
