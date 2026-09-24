import { z } from "zod";
import { registerToolCompat } from "../compat";
import { readIndex } from "../index-client";
import { ok, type McpRegistrationContext } from "../shared";

/**
 * Tags are index data.
 *
 * Both tools answer from `document_tags`, which the indexer maintains from frontmatter and body tags. A
 * tag question that walks the vault would read one document per candidate — the same cost as a live
 * content scan, and the same hard failure on a vault past the subrequest ceiling — so there is no such
 * path here at all.
 */
const sourceSchema = z.array(z.enum(["frontmatter", "body"])).optional();

export function registerTagTools(ctx: McpRegistrationContext): void {
  registerToolCompat(ctx.server, "tag_list", {
    inputSchema: {
      sources: sourceSchema,
      prefix: z.string().optional().describe("标签名前缀，例如 '日记/' 匹配所有子标签"),
      contains: z.string().optional().describe("标签名包含的字串；记不清完整标签名时用它"),
      minReferences: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  }, async ({ sources, prefix, contains, minReferences, limit }) => {
    const selected = sources ?? ["frontmatter", "body"];
    const outcome = await readIndex(ctx.env, "tags", { sources: selected, tagPrefix: prefix, tagContains: contains, minReferences, limit });
    if (!outcome.ok) return outcome.result;
    return ok(JSON.stringify(outcome.data, null, 2));
  });

  registerToolCompat(ctx.server, "tag_list_documents", {
    inputSchema: {
      tag: z.string().min(1),
      sources: sourceSchema,
      match: z.enum(["exact", "descendants"]).optional(),
      prefix: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  }, async ({ tag, sources, match, prefix, limit }) => {
    const normalized = normalizeTag(tag);
    const selected = sources ?? ["frontmatter", "body"];
    const outcome = await readIndex<{ documents?: unknown[] }>(ctx.env, "tag-documents", { tag: normalized, sources: selected, match, prefix, limit });
    if (!outcome.ok) return outcome.result;
    const documents = outcome.data.documents ?? [];
    if (documents.length > 0) return ok(JSON.stringify(outcome.data, null, 2));

    // An empty list is ambiguous, and the ambiguity is the whole problem: a tag that does not exist and a
    // tag whose notes all sit outside the prefix look identical. So the answer says which it is, and names
    // the tags the caller probably meant.
    const all = await readIndex<{ tags?: Array<{ tag: string }> }>(ctx.env, "tags", { sources: selected, limit: 1000 });
    if (!all.ok) return all.result;
    const names = (all.data.tags ?? []).map(item => item.tag);
    const exact = names.includes(normalized);
    const suggestions = names.filter(name => name !== normalized && (name.includes(normalized) || normalized.includes(name))).slice(0, 10);
    return ok(JSON.stringify({
      ...outcome.data,
      tagExists: exact,
      suggestions,
      note: exact
        ? `标签 ${normalized} 存在，但${prefix ? `前缀 ${prefix} 下` : match === "descendants" ? "该标签及其子标签下" : "当前范围内"}没有笔记。`
        : `标签 ${normalized} 不在索引中${suggestions.length ? `；相近的标签：${suggestions.join("、")}` : ""}。用 tag_list 可以看到全部标签。`,
    }, null, 2));
  });
}

/** `#跑步` is the same tag as `跑步`: the hash is a way of writing it, not part of its name. */
function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "");
}
