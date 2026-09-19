import { parseDocument } from "yaml";

export type Frontmatter = Record<string, unknown>;

export function parseFrontmatter(text: string): { frontmatter: Frontmatter | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) return { frontmatter: null, body: text.slice(match[0].length) };
  const value = document.toJSON();
  return {
    frontmatter: value && typeof value === "object" && !Array.isArray(value) ? value as Frontmatter : null,
    body: text.slice(match[0].length),
  };
}

export function extractWikilinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g)) {
    links.add(match[1].trim());
  }
  return [...links];
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "");
}

/** Keeps occurrences; callers that need document membership can deduplicate. */
export function extractTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)(#[\w\u4e00-\u9fa5/-]+)/g)) {
    const tag = normalizeTag(match[1]);
    if (tag) tags.push(tag);
  }
  return tags;
}

export function frontmatterTags(frontmatter: Frontmatter | null): string[] {
  const raw = frontmatter?.tags;
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return values.flatMap(value => typeof value === "string" ? value.split(",") : [])
    .map(normalizeTag)
    .filter(Boolean);
}
