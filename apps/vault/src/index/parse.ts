import { extractHeadings, extractTags, extractWikilinks, frontmatterTags, parseFrontmatter, type Frontmatter, type Heading } from "@mineral/core/markdown";

/**
 * The parse of one Markdown document, and the only place a document's text becomes index rows.
 *
 * One parse feeds every derived structure — frontmatter, tags, links, headings, and the full-text
 * body — because they are all views of the same text, and computing them separately would let them
 * describe different revisions of it.
 */
export type ParsedDocument = {
  key: string;
  title: string;
  frontmatter: Frontmatter | null;
  /** Frontmatter as rows: strings verbatim, everything else JSON, exactly as the legacy index stored it. */
  frontmatterRows: Array<{ field: string; value: string }>;
  /** Plain body, frontmatter removed. This is what full-text search matches against. */
  body: string;
  headings: Heading[];
  tags: Array<{ tag: string; source: "frontmatter" | "body"; occurrences: number }>;
  links: string[];
  /** Heading texts, for the full-text `headings` column. */
  headingText: string;
};

/** Counts occurrences, because a tag's reference count is part of the existing query surface. */
function tally(tags: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return counts;
}

export function titleOf(key: string, frontmatter: Frontmatter | null, headings: Heading[]): string {
  const declared = frontmatter?.title;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  const heading = headings.find(entry => entry.level === 1);
  if (heading) return heading.text;
  const basename = key.split("/").pop() ?? key;
  return basename.replace(/\.(md|markdown|mdx|txt)$/i, "");
}

/** The one parse. Everything the index stores about a document is derived here. */
export function parseDocument(key: string, text: string): ParsedDocument {
  const { frontmatter, body } = parseFrontmatter(text);
  const headings = extractHeadings(body);
  const tags = [
    ...[...tally(frontmatterTags(frontmatter))].map(([tag, occurrences]) => ({ tag, source: "frontmatter" as const, occurrences })),
    ...[...tally(extractTags(body))].map(([tag, occurrences]) => ({ tag, source: "body" as const, occurrences })),
  ];
  return {
    key,
    title: titleOf(key, frontmatter, headings),
    frontmatter,
    frontmatterRows: Object.entries(frontmatter ?? {}).map(([field, value]) => ({
      field,
      value: typeof value === "string" ? value : JSON.stringify(value),
    })),
    body,
    headings,
    tags,
    links: extractWikilinks(body),
    headingText: headings.map(entry => entry.text).join("\n"),
  };
}
