import { applyPatch, createPatch } from "diff";
import { z } from "zod";
import { registerToolCompat } from "../compat";
import { TEXT_EXTS, encodeUtf8, guessContentType, isTextFile, textContentTypeForKey } from "../../storage/content";
import { backlinkTargets, scanTextFiles } from "../../storage/r2";
import { extractTags, extractWikilinks, parseFrontmatter } from "../../utils/markdown";
import { buildMatcher, snippet, snippetAt } from "../../utils/search";
import { relativeTime } from "../../utils/time";
import { assertTextKey, backupTextObject, err, keyError, moveObject, ok, stripTextExt, trashKey, wikilinkReplacement, type McpRegistrationContext } from "../shared";
import { createStaticAccessToken, normalizeStaticPrefix } from "../../auth/static-token";

export function registerFileTools(ctx: McpRegistrationContext): void {

    // 给 Agent 签发短期静态资源读取凭证
    registerToolCompat(ctx.server,
      "file_create_access_token",
      {
        prefix: z.string().optional().describe("允许访问的路径前缀，例如 '附件/'；默认允许普通静态资源"),
        expiresIn: z.number().int().min(30).max(3600).optional().describe("有效秒数，默认 600，最长 3600"),
      },
      async ({ prefix, expiresIn }) => {
        if (!ctx.env.STATIC_ACCESS_SECRET) {
          return err("STATIC_ACCESS_SECRET is not configured");
        }
        const normalizedPrefix = normalizeStaticPrefix(prefix);
        if (normalizedPrefix === null) return err("Invalid or protected prefix");
        const issued = await createStaticAccessToken(
          ctx.env.STATIC_ACCESS_SECRET,
          normalizedPrefix,
          expiresIn ?? 600
        );
        const baseUrl = ctx.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? null;
        return ok(JSON.stringify({
          token: issued.token,
          tokenType: "Bearer",
          authorization: `Bearer ${issued.token}`,
          expiresAt: new Date(issued.expiresAt * 1000).toISOString(),
          expiresIn: expiresIn ?? 600,
          prefix: normalizedPrefix,
          methods: ["GET", "HEAD"],
          baseUrl: baseUrl ? `${baseUrl}/static/` : null,
          usage: "Send the token in the Authorization header when requesting /static/<key>.",
        }, null, 2));
      }
    );

    // 删除文档：默认软删除到 .trash；permanent=true 才硬删除
    registerToolCompat(ctx.server,
      "file_delete",
      {
        key: z.string().min(1),
        permanent: z.boolean().optional().describe("默认 false，移动到 .trash；true 才永久删除"),
        dryRun: z.boolean().optional().describe("只返回将执行的操作"),
      },
      async ({ key, permanent, dryRun }) => {
        const invalid = keyError(key);
        if (invalid) return err(invalid);
        const existed = await ctx.env.MINERAL.head(key);
        if (!existed) return err(`Not found: ${key}`);
        if (dryRun) {
          return ok(JSON.stringify({
            ok: true,
            dryRun: true,
            key,
            action: permanent ? "delete" : "trash",
            trashKey: permanent ? null : trashKey(key),
          }, null, 2));
        }
        if (!permanent) {
          const target = trashKey(key);
          await moveObject(ctx.env.MINERAL, key, target);
          return ok(JSON.stringify({ ok: true, key, action: "trashed", trashKey: target }, null, 2));
        }
        await ctx.env.MINERAL.delete(key);
        return ok(JSON.stringify({ ok: true, key, action: "deleted", permanent: true }, null, 2));
      }
    );


    // 批量删除（最多 100 个）：默认软删除到 .trash
    registerToolCompat(ctx.server,
      "file_delete_many",
      {
        keys: z.array(z.string().min(1)).min(1).max(100),
        permanent: z.boolean().optional().describe("默认 false，移动到 .trash；true 才永久删除"),
        dryRun: z.boolean().optional(),
      },
      async ({ keys, permanent, dryRun }) => {
        for (const key of keys) {
          const invalid = keyError(key);
          if (invalid) return err(`${key}: ${invalid}`);
        }
        const plan = keys.map(key => ({
          key,
          action: permanent ? "delete" : "trash",
          trashKey: permanent ? null : trashKey(key),
        }));
        if (dryRun) return ok(JSON.stringify({ ok: true, dryRun: true, count: keys.length, plan }, null, 2));
        if (!permanent) {
          for (const item of plan) {
            const existed = await ctx.env.MINERAL.head(item.key);
            if (existed && item.trashKey) await moveObject(ctx.env.MINERAL, item.key, item.trashKey);
          }
          return ok(JSON.stringify({ ok: true, action: "trashed", count: keys.length, items: plan }, null, 2));
        }
        await ctx.env.MINERAL.delete(keys);
        return ok(JSON.stringify({ ok: true, action: "deleted", permanent: true, deleted: keys.length, keys }, null, 2));
      }
    );


    // 上传二进制文件（图片/PDF/任意类型，base64 传输）
    registerToolCompat(ctx.server,
      "file_upload_binary",
      {
        key: z.string().min(1).describe("R2 key，例如 '附件/photo.jpg'"),
        base64: z.string().min(1).describe("文件内容的 base64 编码"),
        contentType: z.string().optional().describe("MIME 类型；不传则按扩展名推断"),
      },
      async ({ key, base64, contentType }) => {
        // 解码 base64
        let bytes: Uint8Array;
        try {
          const bin = atob(base64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch {
          return err("base64 解码失败");
        }
        // 限制 10MB 避免 worker OOM
        const MAX = 10 * 1024 * 1024;
        if (bytes.byteLength > MAX) {
          return err(`文件过大 (${bytes.byteLength} bytes)，上限 ${MAX}。大文件请直接 PUT /static/<key> 或 POST /upload`);
        }
        const ct = contentType ?? guessContentType(key);
        await ctx.env.MINERAL.put(key, bytes, { httpMetadata: { contentType: ct } });
        return ok(JSON.stringify({
          ok: true,
          key,
          size: bytes.byteLength,
          contentType: ct,
          publicPath: `/static/${key}`,
          tip: "用 file_public_url 拿完整 URL 嵌到 markdown 里",
        }, null, 2));
      }
    );


    // 取静态资源的公开 URL（用于嵌入 markdown / 分享）
    registerToolCompat(ctx.server,
      "file_public_url",
      {
        key: z.string().min(1),
      },
      async ({ key }) => {
        const obj = await ctx.env.MINERAL.head(key);
        if (!obj) return err(`Not found: ${key}`);
        return ok(JSON.stringify({
          key,
          publicPath: `/static/${key}`,
          markdown: `![${key.split("/").pop()}](/static/${encodeURI(key)})`,
          note: "完整 URL 需要拼上 worker 域名，例如 https://mineral-mcp.<account>.workers.dev/static/<key>。本地 dev 是 http://127.0.0.1:8787/static/<key>。",
          contentType: obj.httpMetadata?.contentType ?? null,
          size: obj.size,
        }, null, 2));
      }
    );


    // 创建文件夹（R2 没有真正的目录概念，写一个 .keep 占位文件）
    registerToolCompat(ctx.server,
      "file_create_folder",
      {
        path: z.string().min(1).describe("文件夹路径，例如 '新项目/草稿'"),
      },
      async ({ path }) => {
        const folder = path.replace(/\/+$/, "");
        const placeholder = `${folder}/.keep`;
        const existed = await ctx.env.MINERAL.head(placeholder);
        if (existed) return ok(JSON.stringify({ ok: true, folder, action: "exists" }, null, 2));
        await ctx.env.MINERAL.put(placeholder, encodeUtf8(""), {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        return ok(JSON.stringify({
          ok: true,
          folder,
          action: "created",
          note: "R2 没有真正的目录，已创建 .keep 占位。直接写入 '<folder>/xxx.md' 也会让目录'出现'。",
        }, null, 2));
      }
    );


    // 移动/重命名（copy + delete）
    registerToolCompat(ctx.server,
      "file_move",
      {
        from: z.string().min(1),
        to: z.string().min(1),
        overwrite: z.boolean().optional().describe("目标存在时是否覆盖，默认 false"),
      },
      async ({ from, to, overwrite }) => {
        const fromInvalid = keyError(from);
        if (fromInvalid) return err(fromInvalid);
        const toInvalid = keyError(to);
        if (toInvalid) return err(toInvalid);
        if (from === to) return err("from 和 to 相同");
        const src = await ctx.env.MINERAL.get(from);
        if (!src) return err(`源文件不存在：${from}`);
        if (!overwrite) {
          const dst = await ctx.env.MINERAL.head(to);
          if (dst) return err(`目标已存在，传 overwrite: true 强制覆盖：${to}`);
        }
        await ctx.env.MINERAL.put(to, src.body, {
          httpMetadata: src.httpMetadata,
          customMetadata: src.customMetadata,
        });
        await ctx.env.MINERAL.delete(from);
        return ok(JSON.stringify({ ok: true, from, to }, null, 2));
      }
    );
}
