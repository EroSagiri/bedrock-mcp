import { describe, expect, it } from "vitest";
import { bindings, vaultIndex } from "./support";

/**
 * Whether the index is in a position to answer at all.
 *
 * A query tool must never fall back to walking R2, so "I have not been built yet" has to be a fact the
 * index can report. It is not the same as an incomplete index: a vault that is merely behind produces
 * results with `partial: true`, while an index that has never published anything produces no answer and a
 * remedy. An *empty* vault that has been audited is ready — it is empty, which is a real answer.
 */
type IndexStub = {
  resetMutationState(): Promise<void>;
  probeSql(sql: string): Promise<{ ok: boolean; rows?: Array<Record<string, unknown>>; error?: string }>;
  applyIndexIntent(input: { path: string; action: "upsert" | "remove" }): Promise<unknown>;
  startIndexAudit(now: number): Promise<{ auditId: number }>;
  runIndexAuditPage(): Promise<{ done: boolean } | null>;
  fetch(request: Request): Promise<Response>;
};

const index = () => vaultIndex() as unknown as IndexStub;
const encoder = new TextEncoder();
const query = async (kind: string, input: Record<string, unknown> = {}) =>
  (await (await index().fetch(new Request("https://vault-index/query", { method: "POST", body: JSON.stringify({ kind, ...input }) }))).json()) as Record<string, unknown>;

describe("an index that has never run", () => {
  it("reports itself as not ready, rather than as an empty vault", async () => {
    const stub = index();
    await stub.resetMutationState();
    // `resetMutationState` clears the tables but not the marker that an audit once ran; forgetting the
    // meta is what makes this look like an install that has never indexed anything.
    await stub.probeSql("DELETE FROM index_meta");

    const result = await query("search", { query: "anything" });
    expect(result.indexReady).toBe(false);
    expect(result.documents).toBe(0);
    expect(result.lastAuditAt).toBeNull();
    // The freshness fields still describe what is known, so the refusal can be specific.
    expect(result.indexVersion).toBe(1);
  });

  it("becomes ready once an audit has walked the vault, even an empty one", async () => {
    const stub = index();
    await stub.resetMutationState();
    await stub.probeSql("DELETE FROM index_meta");

    await stub.startIndexAudit(Date.now());
    await stub.runIndexAuditPage();

    const result = await query("stats", {});
    expect(result.indexReady).toBe(true);
    expect(result.lastAuditAt).toBeTruthy();
  });

  it("becomes ready as soon as one document is published", async () => {
    const stub = index();
    await stub.resetMutationState();
    await stub.probeSql("DELETE FROM index_meta");
    await bindings().MINERAL.put("ready/one.md", encoder.encode("# One\n\nbody\n"));
    await stub.applyIndexIntent({ path: "ready/one.md", action: "upsert" });

    const result = await query("search", { query: "One" });
    expect(result.indexReady).toBe(true);
    expect(result.indexedAt).toBeTruthy();
    expect((result.results as unknown[])).toHaveLength(1);
  });
});

describe("statistics come from the index too", () => {
  it("derives counts, sizes and folders from the indexed rows", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    await env.MINERAL.put("stats/a.md", encoder.encode("# A\n\nshort\n"));
    await env.MINERAL.put("stats/deep/b.md", encoder.encode("# B\n\n" + "x".repeat(400) + "\n"));
    await stub.applyIndexIntent({ path: "stats/a.md", action: "upsert" });
    await stub.applyIndexIntent({ path: "stats/deep/b.md", action: "upsert" });

    const stats = await query("stats", {});
    expect(stats.total).toMatchObject({ count: 2 });
    expect((stats.total as { earliest: string }).earliest).toBeTruthy();
    expect(stats.largest).toMatchObject({ key: "stats/deep/b.md" });
    expect(stats.smallest).toMatchObject({ key: "stats/a.md" });
    expect((stats.folders as Array<{ folder: string; count: number }>).sort((a, b) => a.folder.localeCompare(b.folder)))
      .toEqual([expect.objectContaining({ folder: "stats", count: 2 })]);
    // A statistic and a search cannot disagree about which documents exist, because they read one table.
    expect(stats.indexReady).toBe(true);
  });
});

describe("link queries are indexed queries", () => {
  it("answers backlinks and outgoing links from the links table", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    await env.MINERAL.put("links/target.md", encoder.encode("# Target\n\nnothing links out of here\n"));
    await env.MINERAL.put("links/source.md", encoder.encode("# Source\n\nSee [[links/target]] and [[nowhere]].\n"));
    await stub.applyIndexIntent({ path: "links/target.md", action: "upsert" });
    await stub.applyIndexIntent({ path: "links/source.md", action: "upsert" });

    const backlinks = await query("backlinks", { key: "links/target.md" });
    expect((backlinks.links as Array<{ key: string; via: string }>)).toEqual([expect.objectContaining({ key: "links/source.md", via: "links/target" })]);

    const outgoing = await query("outgoing", { key: "links/source.md" });
    expect((outgoing.links as Array<{ link: string }>).map(link => link.link).sort()).toEqual(["links/target", "nowhere"]);

    // `nowhere` is not a document, which is what makes it a dangling link rather than a mistake here.
    const graph = await query("graph", {});
    expect(graph).toMatchObject({ danglingCount: 1 });
    expect(graph.indexReady).toBe(true);
  });

  it("counts degrees over the whole graph, not over the page it returns", async () => {
    const stub = index();
    await stub.resetMutationState();
    const env = bindings();
    await env.MINERAL.put("graph/hub.md", encoder.encode("# Hub\n\nlinks to [[graph/leaf]]\n"));
    await env.MINERAL.put("graph/leaf.md", encoder.encode("# Leaf\n\nno outgoing links\n"));
    await env.MINERAL.put("graph/lonely.md", encoder.encode("# Lonely\n\nnothing at all\n"));
    for (const key of ["graph/hub.md", "graph/leaf.md", "graph/lonely.md"]) await stub.applyIndexIntent({ path: key, action: "upsert" });

    // A limit smaller than the vault used to throw here: the edge set referenced nodes the page had left
    // out, and the degree lookup dereferenced a node that was not in it.
    const page = await query("graph", { prefix: "graph/", limit: 1 });
    expect(page.nodeCount).toBe(1);
    expect(page.totalNodes).toBe(3);
    expect(page.edgeCount).toBe(1);
    expect((page.nodes as Array<{ key: string }>)).toHaveLength(1);

    const orphans = await query("graph", { operation: "orphans", mode: "isolated", prefix: "graph/", limit: 1 });
    // `lonely` is the only isolated note, and it is found even though only one node fits in the page.
    expect(orphans).toMatchObject({ orphanCount: 1, nodeCount: 3 });
    expect((orphans.nodes as Array<{ key: string; inDegree: number; outDegree: number }>)[0]).toMatchObject({ key: "graph/lonely.md", inDegree: 0, outDegree: 0 });

    const neighbors = await query("graph", { operation: "neighbors", key: "graph/hub.md", depth: 1, prefix: "graph/" });
    expect((neighbors.nodes as Array<{ key: string }>).map(node => node.key)).toEqual(["graph/hub.md", "graph/leaf.md"]);
  });
});
