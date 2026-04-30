export function parseFrontmatter(text: string): { frontmatter: Record<string, string> | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: null, body: text };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (keyValue) frontmatter[keyValue[1]] = keyValue[2].trim();
  }

  return { frontmatter, body: text.slice(match[0].length) };
}

export function extractWikilinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g)) {
    links.add(match[1].trim());
  }
  return [...links];
}

export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)(#[\w\u4e00-\u9fa5/-]+)/g)) {
    tags.add(match[1]);
  }
  return [...tags];
}
