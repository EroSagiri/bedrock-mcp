import { textContentTypeForKey } from "@mineral/core/content";
import type { HotCheckpointInput, HotCheckpointResult, HotDeleteInput, HotDeleteResult, HotMoveInput, HotMoveResult, HotPathObservation } from "@mineral/core/vault-rpc";
import { hotContentHash, type HotRemoteObservation } from "@mineral/sync-core/hot-protocol";
import { isCanonicalVaultPath, remoteObjectKey } from "@mineral/sync-core/paths";
import { encodeTombstone, parseTombstone, tombstoneKey, type RemoteTombstone } from "@mineral/sync-core/tombstones";
import { normalizeEtag } from "../mutation/ingress";

/**
 * The Vault's half of the hot checkpoint contract (Phase Hot-B).
 *
 * Everything here exists to answer one question honestly: *may this revision be written, given what
 * R2 effectively holds right now?* The Vault is the only component that can answer it, because it is
 * the only one that may read and write R2.
 *
 * Three properties are deliberate and load-bearing:
 *
 * 1. **Conditional, never last-writer-wins.** An update carries `If-Match: <expected etag>` and a
 *    create carries `If-None-Match: *`. A failed precondition is reported as a conflict; it is never
 *    retried into an overwrite.
 * 2. **Tombstone-aware.** "Effectively deleted" means *this revision* has a live tombstone. Without
 *    that check a hot room would happily resurrect a file someone else deleted, which is exactly the
 *    failure the cold path spent a design document preventing.
 * 3. **Commit identity in the object.** The commit id is written into the object's metadata, so a
 *    response lost in transit is recoverable by observation instead of by a blind rewrite: seeing our
 *    own commit id already in R2 *is* the success we never received.
 */

/** The custom-metadata key that makes a lost response recoverable. */
export const COMMIT_METADATA_KEY = "mineralCommitId";
export const DOCUMENT_METADATA_KEY = "mineralDocumentId";
export const EPOCH_METADATA_KEY = "mineralEpoch";
export const REVISION_METADATA_KEY = "mineralRevision";
export const CONTENT_HASH_METADATA_KEY = "mineralContentHash";

/** How one R2 act becomes a journal fact. Supplied by the entrypoint, which owns the recorder. */
export type HotMutationRecord = (
  input: { id: string; op: "put"; path: string; etag: string; size: number } | { id: string; op: "delete"; path: string; etag?: string },
) => Promise<{ seq: number; pending: boolean }>;

export type HotCheckpointDependencies = {
  bucket: R2Bucket;
  /** The deployment's remote prefix; the Vault composes object keys itself, from its own configuration. */
  prefix: string;
  record: HotMutationRecord;
  now?: () => number;
};

function quoted(etag: string): string {
  return `"${normalizeEtag(etag)}"`;
}

export function createHotCheckpoint(dependencies: HotCheckpointDependencies) {
  const now = dependencies.now ?? Date.now;
  const objectKey = (path: string): string | undefined => remoteObjectKey(dependencies.prefix, path);

  /** A tombstone only counts when it parses; garbage in the namespace never deletes a user object. */
  async function tombstoneFor(path: string, etag: string): Promise<RemoteTombstone | null> {
    const key = await tombstoneKey(path, etag);
    if (!key) return null;
    const object = await dependencies.bucket.get(key);
    if (!object) return null;
    try {
      return parseTombstone(await object.text());
    } catch {
      return null;
    }
  }

  async function observePhysical(path: string, withContent: boolean): Promise<HotPathObservation> {
    const key = objectKey(path);
    if (!key) return { observation: { canonicalPath: path, exists: false, etag: null, size: null, deleted: false, tombstoneTargets: null, contentHash: null } };
    const head = await dependencies.bucket.head(key);
    if (!head) return { observation: { canonicalPath: path, exists: false, etag: null, size: null, deleted: false, tombstoneTargets: null, contentHash: null } };
    const etag = normalizeEtag(head.etag);
    const tombstone = await tombstoneFor(path, etag);
    const deleted = tombstone !== null;
    const observation: HotRemoteObservation = {
      canonicalPath: path,
      exists: !deleted,
      etag,
      size: head.size,
      deleted,
      tombstoneTargets: tombstone?.deletedRemoteETag ?? null,
      contentHash: null,
    };
    if (!withContent || deleted) return { observation };
    const object = await dependencies.bucket.get(key);
    if (!object) {
      // A head that reported zero bytes and a body that did not materialise is an *empty revision*, not an
      // absence of one. Conflating the two is expensive: a caller that needs material to seed a document
      // gets "unknown", and every open of an empty file answers "unavailable" forever — which a client can
      // only present as a question no decision can settle.
      if (head.size === 0) return { observation: { ...observation, contentHash: await hotContentHash("") }, content: "" };
      return { observation };
    }
    const text = await object.text();
    return { observation: { ...observation, contentHash: await hotContentHash(text) }, content: text };
  }

  /**
   * Writes a tombstone for one exact revision.
   *
   * `If-None-Match: *` makes the record immutable and the retry idempotent: two devices deleting the
   * same revision produce one record, and a later re-creation is a different revision and is not
   * hidden by it.
   */
  async function writeTombstone(path: string, etag: string): Promise<void> {
    const key = await tombstoneKey(path, etag);
    if (!key) throw new Error("cannot tombstone a non-canonical path");
    const record: RemoteTombstone = { protocol: 1, path, deletedRemoteETag: etag, createdAt: new Date(now()).toISOString() };
    await dependencies.bucket.put(key, encodeTombstone(record), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json" },
    });
  }

  /** The object's own record of which commit produced it, if it has one. */
  async function committedInPlace(key: string, commitId: string): Promise<{ etag: string; size: number } | null> {
    const head = await dependencies.bucket.head(key);
    if (!head) return null;
    return head.customMetadata?.[COMMIT_METADATA_KEY] === commitId ? { etag: normalizeEtag(head.etag), size: head.size } : null;
  }

  return {
    objectKey,
    observe: observePhysical,

    /**
     * One conditional checkpoint.
     *
     * The order is: verify what we are about to say, verify what R2 holds, then write once. A
     * `contentHash` that does not match the bytes is refused here rather than becoming a receipt that
     * lies to a client about what it saved.
     */
    async checkpoint(input: HotCheckpointInput): Promise<HotCheckpointResult> {
      if (!isCanonicalVaultPath(input.canonicalPath)) return { status: "failed", reason: "invalid", detail: "canonicalPath" };
      const key = objectKey(input.canonicalPath);
      if (!key) return { status: "failed", reason: "invalid", detail: "prefix" };
      const hash = await hotContentHash(input.markdown);
      if (hash !== input.contentHash) return { status: "failed", reason: "hash-mismatch" };

      const before = await observePhysical(input.canonicalPath, false);
      if (before.observation.deleted && !input.replaceTombstonedRevision) {
        // The revision we were going to build on was retired. Never resurrect it silently — the only
        // caller allowed past this is a room created over the tombstoned revision on purpose, and even
        // then the write must match that exact revision.
        return { status: "conflict", reason: "remote-deleted", observation: before.observation };
      }
      // The precondition is about the *physical* revision, not about effective existence: a tombstoned
      // object still holds bytes, and a replacement has to be conditional on exactly those bytes or it
      // would be an unconditional overwrite.
      const present = before.observation.etag !== null;
      const matches = input.expectedRemoteETag === null
        ? !present
        : present && before.observation.etag === normalizeEtag(input.expectedRemoteETag);
      if (!matches) {
        // Before calling this a conflict, ask whether the object is *our own* commit. A response lost in
        // transit leaves the caller holding a stale expectation that its own successful write
        // invalidated, and reporting that as an external conflict would show the user a conflict after
        // nothing but a network blip.
        const recovered = await committedInPlace(key, input.commitId);
        if (recovered) {
          const recorded = await dependencies.record({ id: input.commitId, op: "put", path: input.canonicalPath, etag: recovered.etag, size: recovered.size });
          return { status: "committed", canonicalPath: input.canonicalPath, etag: recovered.etag, size: recovered.size, contentHash: hash, commitId: input.commitId, documentRevision: input.documentRevision, mutationSeq: recorded.seq, mutationPending: recorded.pending, recovered: true };
        }
        return { status: "conflict", reason: input.expectedRemoteETag === null ? "already-exists" : "remote-changed", observation: before.observation };
      }

      const bytes = new TextEncoder().encode(input.markdown);
      const onlyIf = input.expectedRemoteETag === null
        ? new Headers({ "If-None-Match": "*" })
        : new Headers({ "If-Match": quoted(input.expectedRemoteETag) });
      const written = await dependencies.bucket.put(key, bytes, {
        onlyIf,
        httpMetadata: { contentType: textContentTypeForKey(input.canonicalPath) },
        customMetadata: {
          [COMMIT_METADATA_KEY]: input.commitId,
          [DOCUMENT_METADATA_KEY]: input.documentId,
          [EPOCH_METADATA_KEY]: String(input.epoch),
          [REVISION_METADATA_KEY]: String(input.documentRevision),
          [CONTENT_HASH_METADATA_KEY]: hash,
        },
      });

      if (!written) {
        // Either someone else moved the object, or this very commit already landed and only its
        // response was lost. The object's own metadata is what tells the two apart.
        const recovered = await committedInPlace(key, input.commitId);
        if (recovered) {
          const recorded = await dependencies.record({ id: input.commitId, op: "put", path: input.canonicalPath, etag: recovered.etag, size: recovered.size });
          return { status: "committed", canonicalPath: input.canonicalPath, etag: recovered.etag, size: recovered.size, contentHash: hash, commitId: input.commitId, documentRevision: input.documentRevision, mutationSeq: recorded.seq, mutationPending: recorded.pending, recovered: true };
        }
        const after = await observePhysical(input.canonicalPath, false);
        const reason = after.observation.deleted ? "remote-deleted" : after.observation.exists ? "remote-changed" : "already-exists";
        return { status: "conflict", reason, observation: after.observation };
      }

      const etag = normalizeEtag(written.etag);
      const recorded = await dependencies.record({ id: input.commitId, op: "put", path: input.canonicalPath, etag, size: written.size });
      return { status: "committed", canonicalPath: input.canonicalPath, etag, size: written.size, contentHash: hash, commitId: input.commitId, documentRevision: input.documentRevision, mutationSeq: recorded.seq, mutationPending: recorded.pending, recovered: false };
    },

    /** Retires exactly one revision with a tombstone. Idempotent by construction. */
    async remove(input: HotDeleteInput): Promise<HotDeleteResult> {
      if (!isCanonicalVaultPath(input.canonicalPath)) return { status: "failed", reason: "invalid", detail: "canonicalPath" };
      const observed = await observePhysical(input.canonicalPath, false);
      const current = observed.observation;

      if (input.expectedRemoteETag === null || !current.exists) {
        // Nothing to retire. Recording "the object is gone" is still the honest fact, and it keeps a
        // retried delete from becoming a second journal entry only if the id is the same — which it is.
        const recorded = await dependencies.record({ id: input.commitId, op: "delete", path: input.canonicalPath, ...(current.etag ? { etag: current.etag } : {}) });
        return { status: "deleted", canonicalPath: input.canonicalPath, retiredETag: current.etag, mutationSeq: recorded.seq, mutationPending: recorded.pending, alreadyDeleted: true };
      }
      if (current.etag !== normalizeEtag(input.expectedRemoteETag)) {
        return { status: "conflict", reason: "remote-changed", observation: current };
      }
      await writeTombstone(input.canonicalPath, current.etag);
      const recorded = await dependencies.record({ id: input.commitId, op: "delete", path: input.canonicalPath, etag: current.etag });
      return { status: "deleted", canonicalPath: input.canonicalPath, retiredETag: current.etag, mutationSeq: recorded.seq, mutationPending: recorded.pending, alreadyDeleted: false };
    },

    /**
     * Rename as one coordinated act: claim the new path, then retire the old one.
     *
     * The new object is written with `If-None-Match: *` and the old path is tombstoned at the exact
     * revision the caller expected, so neither half can overwrite a concurrent write. The two halves
     * are two journal facts with derived ids, which is what makes a crash between them recoverable:
     * the operation is retried with the same `commitId`, so the half that landed is recognised
     * instead of duplicated.
     */
    async move(input: HotMoveInput): Promise<HotMoveResult> {
      if (!isCanonicalVaultPath(input.fromPath) || !isCanonicalVaultPath(input.toPath)) return { status: "failed", reason: "invalid", detail: "canonicalPath" };
      const toKey = objectKey(input.toPath);
      const fromKey = objectKey(input.fromPath);
      if (!toKey || !fromKey) return { status: "failed", reason: "invalid", detail: "prefix" };
      const hash = await hotContentHash(input.markdown);
      if (hash !== input.contentHash) return { status: "failed", reason: "hash-mismatch" };

      const toObservation = (await observePhysical(input.toPath, false)).observation;
      // First question: did *this* commit already produce the target? On a retry after a lost response
      // the source has already been tombstoned, so every source check below would fail — and the honest
      // answer is "this move already happened", not a conflict about content nobody changed.
      const alreadyCommitted = toObservation.etag !== null ? await committedInPlace(toKey, input.commitId) : null;
      if (alreadyCommitted) {
        const retiredETag = normalizeEtag(input.expectedFromETag);
        await writeTombstone(input.fromPath, retiredETag);
        const putRecord = await dependencies.record({ id: `${input.commitId}.to`, op: "put", path: input.toPath, etag: alreadyCommitted.etag, size: alreadyCommitted.size });
        const deleteRecord = await dependencies.record({ id: `${input.commitId}.from`, op: "delete", path: input.fromPath, etag: retiredETag });
        return {
          status: "moved",
          fromPath: input.fromPath,
          toPath: input.toPath,
          etag: alreadyCommitted.etag,
          size: alreadyCommitted.size,
          contentHash: hash,
          retiredETag,
          mutationSeq: putRecord.seq,
          mutationPending: putRecord.pending || deleteRecord.pending,
        };
      }

      const source = (await observePhysical(input.fromPath, false)).observation;
      if (source.deleted) return { status: "conflict", reason: "remote-deleted", observation: source };
      if (source.etag === null || source.etag !== normalizeEtag(input.expectedFromETag)) {
        return { status: "conflict", reason: source.etag === null ? "remote-deleted" : "remote-changed", observation: source };
      }
      const target = (await observePhysical(input.toPath, false)).observation;
      let targetEtag: string;
      let targetSize: number;
      if (target.exists) {
        // The only acceptable reason the target already exists is that *this* commit wrote it.
        const recoveredTarget = await committedInPlace(toKey, input.commitId);
        if (!recoveredTarget) return { status: "conflict", reason: "target-exists", observation: target };
        targetEtag = recoveredTarget.etag;
        targetSize = recoveredTarget.size;
      } else {
        const bytes = new TextEncoder().encode(input.markdown);
        // A tombstoned target still holds a physical revision. The replacement has to be conditional
        // on *that* revision, not on absence: `If-None-Match: *` would fail, and a blind overwrite
        // would ignore whoever retired it.
        const written = await dependencies.bucket.put(toKey, bytes, {
          onlyIf: target.deleted && target.etag
            ? new Headers({ "If-Match": quoted(target.etag) })
            : new Headers({ "If-None-Match": "*" }),
          httpMetadata: { contentType: textContentTypeForKey(input.toPath) },
          customMetadata: {
            [COMMIT_METADATA_KEY]: input.commitId,
            [DOCUMENT_METADATA_KEY]: input.documentId,
            [EPOCH_METADATA_KEY]: String(input.epoch),
            [REVISION_METADATA_KEY]: String(input.documentRevision),
            [CONTENT_HASH_METADATA_KEY]: hash,
          },
        });
        if (written) {
          targetEtag = normalizeEtag(written.etag);
          targetSize = written.size;
        } else {
          // Lost response, or a concurrent create. The object's own commit id decides which.
          const recovered = await committedInPlace(toKey, input.commitId);
          if (!recovered) {
            const after = await observePhysical(input.toPath, false);
            return { status: "conflict", reason: "target-exists", observation: after.observation };
          }
          targetEtag = recovered.etag;
          targetSize = recovered.size;
        }
      }

      const putRecord = await dependencies.record({ id: `${input.commitId}.to`, op: "put", path: input.toPath, etag: targetEtag, size: targetSize });
      await writeTombstone(input.fromPath, source.etag);
      const deleteRecord = await dependencies.record({ id: `${input.commitId}.from`, op: "delete", path: input.fromPath, etag: source.etag });

      return {
        status: "moved",
        fromPath: input.fromPath,
        toPath: input.toPath,
        etag: targetEtag,
        size: targetSize,
        contentHash: hash,
        retiredETag: source.etag,
        mutationSeq: putRecord.seq,
        mutationPending: putRecord.pending || deleteRecord.pending,
      };
    },
  };
}

export type HotCheckpoint = ReturnType<typeof createHotCheckpoint>;
