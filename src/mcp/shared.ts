import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../types";
import { TEXT_EXTS, encodeUtf8, isTextFile, textContentTypeForKey } from "../storage/content";

export type McpRegistrationContext = {
  env: Env;
  server: McpServer;
};

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function keyError(key: string): string | null {
  if (!key.trim()) return "key 不能为空";
  if (key.includes("..")) return "key 不能包含 '..'";
  if (key.startsWith("/") || key.endsWith("/")) return "key 不能以 / 开头或结尾";
  if (key.includes("//")) return "key 不能包含连续的 //";
  return null;
}

export function assertTextKey(key: string): string | null {
  return keyError(key) ?? (isTextFile(key) ? null : `仅允许文本扩展名 (${TEXT_EXTS.join(", ")})，收到 ${key}`);
}

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function historyKey(key: string): string {
  return `.history/${timestampSlug()}/${key}`;
}

export function trashKey(key: string): string {
  return `.trash/${timestampSlug()}/${key}`;
}

export function stripTextExt(key: string): string {
  return key.replace(/\.(md|markdown|mdx|txt)$/i, "");
}

export function wikilinkReplacement(text: string, targets: Set<string>, replacement: string): { text: string; changed: boolean } {
  let changed = false;
  const next = text.replace(/\[\[([^\]\n|#]+)((?:[#|][^\]\n]*)?)\]\]/g, (full, rawTarget: string, suffix: string) => {
    const target = rawTarget.trim();
    const basename = target.split("/").pop() ?? target;
    if (!targets.has(target) && !targets.has(basename)) return full;
    changed = true;
    return `[[${replacement}${suffix}]]`;
  });
  return { text: next, changed };
}

export async function backupTextObject(bucket: R2Bucket, key: string, text: string, contentType?: string): Promise<string> {
  const backupKey = historyKey(key);
  await bucket.put(backupKey, encodeUtf8(text), {
    httpMetadata: { contentType: textContentTypeForKey(key, contentType) },
    customMetadata: { sourceKey: key, createdAt: new Date().toISOString() },
  });
  return backupKey;
}

export async function moveObject(bucket: R2Bucket, from: string, to: string): Promise<void> {
  const src = await bucket.get(from);
  if (!src?.body) throw new Error(`Not found: ${from}`);
  await bucket.put(to, src.body, {
    httpMetadata: src.httpMetadata,
    customMetadata: src.customMetadata,
  });
  await bucket.delete(from);
}
