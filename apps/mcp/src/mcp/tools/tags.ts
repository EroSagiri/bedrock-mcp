import { z } from "zod";
import { scanTextFiles } from "../../vault-client";
import { extractTags, frontmatterTags, normalizeTag, parseFrontmatter } from "../../utils/markdown";
import { registerToolCompat } from "../compat";
import { indexQuery, readModeSchemaDescription } from "../index-client";
import { refuseLargeLiveScan } from "../live-scan";
import { ok, type McpRegistrationContext } from "../shared";

const sourceSchema = z.array(z.enum(["frontmatter", "body"])).optional();
const isSystemKey = (key: string) => key.startsWith(".history/") || key.startsWith(".trash/") || key.startsWith(".system/");
const sourceTags = (text: string, sources: string[]) => {
  const { frontmatter, body } = parseFrontmatter(text);
  return { frontmatter: sources.includes("frontmatter") ? frontmatterTags(frontmatter) : [], body: sources.includes("body") ? extractTags(body) : [] };
};

export function registerTagTools(ctx: McpRegistrationContext): void {
  registerToolCompat(ctx.server, "tag_list", {
    sources: sourceSchema,
    prefix: z.string().optional().describe("标签名前缀，例如 '日记/' 匹配所有子标签"),
    contains: z.string().optional().describe("标签名包含的字串；记不清完整标签名时用它"),
    minReferences: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(1000).optional(),
    readMode: z.enum(["index", "live"]).optional().describe(readModeSchemaDescription),
  }, async ({ sources, prefix, contains, minReferences, limit, readMode }) => {
    const selected = sources ?? ["frontmatter", "body"];
    if ((readMode ?? "index") === "index") return ok(JSON.stringify(await indexQuery(ctx.env, "tags", { sources: selected, tagPrefix: prefix, tagContains: contains, minReferences, limit }), null, 2));
    // A live tag scan reads every document, exactly like a live content scan, and fails the same way when
    // it is unbounded. The index already holds the tags, so this path is never the better answer.
    const refused = await refuseLargeLiveScan(ctx, {
      prefix: undefined,
      operation: "tag_list live scan",
      indexRemedy: "改用 readMode='index'（默认）：标签已进索引，结果相同且不读 R2",
    });
    if (refused) return refused;
    const values = new Map<string, { referenceCount: number; documents: Set<string>; frontmatterReferences: number; bodyReferences: number }>();
    await scanTextFiles(ctx.env.vault.documents, undefined, (key, text) => {
      if (isSystemKey(key)) return null;
      const bySource = sourceTags(text, selected);
      for (const source of ["frontmatter", "body"] as const) for (const tag of bySource[source]) {
        if (prefix && !tag.startsWith(normalizeTag(prefix))) continue;
        if (contains && !tag.includes(normalizeTag(contains))) continue;
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
    if ((readMode ?? "index") === "index") {
      const result = await indexQuery(ctx.env, "tag-documents", { tag: normalized, sources: selected, match, prefix, limit });
      const documents = (result.documents as unknown[] | undefined) ?? [];
      if (documents.length > 0) return ok(JSON.stringify(result, null, 2));
      // An empty list is ambiguous, and the ambiguity is the whole problem: a tag that does not exist and a
      // tag whose notes all moved out of the prefix look identical. So the answer says which it is, and
      // names the tags the caller probably meant.
      const all = await indexQuery(ctx.env, "tags", { sources: selected, limit: 1000 }) as { tags?: Array<{ tag: string }> };
      const names = (all.tags ?? []).map(item => item.tag);
      const exact = names.includes(normalized);
      const suggestions = names.filter(name => name !== normalized && (name.includes(normalized) || normalized.includes(name))).slice(0, 10);
      return ok(JSON.stringify({
        ...result,
        tagExists: exact,
        suggestions,
        note: exact
          ? `标签 ${normalized} 存在，但${prefix ? `前缀 ${prefix} 下` : match === "descendants" ? "该标签及其子标签下" : "当前范围内"}没有笔记。`
          : `标签 ${normalized} 不在索引中${suggestions.length ? `；相近的标签：${suggestions.join("、")}` : ""}。用 tag_list 可以看到全部标签。`,
      }, null, 2));
    }
    const refused = await refuseLargeLiveScan(ctx, {
      prefix,
      operation: "tag_list_documents live scan",
      indexRemedy: "改用 readMode='index'（默认）：标签已进索引，结果相同且不读 R2",
    });
    if (refused) return refused;
    const matches = await scanTextFiles(ctx.env.vault.documents, prefix, (key, text, object) => {
      if (isSystemKey(key)) return null;
      const source = sourceTags(text, selected); const counts = { frontmatterReferences: 0, bodyReferences: 0 };
      for (const kind of ["frontmatter", "body"] as const) for (const item of source[kind]) if (item === normalized || (match === "descendants" && item.startsWith(`${normalized}/`))) counts[`${kind}References`]++;
      return counts.frontmatterReferences || counts.bodyReferences ? { key, modified: object.uploaded.toISOString(), ...counts } : null;
    });
    return ok(JSON.stringify({ tag: normalized, documents: matches.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, limit ?? 100), source: "live", freshness: "live", liveScan: "raw Vault full traversal" }, null, 2));
  });
}
