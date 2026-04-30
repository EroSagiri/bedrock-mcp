import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "../../storage/content";
import { backlinkTargets, scanTextFiles } from "../../storage/r2";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";

export function registerDocumentTools(ctx: McpRegistrationContext): void {

    // 读取单个文档（解析 frontmatter / wikilinks / tags）
    registerToolCompat(ctx.server,
      "doc_read",
      {
        key: z.string(),
        raw: z.boolean().optional().describe("true=只返回原始文本，不做解析"),
      },
      async ({ key, raw }) => {
        const obj = await ctx.env.BEDROCK.get(key);
        if (!obj) return err(`Not found: ${key}`);
        const text = await obj.text();
        if (raw) return ok(text);
        const { frontmatter, body } = parseFrontmatter(text);
        return ok(JSON.stringify({
          key,
          modified: obj.uploaded.toISOString(),
          size: obj.size,
          frontmatter,
          tags: extractTags(text),
          links: extractWikilinks(text),
          body,
        }, null, 2));
      }
    );


    // 日记快捷入口
    registerToolCompat(ctx.server,
      "doc_daily",
      {
        date: z.string().optional().describe("YYYY-MM-DD，默认今天"),
        folder: z.string().optional().describe("日记目录，默认 '日记'"),
      },
      async ({ date, folder }) => {
        const dir = folder ?? "日记";
        const today = date ?? new Date().toISOString().slice(0, 10);
        // 尝试常见命名
        const candidates = [
          `${dir}/${today}.md`,
          `${dir}/${today.replace(/-/g, "")}.md`,
          `${dir}/${today.slice(0, 7)}/${today}.md`,
          `${dir}/${today.slice(0, 4)}/${today}.md`,
        ];
        for (const k of candidates) {
          const obj = await ctx.env.BEDROCK.get(k);
          if (obj) {
            return ok(JSON.stringify({
              key: k,
              modified: obj.uploaded.toISOString(),
              text: await obj.text(),
            }, null, 2));
          }
        }
        // 没找到精确匹配就模糊匹配该目录下含日期的文件
        const r = await ctx.env.BEDROCK.list({ prefix: `${dir}/`, limit: 1000 });
        const fuzzy = r.objects.filter(o => o.key.includes(today));
        return err(`未找到 ${today} 的日记。尝试过：\n${candidates.join("\n")}\n\n该目录下含 "${today}" 的文件：\n${fuzzy.map(o => o.key).join("\n") || "(无)"}`);
      }
    );


    // 写入/创建文档（覆盖式 put）
    registerToolCompat(ctx.server,
      "doc_write",
      {
        key: z.string().min(1).describe("R2 对象 key，例如 '日记/2026-04-29.md'"),
        content: z.string().describe("文件全文内容（覆盖式写入）"),
        contentType: z.string().optional().describe("MIME 类型，.md 默认 text/markdown"),
      },
      async ({ key, content, contentType }) => {
        // 只允许文本扩展名，避免误把二进制当字符串写
        const invalid = assertTextKey(key);
        if (invalid) return err(invalid);

        const ct = textContentTypeForKey(key, contentType);
        const existed = await ctx.env.BEDROCK.head(key);
        await ctx.env.BEDROCK.put(key, encodeUtf8(content), {
          httpMetadata: { contentType: ct },
        });

        return ok(JSON.stringify({
          ok: true,
          key,
          action: existed ? "updated" : "created",
          size: encodeUtf8(content).length,
          contentType: ct,
        }, null, 2));
      }
    );


    // 预览把当前文档改成 proposedContent 的 unified diff
    registerToolCompat(ctx.server,
      "doc_preview_diff",
      {
        key: z.string().min(1),
        proposedContent: z.string().describe("拟写入的新全文；只预览 diff，不会写入"),
        contextLines: z.number().int().min(0).max(20).optional().describe("diff 上下文行数，默认 3"),
      },
      async ({ key, proposedContent, contextLines }) => {
        const invalid = assertTextKey(key);
        if (invalid) return err(invalid);
        const obj = await ctx.env.BEDROCK.get(key);
        if (!obj) return err(`Not found: ${key}`);
        const current = await obj.text();
        const patch = createPatch(key, current, proposedContent, "current", "proposed", {
          context: contextLines ?? 3,
        });
        return ok(JSON.stringify({
          key,
          changed: current !== proposedContent,
          currentSize: encodeUtf8(current).length,
          proposedSize: encodeUtf8(proposedContent).length,
          patch,
        }, null, 2));
      }
    );


    // 应用 unified diff patch；默认 dryRun，真正写入前会备份原文
    registerToolCompat(ctx.server,
      "doc_patch",
      {
        key: z.string().min(1),
        patch: z.string().min(1).describe("unified diff patch，可由 doc_preview_diff 或外部工具生成"),
        dryRun: z.boolean().optional().describe("默认 true，只返回应用后的 diff 预览；false 才写入"),
        createBackup: z.boolean().optional().describe("写入前是否备份到 .history，默认 true"),
        fuzzFactor: z.number().int().min(0).max(5).optional().describe("patch 模糊匹配，默认 0"),
      },
      async ({ key, patch, dryRun, createBackup, fuzzFactor }) => {
        const invalid = assertTextKey(key);
        if (invalid) return err(invalid);
        const obj = await ctx.env.BEDROCK.get(key);
        if (!obj) return err(`Not found: ${key}`);
        const current = await obj.text();
        const patched = applyPatch(current, patch, { fuzzFactor: fuzzFactor ?? 0 });
        if (patched === false) return err(`patch 无法应用到当前文件：${key}`);

        const preview = createPatch(key, current, patched, "current", dryRun === false ? "patched" : "dry-run", {
          context: 3,
        });
        if (dryRun !== false) {
          return ok(JSON.stringify({
            ok: true,
            key,
            dryRun: true,
            changed: current !== patched,
            patch: preview,
          }, null, 2));
        }

        const backupKey = createBackup === false
          ? null
          : await backupTextObject(ctx.env.BEDROCK, key, current, obj.httpMetadata?.contentType);
        const ct = textContentTypeForKey(key, obj.httpMetadata?.contentType);
        await ctx.env.BEDROCK.put(key, encodeUtf8(patched), { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({
          ok: true,
          key,
          dryRun: false,
          changed: current !== patched,
          backupKey,
          size: encodeUtf8(patched).length,
          contentType: ct,
          patch: preview,
        }, null, 2));
      }
    );


    // 备份单篇文本文件到 .history
    registerToolCompat(ctx.server,
      "doc_backup",
      { key: z.string().min(1) },
      async ({ key }) => {
        const invalid = assertTextKey(key);
        if (invalid) return err(invalid);
        const obj = await ctx.env.BEDROCK.get(key);
        if (!obj) return err(`Not found: ${key}`);
        const text = await obj.text();
        const backupKey = await backupTextObject(ctx.env.BEDROCK, key, text, obj.httpMetadata?.contentType);
        return ok(JSON.stringify({ ok: true, key, backupKey, size: encodeUtf8(text).length }, null, 2));
      }
    );


    // 从 .history 或任意文本备份 key 恢复到目标文件
    registerToolCompat(ctx.server,
      "doc_restore",
      {
        backupKey: z.string().min(1).describe("备份对象 key，例如 .history/<timestamp>/path/file.md"),
        targetKey: z.string().min(1).optional().describe("恢复目标；不传则从 backupKey 去掉 .history/<timestamp>/ 前缀"),
        overwrite: z.boolean().optional().describe("目标存在时是否覆盖，默认 false"),
      },
      async ({ backupKey, targetKey, overwrite }) => {
        const backupInvalid = keyError(backupKey);
        if (backupInvalid) return err(backupInvalid);
        const inferred = backupKey.replace(/^\.history\/[^/]+\//, "").replace(/^\.trash\/[^/]+\//, "");
        const target = targetKey ?? inferred;
        const targetInvalid = assertTextKey(target);
        if (targetInvalid) return err(targetInvalid);
        const backup = await ctx.env.BEDROCK.get(backupKey);
        if (!backup) return err(`Backup not found: ${backupKey}`);
        if (!overwrite && await ctx.env.BEDROCK.head(target)) {
          return err(`目标已存在，传 overwrite: true 强制覆盖：${target}`);
        }
        const text = await backup.text();
        const ct = textContentTypeForKey(target, backup.httpMetadata?.contentType);
        await ctx.env.BEDROCK.put(target, encodeUtf8(text), { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({ ok: true, backupKey, targetKey: target, contentType: ct, size: encodeUtf8(text).length }, null, 2));
      }
    );


    // 严格创建：文件已存在则失败，避免 LLM 误覆盖
    registerToolCompat(ctx.server,
      "doc_create",
      {
        key: z.string().min(1),
        content: z.string(),
        contentType: z.string().optional(),
      },
      async ({ key, content, contentType }) => {
        const invalid = assertTextKey(key);
        if (invalid) return err(invalid);
        const existed = await ctx.env.BEDROCK.head(key);
        if (existed) return err(`文件已存在，如需覆盖请用 doc_write：${key}`);
        const ct = textContentTypeForKey(key, contentType);
        await ctx.env.BEDROCK.put(key, encodeUtf8(content), { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({ ok: true, key, action: "created", contentType: ct }, null, 2));
      }
    );


    // 追加内容（适合日记/任务清单："在今天日记末尾加一句"）
    registerToolCompat(ctx.server,
      "doc_append",
      {
        key: z.string().min(1),
        content: z.string(),
        separator: z.string().optional().describe("追加前的分隔符，默认 '\\n\\n'"),
        createIfMissing: z.boolean().optional().describe("文件不存在时是否新建，默认 true"),
      },
      async ({ key, content, separator, createIfMissing }) => {
        const invalid = assertTextKey(key);
        if (invalid) return err(invalid);
        const obj = await ctx.env.BEDROCK.get(key);
        const sep = separator ?? "\n\n";
        let next: string;
        let action: "created" | "appended";
        if (!obj) {
          if (createIfMissing === false) return err(`Not found: ${key}`);
          next = content;
          action = "created";
        } else {
          const old = await obj.text();
          next = old.endsWith("\n") ? old + content : old + sep + content;
          action = "appended";
        }
        const ct = textContentTypeForKey(key, obj?.httpMetadata?.contentType);
        await ctx.env.BEDROCK.put(key, encodeUtf8(next), { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({ ok: true, key, action, size: encodeUtf8(next).length }, null, 2));
      }
    );


    // 按模板创建文件（替换 {{var}} 占位符）
    registerToolCompat(ctx.server,
      "doc_create_from_template",
      {
        template: z.string().min(1).describe("模板文件 key，例如 '模板/日记.md'"),
        target: z.string().min(1).describe("目标 key，例如 '日记/2026-04-29.md'"),
        vars: z.record(z.string(), z.string()).optional().describe("替换变量；自动包含 date/time/datetime/title"),
        overwrite: z.boolean().optional().describe("目标存在时是否覆盖，默认 false"),
      },
      async ({ template, target, vars, overwrite }) => {
        const tpl = await ctx.env.BEDROCK.get(template);
        if (!tpl) return err(`模板不存在：${template}`);
        if (!overwrite) {
          const existed = await ctx.env.BEDROCK.head(target);
          if (existed) return err(`目标已存在，传 overwrite: true 强制覆盖：${target}`);
        }
        const tplText = await tpl.text();
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const titleFromTarget = (target.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
        const builtins: Record<string, string> = {
          date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
          time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
          datetime: now.toISOString(),
          title: titleFromTarget,
          ...(vars ?? {}),
        };
        // 替换 {{key}} 和 {{ key }}
        const rendered = tplText.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, k) =>
          builtins[k] !== undefined ? builtins[k] : `{{${k}}}`
        );
        const ct = textContentTypeForKey(target);
        await ctx.env.BEDROCK.put(target, encodeUtf8(rendered), { httpMetadata: { contentType: ct } });
        const unresolved = [...rendered.matchAll(/\{\{([\w-]+)\}\}/g)].map(m => m[1]);
        return ok(JSON.stringify({
          ok: true,
          template,
          target,
          appliedVars: builtins,
          unresolvedVars: [...new Set(unresolved)],
        }, null, 2));
      }
    );


    // 批量读取（一次拿多个文件的全文，省 round-trip）
    registerToolCompat(ctx.server,
      "doc_read_multiple",
      {
        keys: z.array(z.string().min(1)).min(1).max(20),
      },
      async ({ keys }) => {
        const results = await Promise.all(keys.map(async k => {
          const obj = await ctx.env.BEDROCK.get(k);
          if (!obj) return { key: k, found: false };
          return {
            key: k,
            found: true,
            modified: obj.uploaded.toISOString(),
            text: await obj.text(),
          };
        }));
        return ok(JSON.stringify(results, null, 2));
      }
    );
}
