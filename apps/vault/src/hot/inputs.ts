import type { HotCheckpointInput, HotDeleteInput, HotMoveInput } from "@mineral/core/vault-rpc";
import { isHotContentHash, isHotOperationId, isDocumentId, isDocumentEpoch } from "@mineral/sync-core/hot-protocol";
import { isCanonicalVaultPath } from "@mineral/sync-core/paths";

/**
 * Input validation for the hot checkpoint RPC surface.
 *
 * A service binding is not a trust boundary the way HTTP is, but it is still a boundary: the Gateway
 * composes these values from client input, and a malformed one must be answered rather than allowed
 * to reach R2 or the journal. The bounds are the same ones the wire protocol enforces, stated once
 * here so the Vault cannot be talked into a path it would never have accepted from a client.
 */

/** The largest Markdown snapshot a checkpoint will carry; matches the hot seed bound. */
export const MAX_HOT_MARKDOWN_BYTES = 4 << 20;

function isEtag(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 256);
}

function isMarkdown(value: unknown): value is string {
  // Byte length, not code-unit length: a CJK note is three bytes per character in UTF-8, and the bound
  // exists to protect memory, so it has to be measured in the unit the memory is spent in.
  return typeof value === "string" && new TextEncoder().encode(value).byteLength <= MAX_HOT_MARKDOWN_BYTES;
}

export function isHotCheckpointInput(value: unknown): value is HotCheckpointInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return isCanonicalVaultPath(input.canonicalPath)
    && isDocumentId(input.documentId)
    && isDocumentEpoch(input.epoch) && input.epoch >= 1
    && typeof input.documentRevision === "number" && Number.isSafeInteger(input.documentRevision) && input.documentRevision >= 1
    && isHotOperationId(input.commitId)
    && isHotContentHash(input.contentHash)
    && isMarkdown(input.markdown)
    && isEtag(input.expectedRemoteETag)
    && typeof input.replaceTombstonedRevision === "boolean";
}

export function isHotDeleteInput(value: unknown): value is HotDeleteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return isCanonicalVaultPath(input.canonicalPath)
    && isDocumentId(input.documentId)
    && isDocumentEpoch(input.epoch) && input.epoch >= 1
    && isHotOperationId(input.commitId)
    && isEtag(input.expectedRemoteETag);
}

export function isHotMoveInput(value: unknown): value is HotMoveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return isCanonicalVaultPath(input.fromPath)
    && isCanonicalVaultPath(input.toPath)
    && input.fromPath !== input.toPath
    && isDocumentId(input.documentId)
    && isDocumentEpoch(input.epoch) && input.epoch >= 1
    && typeof input.documentRevision === "number" && Number.isSafeInteger(input.documentRevision) && input.documentRevision >= 1
    && isHotOperationId(input.commitId)
    && isHotContentHash(input.contentHash)
    && isMarkdown(input.markdown)
    && typeof input.expectedFromETag === "string" && input.expectedFromETag.length > 0 && input.expectedFromETag.length <= 256;
}

export function isHotObserveInput(value: unknown): value is { canonicalPath: string; withContent?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return isCanonicalVaultPath(input.canonicalPath) && (input.withContent === undefined || typeof input.withContent === "boolean");
}
