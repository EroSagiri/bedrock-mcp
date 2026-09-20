import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../types";
import { TEXT_EXTS, isTextFile } from "@mineral/core/content";
import { stripDocumentExtension, validateDocumentKey } from "@mineral/core/keys";
import { backupTextDocument, moveDocument } from "@mineral/vault";

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

export const backupTextObject = backupTextDocument;
export const moveObject = moveDocument;
