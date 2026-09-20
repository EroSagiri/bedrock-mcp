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

export async function buildNeighborGraph(bucket: R2Bucket, key: string, depth = 1, options: GraphOptions = {}) {
  const graph = await buildGraph(bucket, options);
  const selectedDepth = Math.max(1, Math.min(depth, 3));
  const selected = new Set<string>([key]);

  for (let level = 0; level < selectedDepth; level++) {
    const frontier = new Set(selected);
    for (const edge of graph.edges) {
      if (frontier.has(edge.from) && edge.to) selected.add(edge.to);
      if (edge.to && frontier.has(edge.to)) selected.add(edge.from);
    }
  }

  const nodes = graph.nodes.filter(node => selected.has(node.key));
  const edges = graph.edges.filter(edge => selected.has(edge.from) && (!edge.to || selected.has(edge.to)));
  return {
    key,
    depth: selectedDepth,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    danglingCount: edges.filter(edge => edge.dangling).length,
    nodes,
    edges,
  };
}
