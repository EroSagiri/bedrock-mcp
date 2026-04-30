import { scanTextFiles } from "../storage/r2";
import { extractTags, extractWikilinks } from "../utils/markdown";
import { stripTextExt } from "./shared";

export type GraphOptions = {
  prefix?: string;
  includeDangling?: boolean;
  limit?: number;
};

export async function buildGraph(bucket: R2Bucket, options: GraphOptions = {}) {
  const files = await scanTextFiles(bucket, options.prefix, (key, text, obj) => {
    if (key.startsWith(".history/") || key.startsWith(".trash/")) return null;
    return {
      key,
      title: (key.split("/").pop() ?? key).replace(/\.[^.]+$/, ""),
      modified: obj.uploaded.toISOString(),
      size: obj.size,
      links: extractWikilinks(text),
      tags: extractTags(text),
    };
  }, { max: options.limit ?? 500 });

  const targetIndex = new Map<string, string>();
  for (const file of files) {
    const noExt = stripTextExt(file.key);
    const basename = noExt.split("/").pop() ?? noExt;
    targetIndex.set(file.key, file.key);
    targetIndex.set(noExt, file.key);
    targetIndex.set(basename, file.key);
  }

  const edges: Array<{ from: string; to: string | null; link: string; dangling: boolean }> = [];
  for (const file of files) {
    for (const link of file.links) {
      const resolved = targetIndex.get(link) ?? targetIndex.get(stripTextExt(link)) ?? null;
      if (resolved || options.includeDangling !== false) {
        edges.push({ from: file.key, to: resolved, link, dangling: !resolved });
      }
    }
  }

  const degree = new Map<string, { in: number; out: number }>();
  for (const file of files) degree.set(file.key, { in: 0, out: 0 });
  for (const edge of edges) {
    const from = degree.get(edge.from);
    if (from) from.out++;
    if (edge.to) {
      const to = degree.get(edge.to);
      if (to) to.in++;
    }
  }

  const nodes = files.map(file => ({
    key: file.key,
    title: file.title,
    modified: file.modified,
    size: file.size,
    tags: file.tags,
    inDegree: degree.get(file.key)?.in ?? 0,
    outDegree: degree.get(file.key)?.out ?? 0,
  }));

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    danglingCount: edges.filter(e => e.dangling).length,
    nodes,
    edges,
  };
}
