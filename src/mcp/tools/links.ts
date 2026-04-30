import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "../../storage/content";
import { backlinkTargets, scanTextFiles } from "../../storage/r2";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

export function registerLinkTools(ctx: McpRegistrationContext): void {

    // 重命名文本文件，并同步更新其他笔记中的 wikilinks
    registerToolCompat(ctx.server,
      "link_rename_with_links",
      {
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().describe("目标存在时是否覆盖，默认 false"),
        updateLinks: z.boolean().optional().describe("是否更新其他笔记中的 wikilinks，默认 true"),
        dryRun: z.boolean().optional().describe("只预览将移动和修改的文件"),
      },
      async ({ from, to, overwrite, updateLinks, dryRun }) => {
        const fromInvalid = assertTextKey(from);
        if (fromInvalid) return err(fromInvalid);
        const toInvalid = assertTextKey(to);
        if (toInvalid) return err(toInvalid);
        if (from === to) return err("from 和 to 相同");
        const src = await ctx.env.BEDROCK.get(from);
        if (!src) return err(`源文件不存在：${from}`);
        const existingTarget = await ctx.env.BEDROCK.head(to);
        if (existingTarget && !overwrite) return err(`目标已存在，传 overwrite: true 强制覆盖：${to}`);
        const srcText = await src.text();

        const targets = backlinkTargets(from);
        const replacement = stripTextExt(to);
        const linkUpdates = updateLinks === false
          ? []
          : await scanTextFiles(ctx.env.BEDROCK, undefined, (key, text, obj) => {
              if (key === from || key === to || key.startsWith(".history/") || key.startsWith(".trash/")) return null;
              const replaced = wikilinkReplacement(text, targets, replacement);
              if (!replaced.changed) return null;
              return {
                key,
                modified: obj.uploaded.toISOString(),
                patch: createPatch(key, text, replaced.text, "current", "updated-links", { context: 2 }),
                next: replaced.text,
              };
            });

        if (dryRun) {
          return ok(JSON.stringify({
            ok: true,
            dryRun: true,
            from,
            to,
            replacement,
            willMove: true,
            linkUpdateCount: linkUpdates.length,
            linkUpdates: linkUpdates.map(({ key, modified, patch }) => ({ key, modified, patch })),
          }, null, 2));
        }

        const movedBackupKey = await backupTextObject(ctx.env.BEDROCK, from, srcText, src.httpMetadata?.contentType);
        let overwrittenTargetBackupKey: string | null = null;
        if (existingTarget) {
          const targetObj = await ctx.env.BEDROCK.get(to);
          if (targetObj) {
            overwrittenTargetBackupKey = await backupTextObject(
              ctx.env.BEDROCK,
              to,
              await targetObj.text(),
              targetObj.httpMetadata?.contentType
            );
          }
        }
        await ctx.env.BEDROCK.put(to, encodeUtf8(srcText), {
          httpMetadata: { contentType: textContentTypeForKey(to, src.httpMetadata?.contentType) },
          customMetadata: src.customMetadata,
        });
        await ctx.env.BEDROCK.delete(from);

        const updated: Array<{ key: string; backupKey: string; size: number }> = [];
        for (const item of linkUpdates) {
          const current = await ctx.env.BEDROCK.get(item.key);
          if (!current) continue;
          const oldText = await current.text();
          const replaced = wikilinkReplacement(oldText, targets, replacement);
          if (!replaced.changed) continue;
          const backupKey = await backupTextObject(ctx.env.BEDROCK, item.key, oldText, current.httpMetadata?.contentType);
          const ct = textContentTypeForKey(item.key, current.httpMetadata?.contentType);
          await ctx.env.BEDROCK.put(item.key, encodeUtf8(replaced.text), { httpMetadata: { contentType: ct } });
          updated.push({ key: item.key, backupKey, size: encodeUtf8(replaced.text).length });
        }

        return ok(JSON.stringify({
          ok: true,
          dryRun: false,
          from,
          to,
          movedBackupKey,
          overwrittenTargetBackupKey,
          linkUpdateCount: updated.length,
          updated,
        }, null, 2));
      }
    );


    // 反向链接：哪些笔记 [[link]] 到了这篇
    registerToolCompat(ctx.server,
      "link_find_backlinks",
      {
        key: z.string().min(1).describe("被链接的笔记，例如 '概念/二阶思考.md'"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async ({ key, limit }) => {
        const targets = backlinkTargets(key);
        const matches = await scanTextFiles(ctx.env.BEDROCK, undefined, (k, text, o) => {
          if (k === key) return null; // 不返回自身
          const links = extractWikilinks(text);
          const hit = links.find(l => targets.has(l) || targets.has(l.split("/").pop() ?? ""));
          if (!hit) return null;
          return {
            key: k,
            modified: o.uploaded.toISOString(),
            modifiedRelative: relativeTime(o.uploaded),
            via: hit,
            snippet: snippet(text, `[[${hit}`),
          };
        }, { max: limit ?? 100 });
        matches.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok(JSON.stringify({ target: key, count: matches.length, matches }, null, 2));
      }
    );


    // 这篇笔记里链出去的 [[wikilinks]]
    registerToolCompat(ctx.server,
      "link_get_outgoing",
      { key: z.string().min(1) },
      async ({ key }) => {
        const obj = await ctx.env.BEDROCK.get(key);
        if (!obj) return err(`Not found: ${key}`);
        const text = await obj.text();
        const links = extractWikilinks(text);
        // 顺手探一下哪些是死链（vault 里搜不到对应文件）
        const checks = await Promise.all(links.map(async l => {
          // 尝试常见路径形式
          const candidates = [
            `${l}.md`,
            l, // 已经带扩展名的情况
          ];
          for (const c of candidates) {
            const h = await ctx.env.BEDROCK.head(c);
            if (h) return { link: l, resolved: c };
          }
          return { link: l, resolved: null };
        }));
        return ok(JSON.stringify({
          key,
          total: links.length,
          links: checks,
          deadLinks: checks.filter(c => !c.resolved).map(c => c.link),
        }, null, 2));
      }
    );
}
