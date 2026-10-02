import type { VaultDocuments } from "../service";

export async function backupTextDocument(documents: VaultDocuments, key: string, text: string, contentType?: string): Promise<string> {
  return documents.backupText(key, text, contentType);
}

export async function moveDocument(documents: VaultDocuments, from: string, to: string): Promise<void> {
  await documents.move(from, to);
}
