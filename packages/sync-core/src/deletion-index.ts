import { isRemoteGeneration } from "./sync-change.js";

export const DELETION_INDEX_PROTOCOL = 1;

export type IndexedDeletion = {
  path: string;
  deletedRemoteETag: string;
  committedAt: number;
  mutationSeq: number;
};

/** A stable snapshot page. `snapshotSeq` fences later mutations out of every following page. */
export type DeletionIndexPage = {
  protocol: typeof DELETION_INDEX_PROTOCOL;
  snapshotSeq: string;
  entries: IndexedDeletion[];
  nextCursor?: string;
};

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.startsWith("/") && !value.includes("\0");
}

export function isDeletionIndexPage(value: unknown): value is DeletionIndexPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as Partial<DeletionIndexPage>;
  if (page.protocol !== DELETION_INDEX_PROTOCOL || !isRemoteGeneration(page.snapshotSeq) || !Array.isArray(page.entries)) return false;
  if (page.nextCursor !== undefined && !validPath(page.nextCursor)) return false;
  return page.entries.every((entry) => entry && validPath(entry.path)
    && typeof entry.deletedRemoteETag === "string" && entry.deletedRemoteETag.length > 0 && entry.deletedRemoteETag.length <= 256
    && Number.isSafeInteger(entry.committedAt) && entry.committedAt >= 0
    && Number.isSafeInteger(entry.mutationSeq) && entry.mutationSeq > 0);
}
