import mime from "mime/lite";

export const TEXT_EXTS = [".md", ".txt", ".markdown", ".mdx"];

const MIME_OVERRIDES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".mdx": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function isTextFile(key: string): boolean {
  return TEXT_EXTS.some(ext => key.toLowerCase().endsWith(ext));
}

export function isTextContentType(contentType: string): boolean {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return mime.startsWith("text/")
    || mime === "application/json"
    || mime === "application/javascript"
    || mime === "application/xml"
    || mime.endsWith("+json")
    || mime.endsWith("+xml");
}

export function ensureUtf8ContentType(contentType: string): string {
  if (!isTextContentType(contentType) || /;\s*charset=/i.test(contentType)) return contentType;
  return `${contentType}; charset=utf-8`;
}

export function textContentTypeForKey(key: string, contentType?: string): string {
  const fallback = key.toLowerCase().endsWith(".md")
    ? "text/markdown"
    : "text/plain";
  return ensureUtf8ContentType(contentType ?? fallback);
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function guessContentType(key: string): string {
  const lower = key.toLowerCase();
  for (const [ext, contentType] of Object.entries(MIME_OVERRIDES)) {
    if (lower.endsWith(ext)) return ensureUtf8ContentType(contentType);
  }
  return ensureUtf8ContentType(mime.getType(key) ?? "application/octet-stream");
}
