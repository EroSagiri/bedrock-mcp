import { encodeUtf8, textContentTypeForKey } from "@mineral/core/content";
import type { VaultDocuments } from "../service";

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function backupTextDocument(documents: VaultDocuments, key: string, text: string, contentType?: string): Promise<string> {
  const backupKey = `.history/${timestampSlug()}/${key}`;
  await documents.put({
    key: backupKey,
    bytes: encodeUtf8(text),
    contentType: textContentTypeForKey(key, contentType),
    customMetadata: { sourceKey: key, createdAt: new Date().toISOString() },
  });
  return backupKey;
}

export async function moveDocument(documents: VaultDocuments, from: string, to: string): Promise<void> {
  const source = await documents.get(from);
  if (!source) throw new Error(`Not found: ${from}`);
  await documents.put({ key: to, bytes: source.bytes, contentType: source.contentType ?? undefined, customMetadata: source.customMetadata ?? undefined });
  await documents.delete(from);
}
