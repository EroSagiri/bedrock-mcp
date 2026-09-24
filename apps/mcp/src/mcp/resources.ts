import { ResourceTemplate } from "@modelcontextprotocol/server";
import { isTextFile } from "@mineral/core/content";
import { readIndex } from "./index-client";
import { relativeTime } from "../utils/time";
import { registerResourceCompat } from "./compat";
import { type McpRegistrationContext } from "./shared";
import type { VaultDocuments, VaultDocumentMetadata } from "../vault-client";

const COMPLETION_LIMIT = 50;

function isSystemKey(key: string): boolean {
  return key.startsWith(".history/") || key.startsWith(".trash/");
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

function decodeVar(value: unknown): string {
  const text = String(value);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function dateFromKey(key: string): string | null {
  const match = /(\d{4})-?(\d{2})-?(\d{2})/.exec(key);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

async function listTextObjects(bucket: VaultDocuments, prefix?: string): Promise<VaultDocumentMetadata[]> {
  const objects: VaultDocumentMetadata[] = [];
  let cursor: string | undefined;
  do {
    const result = await bucket.list({ prefix, cursor, limit: 1000, include: ["httpMetadata"] });
    objects.push(...result.objects.filter(o => isTextFile(o.key) && !isSystemKey(o.key)));
    cursor = result.cursor ?? undefined;
  } while (cursor);
  return objects;
}

async function completeKeys(bucket: VaultDocuments, value: string): Promise<string[]> {
  const keys = (await listTextObjects(bucket))
    .map(o => o.key)
    .filter(key => key.toLowerCase().includes(value.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  return keys.slice(0, COMPLETION_LIMIT);
}

async function completeDates(bucket: VaultDocuments, value: string): Promise<string[]> {
  const dates = new Set<string>();
  for (const object of await listTextObjects(bucket)) {
    const date = dateFromKey(object.key);
    if (date && date.includes(value)) dates.add(date);
  }
  return [...dates].sort((a, b) => b.localeCompare(a)).slice(0, COMPLETION_LIMIT);
}

/**
 * Tag completion, from the index.
 *
 * A completion list is asked for on nearly every keystroke in a picker, and reading every document to
 * build it would be one RPC per note — the same cost as the live scan this product no longer has, and the
 * same hard failure on a vault past the subrequest ceiling. The tags are already in `document_tags`, and
 * the index matches a fragment of a name, which is what a partially typed tag is.
 */
async function completeTags(ctx: McpRegistrationContext, value: string): Promise<string[]> {
  const fragment = value.replace(/^#+/, "").trim();
  const outcome = await readIndex<{ tags?: Array<{ tag: string }> }>(ctx.env, "tags", { contains: fragment || undefined, limit: COMPLETION_LIMIT });
  if (!outcome.ok) return [];
  return (outcome.data.tags ?? []).map(item => item.tag).slice(0, COMPLETION_LIMIT);
}

async function collectFolderPrefixes(bucket: VaultDocuments): Promise<Array<{ folder: string; count: number; lastModified: Date }>> {
  const folders = new Map<string, { count: number; lastModified: Date }>();
  for (const object of await listTextObjects(bucket)) {
    const parts = object.key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = `${parts.slice(0, i).join("/")}/`;
      const current = folders.get(folder);
      if (current) {
        current.count++;
        if (object.uploaded > current.lastModified) current.lastModified = object.uploaded;
      } else {
        folders.set(folder, { count: 1, lastModified: object.uploaded });
      }
    }
  }
  return [...folders.entries()]
    .map(([folder, value]) => ({ folder, ...value }))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

async function completeFolders(bucket: VaultDocuments, value: string): Promise<string[]> {
  const needle = value.toLowerCase();
  return (await collectFolderPrefixes(bucket))
    .map(item => item.folder)
    .filter(folder => folder.toLowerCase().includes(needle))
    .slice(0, COMPLETION_LIMIT);
}

export function registerMineralResources(ctx: McpRegistrationContext): void {
  registerResourceCompat(
    ctx.server,
    "res_doc",
    new ResourceTemplate("mineral://doc/{key}", {
      list: async () => ({
        resources: (await listTextObjects(ctx.env.vault.documents)).map(object => ({
          uri: `mineral://doc/${encodeURIComponent(object.key)}`,
          name: object.key,
          description: `${object.size} bytes, ${relativeTime(object.uploaded)}`,
          mimeType: object.httpMetadata?.contentType ?? "text/markdown",
        })),
      }),
      complete: {
        key: value => completeKeys(ctx.env.vault.documents, value),
      },
    }),
    { description: "读取 vault 中的一篇文本笔记。", mimeType: "text/markdown" },
    async (uri, { key }) => {
      const decodedKey = decodeVar(key);
      const obj = await ctx.env.vault.documents.get(decodedKey);
      if (!obj) throw new Error(`Not found: ${key}`);
      return {
        contents: [{
          uri: uri.href,
          mimeType: obj.httpMetadata?.contentType ?? "text/markdown",
          text: await obj.text(),
        }],
      };
    }
  );

  registerResourceCompat(
    ctx.server,
    "res_vault_stats",
    "mineral://stats",
    { description: "vault 总览：文件数、大小、目录分布、活跃度。", mimeType: "application/json" },
    async uri => {
      const folderStats = new Map<string, { count: number; size: number; lastModified: Date }>();
      let totalCount = 0;
      let totalSize = 0;
      let latest: Date | null = null;
      let cursor: string | undefined;
      do {
        const result = await ctx.env.vault.documents.list({ cursor, limit: 1000 });
        for (const object of result.objects.filter(o => !isSystemKey(o.key))) {
          totalCount++;
          totalSize += object.size;
          if (!latest || object.uploaded > latest) latest = object.uploaded;
          const top = object.key.includes("/") ? object.key.split("/")[0] : "(root)";
          const current = folderStats.get(top);
          if (current) {
            current.count++;
            current.size += object.size;
            if (object.uploaded > current.lastModified) current.lastModified = object.uploaded;
          } else {
            folderStats.set(top, { count: 1, size: object.size, lastModified: object.uploaded });
          }
        }
        cursor = result.cursor ?? undefined;
      } while (cursor);

      return jsonResource(uri, {
        totalFiles: totalCount,
        totalSize,
        latest: latest?.toISOString() ?? null,
        latestRelative: latest ? relativeTime(latest) : null,
        folders: [...folderStats.entries()]
          .map(([folder, value]) => ({
            folder,
            count: value.count,
            size: value.size,
            lastModified: value.lastModified.toISOString(),
            lastModifiedRelative: relativeTime(value.lastModified),
          }))
          .sort((a, b) => b.count - a.count),
      });
    }
  );

  registerResourceCompat(
    ctx.server,
    "res_vault_recent",
    "mineral://recent",
    { description: "最近修改的 30 篇文本笔记。", mimeType: "application/json" },
    async uri => jsonResource(
      uri,
      (await listTextObjects(ctx.env.vault.documents))
        .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
        .slice(0, 30)
        .map(object => ({
          key: object.key,
          modified: object.uploaded.toISOString(),
          modifiedRelative: relativeTime(object.uploaded),
          size: object.size,
        }))
    )
  );

  registerResourceCompat(
    ctx.server,
    "res_vault_folders",
    "mineral://folders",
    { description: "vault 文件夹前缀及文本文件数。", mimeType: "application/json" },
    async uri => jsonResource(
      uri,
      (await collectFolderPrefixes(ctx.env.vault.documents)).map(item => ({
        folder: item.folder,
        count: item.count,
        lastModified: item.lastModified.toISOString(),
        lastModifiedRelative: relativeTime(item.lastModified),
      }))
    )
  );

  registerResourceCompat(
    ctx.server,
    "res_folder",
    new ResourceTemplate("mineral://folder/{path}", {
      list: async () => ({
        resources: (await collectFolderPrefixes(ctx.env.vault.documents)).map(item => ({
          uri: `mineral://folder/${encodeURIComponent(item.folder)}`,
          name: item.folder,
          description: `${item.count} text files, ${relativeTime(item.lastModified)}`,
          mimeType: "application/json",
        })),
      }),
      complete: {
        path: value => completeFolders(ctx.env.vault.documents, value),
      },
    }),
    { description: "按文件夹前缀浏览笔记。", mimeType: "application/json" },
    async (uri, { path }) => {
      const prefix = decodeVar(path).replace(/^\/+/, "").replace(/\/?$/, "/");
      const objects = await listTextObjects(ctx.env.vault.documents, prefix);
      return jsonResource(uri, {
        path: prefix,
        count: objects.length,
        totalSize: objects.reduce((sum, object) => sum + object.size, 0),
        items: objects
          .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
          .map(object => ({
            key: object.key,
            size: object.size,
            modified: object.uploaded.toISOString(),
            modifiedRelative: relativeTime(object.uploaded),
            contentType: object.httpMetadata?.contentType ?? null,
          })),
      });
    }
  );

  registerResourceCompat(
    ctx.server,
    "res_graph",
    "mineral://graph",
    { description: "vault wikilink 图谱：nodes、edges、dangling links。", mimeType: "application/json" },
    async uri => {
      const outcome = await readIndex(ctx.env, "graph", { includeDangling: true, limit: 1000 });
      // A resource cannot answer with an error result, so an index that cannot answer says so in its body.
      return jsonResource(uri, outcome.ok ? outcome.data : { error: "index_unavailable", detail: "索引无法回答，用 vault_index_refresh 触发审计与回填。" });
    }
  );
}
