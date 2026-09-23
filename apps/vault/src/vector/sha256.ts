/**
 * The digest every physical vector identity is derived from.
 *
 * It is the runtime's own SHA-256. An earlier version carried a hand-written synchronous implementation,
 * because ids were derived while chunking inside the publish transaction. They no longer are: a chunk id
 * depends only on the document id, the content hash, the chunker, the model, the schema version and the
 * ordinal — all of which are known before the transaction opens — so the digests are awaited up front
 * and the transaction writes ids that already exist.
 *
 * That is the whole reason the hand-written primitive is gone: a self-maintained implementation of a
 * cryptographic primitive is a maintenance liability in the publish path, and the ordering above removes
 * the only thing that ever required it. `test/vector-chunk.spec.ts` keeps the old implementation as a
 * test-only oracle and pins this one against it, so the identity contract stays exactly where it was.
 */
export async function sha256Base64Url(text: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Unpadded base64url, which is the alphabet every id in this layer uses. */
export function base64Url(digest: ArrayBuffer | Uint8Array): string {
  const bytes = digest instanceof Uint8Array ? digest : new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
