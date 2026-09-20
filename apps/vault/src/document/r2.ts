import { isTextDocumentKey } from "@mineral/core/keys";

export function backlinkTargets(key: string): Set<string> {
  const noExt = key.replace(/\.(md|markdown|mdx|txt)$/i, "");
  const basename = noExt.split("/").pop() ?? noExt;
  return new Set([noExt, basename]);
}

export async function scanTextFiles<T>(
  bucket: R2Bucket,
  prefix: string | undefined,
  fn: (key: string, text: string, obj: R2Object) => T | null | Promise<T | null>,
  opts: { batchSize?: number; max?: number } = {}
): Promise<T[]> {
  const batchSize = opts.batchSize ?? 10;
  const max = opts.max ?? Infinity;
  const out: T[] = [];
  let cursor: string | undefined;
  outer: do {
    const r = await bucket.list({ prefix, cursor, limit: 1000 });
    const targets = r.objects.filter(o => isTextDocumentKey(o.key));
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async o => {
        const obj = await bucket.get(o.key);
        if (!obj) return null;
        const text = await obj.text();
        return fn(o.key, text, o as unknown as R2Object);
      }));
      for (const r of results) {
        if (r != null) out.push(r);
        if (out.length >= max) break outer;
      }
    }
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}
