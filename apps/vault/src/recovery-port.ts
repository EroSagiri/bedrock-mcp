import type { RecoveryObject, RecoveryPort } from "@mineral/sync-core/recovery";

/** R2 binding adapter for the same portable engine used by both Obsidian platforms. */
export function r2RecoveryPort(bucket: R2Bucket): RecoveryPort {
  const object = (o: R2Object): RecoveryObject => {
    const headers = new Headers(); o.writeHttpMetadata(headers);
    return { key: o.key, etag: o.etag, size: o.size, modified: o.uploaded.toISOString(), contentType: o.httpMetadata?.contentType ?? "application/octet-stream", metadata: o.customMetadata ?? {}, httpMetadata: Object.fromEntries(headers.entries()) };
  };
  return {
    list: async prefix => {
      const result: RecoveryObject[] = []; let cursor: string | undefined;
      do { const page = await bucket.list({ prefix, cursor, include: ["httpMetadata", "customMetadata"] }); result.push(...page.objects.map(object)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
      return result;
    },
    head: async (key, etag) => { const o = await bucket.head(key); if (o && etag && o.etag !== etag) throw new Error("Source ETag changed"); return o ? object(o) : null; },
    read: async (key, etag) => { const o = await bucket.get(key, { onlyIf: { etagMatches: etag } }); if (!o || !("body" in o)) throw new Error("Conditional recovery read failed"); return { object: object(o), bytes: new Uint8Array(await o.arrayBuffer()) }; },
    put: async (key, bytes, expected, metadata = {}, contentType = "application/octet-stream", httpMetadata = {}) => {
      const o = await bucket.put(key, bytes, { onlyIf: expected === null ? { etagDoesNotMatch: "*" } : { etagMatches: expected }, customMetadata: metadata, httpMetadata: new Headers({ ...httpMetadata, "content-type": contentType }) });
      if (!o) throw new Error("Conditional recovery write failed"); return object(o);
    },
    remove: key => bucket.delete(key),
  };
}
