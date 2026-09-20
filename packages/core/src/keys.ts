export const TEXT_EXTENSIONS = [".md", ".txt", ".markdown", ".mdx"] as const;

export function isTextDocumentKey(key: string): boolean {
  return TEXT_EXTENSIONS.some(extension => key.toLowerCase().endsWith(extension));
}

export function validateDocumentKey(key: string): string | null {
  if (!key.trim()) return "key cannot be empty";
  if (key.includes("..")) return "key cannot contain '..'";
  if (key.startsWith("/") || key.endsWith("/")) return "key cannot start or end with /";
  if (key.includes("//")) return "key cannot contain consecutive //";
  return null;
}

export function stripDocumentExtension(key: string): string {
  return key.replace(/\.(md|markdown|mdx|txt)$/i, "");
}
