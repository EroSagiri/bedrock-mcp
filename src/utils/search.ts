export type Matcher = { match(s: string): { index: number; length: number } | null };

export function snippet(text: string, query: string, ctx = 60): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text.slice(0, ctx * 2).replace(/\s+/g, " ");
  const start = Math.max(0, i - ctx);
  const end = Math.min(text.length, i + query.length + ctx);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

export function snippetAt(text: string, index: number, length: number, ctx = 60): string {
  const start = Math.max(0, index - ctx);
  const end = Math.min(text.length, index + length + ctx);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

export function buildMatcher(query: string, regex: boolean, caseSensitive: boolean): Matcher | { error: string } {
  if (regex) {
    try {
      const re = new RegExp(query, caseSensitive ? "" : "i");
      return {
        match(s) {
          const m = re.exec(s);
          if (!m) return null;
          return { index: m.index, length: m[0].length };
        },
      };
    } catch (e) {
      return { error: `无效正则: ${(e as Error).message}` };
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return {
    match(s) {
      const hay = caseSensitive ? s : s.toLowerCase();
      const idx = hay.indexOf(needle);
      return idx < 0 ? null : { index: idx, length: query.length };
    },
  };
}
