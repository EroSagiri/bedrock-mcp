import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { readIndex } from "../index-client";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "@mineral/core/content";
import { backlinkTargets, scanTextFiles } from "../../vault-client";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
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
        const src = await ctx.env.vault.documents.get(from);
        if (!src) return err(`源文件不存在：${from}`);
        const existingTarget = await ctx.env.vault.documents.head(to);
        if (existingTarget && !overwrite) return err(`目标已存在，传 overwrite: true 强制覆盖：${to}`);
        const srcText = await src.text();

        const targets = backlinkTargets(from);
        const replacement = stripTextExt(to);
        const linkUpdates = updateLinks === false
          ? []
          : await scanTextFiles(ctx.env.vault.documents, undefined, (key, text, obj) => {
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

        const movedBackupKey = await backupTextObject(ctx.env.vault.documents, from, srcText, src.httpMetadata?.contentType);
        let overwrittenTargetBackupKey: string | null = null;
        if (existingTarget) {
          const targetObj = await ctx.env.vault.documents.get(to);
          if (targetObj) {
            overwrittenTargetBackupKey = await backupTextObject(
              ctx.env.vault.documents,
              to,
              await targetObj.text(),
              targetObj.httpMetadata?.contentType
            );
          }
        }
        await ctx.env.vault.documents.put(to, encodeUtf8(srcText), {
          httpMetadata: { contentType: textContentTypeForKey(to, src.httpMetadata?.contentType) },
          customMetadata: src.customMetadata ?? undefined,
        });
        await ctx.env.vault.documents.delete(from);

        const updated: Array<{ key: string; backupKey: string; size: number }> = [];
        for (const item of linkUpdates) {
          const current = await ctx.env.vault.documents.get(item.key);
          if (!current) continue;
          const oldText = await current.text();
          const replaced = wikilinkReplacement(oldText, targets, replacement);
          if (!replaced.changed) continue;
          const backupKey = await backupTextObject(ctx.env.vault.documents, item.key, oldText, current.httpMetadata?.contentType);
          const ct = textContentTypeForKey(item.key, current.httpMetadata?.contentType);
          await ctx.env.vault.documents.put(item.key, encodeUtf8(replaced.text), { httpMetadata: { contentType: ct } });
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
        inputSchema: {
          key: z.string().min(1).describe("被链接的笔记，例如 '概念/二阶思考.md'"),
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      async ({ key, limit }) => {
        const outcome = await readIndex(ctx.env, "backlinks", { key, limit });
        if (!outcome.ok) return outcome.result;
        return ok(JSON.stringify(outcome.data, null, 2));
      }
    );


    // 这篇笔记里链出去的 [[wikilinks]]
    registerToolCompat(ctx.server,
      "link_get_outgoing",
      { inputSchema: { key: z.string().min(1) } },
      async ({ key }) => {
        const outcome = await readIndex(ctx.env, "outgoing", { key });
        if (!outcome.ok) return outcome.result;
        return ok(JSON.stringify(outcome.data, null, 2));
      }
    );
}