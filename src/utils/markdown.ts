export function parseFrontmatter(text: string): { frontmatter: Record<string, string> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

export function extractWikilinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g)) {
    out.add(m[1].trim());
  }
  return [...out];
}

export function extractTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)(#[\w一-龥\/-]+)/g)) {
    out.add(m[1]);
  }
  return [...out];
}
