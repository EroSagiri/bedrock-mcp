import { z } from "zod";
import { scanTextFiles } from "../../storage/r2";
import { extractTags, frontmatterTags, normalizeTag, parseFrontmatter } from "../../utils/markdown";
import { registerToolCompat } from "../compat";
import { indexQuery, readModeSchemaDescription } from "../index-client";
import { ok, type McpRegistrationContext } from "../shared";

const sourceSchema = z.array(z.enum(["frontmatter", "body"])).optional();
const isSystemKey = (key: string) => key.startsWith(".history/") || key.startsWith(".trash/") || key.startsWith(".system/");
const sourceTags = (text: string, sources: string[]) => {
  const { frontmatter, body } = parseFrontmatter(text);
  return { frontmatter: sources.includes("frontmatter") ? frontmatterTags(frontmatter) : [], body: sources.includes("body") ? extractTags(body) : [] };
};

export function registerTagTools(ctx: McpRegistrationContext): void {
  registerToolCompat(ctx.server, "tag_list", {
    sources: sourceSchema, prefix: z.string().optional(), minReferences: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(1000).optional(),
    readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
  }, async ({ sources, prefix, minReferences, limit, readMode }) => {
    const selected = sources ?? ["frontmatter", "body"];
    if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "tags", { sources: selected, tagPrefix: prefix, minReferences, limit }), null, 2));
    const values = new Map<string, { referenceCount: number; documents: Set<string>; frontmatterReferences: number; bodyReferences: number }>();
    await scanTextFiles(ctx.env.BEDROCK, undefined, (key, text) => {
      if (isSystemKey(key)) return null;
      const bySource = sourceTags(text, selected);
      for (const source of ["frontmatter", "body"] as const) for (const tag of bySource[source]) {
        if (prefix && !tag.startsWith(normalizeTag(prefix))) continue;
        const item = values.get(tag) ?? { referenceCount: 0, documents: new Set(), frontmatterReferences: 0, bodyReferences: 0 };
        item.referenceCount++; item.documents.add(key); if (source === "frontmatter") item.frontmatterReferences++; else item.bodyReferences++; values.set(tag, item);
      }
      return null;
    });
    const tags = [...values].map(([tag, value]) => ({ tag, referenceCount: value.referenceCount, documentCount: value.documents.size, frontmatterReferences: value.frontmatterReferences, bodyReferences: value.bodyReferences }))
      .filter(item => item.referenceCount >= (minReferences ?? 1)).sort((a, b) => a.tag.localeCompare(b.tag)).slice(0, limit ?? 100);
    return ok(JSON.stringify({ tags, source: "live", freshness: "live", liveScan: "raw Vault full traversal" }, null, 2));
  });
  registerToolCompat(ctx.server, "tag_list_documents", {
    tag: z.string().min(1), sources: sourceSchema, match: z.enum(["exact", "descendants"]).optional(), prefix: z.string().optional(), limit: z.number().int().min(1).max(1000).optional(),
    readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
  }, async ({ tag, sources, match, prefix, limit, readMode }) => {
    const normalized = normalizeTag(tag); const selected = sources ?? ["frontmatter", "body"];
    if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "tag-documents", { tag: normalized, sources: selected, match, prefix, limit }), null, 2));
    const matches = await scanTextFiles(ctx.env.BEDROCK, prefix, (key, text, object) => {
      if (isSystemKey(key)) return null;
      const source = sourceTags(text, selected); const counts = { frontmatterReferences: 0, bodyReferences: 0 };
      for (const kind of ["frontmatter", "body"] as const) for (const item of source[kind]) if (item === normalized || (match === "descendants" && item.startsWith(`${normalized}/`))) counts[`${kind}References`]++;
      return counts.frontmatterReferences || counts.bodyReferences ? { key, modified: object.uploaded.toISOString(), ...counts } : null;
    });
    return ok(JSON.stringify({ tag: normalized, documents: matches.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit ?? 100), source: "live", freshness: "live", liveScan: "raw Vault full traversal" }, null, 2));
  });
}
