import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../types";
import type { VaultClient, VaultDocumentMetadata } from "../vault-client";
import { TEXT_EXTS, isTextFile } from "@mineral/core/content";
import { stripDocumentExtension, validateDocumentKey } from "@mineral/core/keys";

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

export const keyError = validateDocumentKey;

export function assertTextKey(key: string): string | null {
  return keyError(key) ?? (isTextFile(key) ? null : `Only text extensions are allowed (${TEXT_EXTS.join(", ")}), got ${key}`);
}

export function trashKey(key: string): string {
  return `.trash/${new Date().toISOString().replace(/[:.]/g, "-")}/${key}`;
}

export const stripTextExt = stripDocumentExtension;

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

export const decodeDocumentText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export const backupTextObject = (documents: VaultClient["documents"], key: string, text: string, contentType?: string) => documents.backupText(key, text, contentType);
export const moveObject = (documents: VaultClient["documents"], from: string, to: string) => documents.move(from, to);

export async function listAllDocuments(vault: VaultClient, prefix?: string): Promise<VaultDocumentMetadata[]> {
  const items: VaultDocumentMetadata[] = [];
  let cursor: string | undefined;
  do {
    const page = await vault.documents.list({ prefix, cursor, limit: 1000 });
    items.push(...page.items);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return items;
}

export async function scanTextDocuments<T>(vault: VaultClient, prefix: string | undefined, fn: (key: string, text: string, metadata: VaultDocumentMetadata) => T | null | Promise<T | null>, options: { max?: number } = {}): Promise<T[]> {
  const values: T[] = [];
  for (const item of await listAllDocuments(vault, prefix)) {
    if (!isTextFile(item.key)) continue;
    const document = await vault.documents.get(item.key);
    if (!document) continue;
    const value = await fn(item.key, decodeDocumentText(document.bytes), item);
    if (value !== null) values.push(value);
    if (values.length >= (options.max ?? Infinity)) break;
  }
  return values;
}
