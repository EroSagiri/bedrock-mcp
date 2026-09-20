import { encodeUtf8, textContentTypeForKey } from "@mineral/core/content";
import type { VaultDocuments } from "../service";

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export async function backupTextDocument(documents: VaultDocuments, key: string, text: string, contentType?: string): Promise<string> {
  const backupKey = `.history/${timestampSlug()}/${key}`;
  await documents.put(backupKey, encodeUtf8(text), {
    httpMetadata: { contentType: textContentTypeForKey(key, contentType) },
    customMetadata: { sourceKey: key, createdAt: new Date().toISOString() },
  });
  return backupKey;
}

export async function moveDocument(documents: VaultDocuments, from: string, to: string): Promise<void> {
  const source = await documents.get(from);
  if (!source?.body) throw new Error(`Not found: ${from}`);
  await documents.put(to, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata });
  await documents.delete(from);
}
