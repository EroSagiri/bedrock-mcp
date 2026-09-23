import { isTextDocumentKey } from "@mineral/core/keys";
import { extractTags, extractWikilinks, frontmatterTags, parseFrontmatter } from "@mineral/core/markdown";
import { DurableObject } from "cloudflare:workers";
import { SqlMutationStore, type SqlDatabase } from "../index/journal-store";
import type { IndexAction, IndexIntentSpec } from "../index/intents";
import type { DueIndexIntent, IndexClaim, PendingIndexSummary, RecordMutationResult } from "../mutation/store";
import type { JournalEntry, MutationEvent } from "../mutation/types";

type Env = { MINERAL: R2Bucket };
type Row = Record<string, unknown>;
const SYSTEM = [".history/", ".trash/", ".system/"];
const isIndexable = (key: string) => isTextDocumentKey(key) && !SYSTEM.some(prefix => key.startsWith(prefix));
const rows = (result: Iterable<Row>) => [...result];

/**
 * The single, named instance holds two different things that must not be conflated:
 *
 * - the **note index** — a rebuildable projection of MINERAL, which never stores document bodies;
 * - the **Mutation Journal** and its materialised `pending_index` dirty set — durable facts about
 *   authoritative R2 writes and the index work still owed for them.
 *
 * They live in one SQLite instance because `recordMutation()` must commit the journal fact and its
 * index intents together, and because the incremental indexer is the natural consumer of those
 * intents. The journal is never used as a work queue, and the dirty set is never used as a history.
 */
export class VaultIndex extends DurableObject<Env> {
  private readonly mutations: SqlMutationStore;
  /** The SQLite handle, so read-only diagnostics can query the journal directly. */
  private readonly db: SqlDatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = this.ctx.storage.sql as unknown as SqlDatabase;
    this.mutations = new SqlMutationStore(this.db);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (generation INTEGER NOT NULL, key TEXT NOT NULL, etag TEXT NOT NULL, modified TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT, PRIMARY KEY (generation, key));
      CREATE TABLE IF NOT EXISTS frontmatter_values (generation INTEGER NOT NULL, document_key TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_tags (generation INTEGER NOT NULL, document_key TEXT NOT NULL, tag TEXT NOT NULL, source TEXT NOT NULL, occurrences INTEGER NOT NULL, PRIMARY KEY (generation, document_key, tag, source));
      CREATE TABLE IF NOT EXISTS links (generation INTEGER NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, PRIMARY KEY (generation, from_key, to_key));
      CREATE TABLE IF NOT EXISTS refresh_seen (generation INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY (generation, key));
      CREATE INDEX IF NOT EXISTS documents_generation_modified ON documents(generation, modified DESC);
      CREATE INDEX IF NOT EXISTS tags_generation_tag ON document_tags(generation, tag);
      CREATE INDEX IF NOT EXISTS links_generation_to ON links(generation, to_key);
      CREATE INDEX IF NOT EXISTS frontmatter_generation_field ON frontmatter_values(generation, field, value);
    `);
  }

  /**
   * Test-only: drops the journal and the dirty set.
   *
   * It exists because the durable tests run against the real single named instance, and each case
   * must start from an empty journal. It deliberately touches neither the note index nor the
   * generation counters.
   */
  async resetMutationState(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM mutation_journal; DELETE FROM pending_index;");
  }

  private getMeta(key: string): string | null {
    return rows(this.ctx.storage.sql.exec("SELECT value FROM index_meta WHERE key = ?", key))[0]?.value as string | undefined ?? null;
  }
  private setMeta(key: string, value: string): void { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)", key, value); }
  private active(): number { return Number(this.getMeta("active_generation") ?? "0"); }
  private freshness() {
    return {
      generation: this.active(),
      indexedAt: this.getMeta("indexed_at"),
      /** The freshest revision this note index has actually observed; compared with R2 for staleness. */
      indexedEtag: this.getMeta("indexed_etag"),
      freshness: "eventual" as const,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Mutation ingress: the only path that writes a mutation fact.
  // ---------------------------------------------------------------------------------------------

  /**
   * `recordMutation()`'s durable half.
   *
   * The caller has already computed the index intents (`indexIntentsFor`); this method owns only the
   * atomicity: the fact and its intents commit in one transaction, so a crash between them is
   * impossible and a caller that sees a failure knows the whole write was abandoned.
   */
  async recordMutation(input: { event: MutationEvent; intents: IndexIntentSpec[] }): Promise<RecordMutationResult> {
    return this.ctx.storage.transactionSync(() => this.mutations.recordWithinTransaction(input.event, input.intents));
  }

  async findMutation(mutationId: string): Promise<JournalEntry | null> {
    return this.mutations.findByMutationId(mutationId);
  }

  /** The consumer-facing name for the same lookup; the RPC port calls it `findByMutationId`. */
  async findByMutationId(mutationId: string): Promise<JournalEntry | null> {
    return this.mutations.findByMutationId(mutationId);
  }

  // ---------------------------------------------------------------------------------------------
  // Sync Publisher: outbox reads and delivery bookkeeping.
  // ---------------------------------------------------------------------------------------------

  async listPendingBroadcasts(limit: number): Promise<JournalEntry[]> {
    return this.mutations.listPendingBroadcasts(limit);
  }

  async markBroadcast(input: { mutationId: string; state: "published" | "pending"; generation?: string; error?: string }): Promise<void> {
    this.mutations.markBroadcast(input);
  }

  /**
   * Aggregate journal state, for an operator asking "did the facts arrive, and did they leave?".
   *
   * Counts and the newest id only: the journal's paths are a knowledge base, and an endpoint that
   * lists them would be a way to read the vault without R2 credentials.
   */
  async journalState(): Promise<{
    total: number;
    pending: number;
    published: number;
    sources: Record<string, number>;
    lastSeq: number | null;
    lastMutationId: string | null;
  }> {
    const summary = rows(this.db.exec(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN broadcast_state = 'pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN broadcast_state = 'published' THEN 1 ELSE 0 END) published,
              MAX(seq) last_seq
       FROM mutation_journal`,
    ))[0] as { total: number; pending: number; published: number; last_seq: number | null } | undefined;
    const sources: Record<string, number> = {};
    for (const row of this.db.exec<{ source: string; count: number }>("SELECT source, COUNT(*) count FROM mutation_journal GROUP BY source")) {
      sources[row.source] = Number(row.count);
    }
    const last = summary?.last_seq
      ? rows(this.db.exec("SELECT mutation_id FROM mutation_journal WHERE seq = ?", summary.last_seq))[0] as { mutation_id: string } | undefined
      : undefined;
    return {
      total: Number(summary?.total ?? 0),
      pending: Number(summary?.pending ?? 0),
      published: Number(summary?.published ?? 0),
      sources,
      lastSeq: summary?.last_seq ?? null,
      lastMutationId: last?.mutation_id ?? null,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Index Scheduler: the durable dirty set.
  // ---------------------------------------------------------------------------------------------

  async pendingSummary(now: number): Promise<PendingIndexSummary> {
    return this.mutations.pendingSummary(now);
  }

  async listDueIndexPaths(now: number, limit: number): Promise<DueIndexIntent[]> {
    return this.mutations.listDueIndexPaths(now, limit);
  }

  async claimPendingIndex(input: { path: string; etag: string | null; action: IndexAction; now: number }): Promise<IndexClaim> {
    return this.mutations.claimPendingIndex(input);
  }

  async completeIndex(input: { path: string; etag: string | null; action: IndexAction }): Promise<boolean> {
    return this.mutations.completeIndex(input);
  }

  async failIndex(input: { path: string; etag: string | null; action: IndexAction; error: string; notBefore: number }): Promise<void> {
    this.mutations.failIndex(input);
  }

  /**
   * Applies one index intent against **current R2**, which is the only authoritative revision.
   *
   * The intent's `target_etag` is a hint about what the caller believed was owed; it is never
   * indexed directly. If R2 has already moved to a newer revision, that newer revision is what gets
   * indexed, and the returned `indexedEtag` records what was actually observed.
   */
  async applyIndexIntent(input: { path: string; action: IndexAction }): Promise<{ applied: true; indexedEtag: string | null } | { applied: false; error: string }> {
    const generation = this.active();
    try {
      if (!isIndexable(input.path)) {
        this.removeDocument(generation, input.path);
        return { applied: true, indexedEtag: null };
      }
      const object = await this.env.MINERAL.get(input.path);
      if (!object) {
        this.removeDocument(generation, input.path);
        return { applied: true, indexedEtag: null };
      }
      if (rows(this.ctx.storage.sql.exec("SELECT etag FROM documents WHERE generation = ? AND key = ?", generation, input.path))[0]?.etag === object.etag) {
        this.setMeta("indexed_etag", object.etag);
        return { applied: true, indexedEtag: object.etag };
      }
      this.removeDocument(generation, input.path);
      this.indexDocument(generation, object, await object.text());
      this.setMeta("indexed_at", new Date().toISOString());
      this.setMeta("indexed_etag", object.etag);
      return { applied: true, indexedEtag: object.etag };
    } catch (error) {
      return { applied: false, error: error instanceof Error ? error.message.slice(0, 200) : "index apply failed" };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const input = await request.json<Record<string, unknown>>();
    if (url.pathname === "/refresh") return Response.json(await this.refresh());
    if (url.pathname === "/query") return Response.json(this.query(String(input.kind ?? ""), input));
    if (url.pathname === "/mutation/summary") return Response.json(this.mutations.pendingSummary(Date.now()));
    return new Response("Not found", { status: 404 });
  }

  private async refresh(): Promise<Row> {
    if (this.getMeta("building_generation")) return { accepted: true, building: true, ...this.freshness() };
    const next = this.active() + 1;
    this.setMeta("building_generation", String(next));
    this.setMeta("refresh_cursor", "");
    await this.ctx.storage.setAlarm(Date.now());
    return { accepted: true, building: true, ...this.freshness() };
  }

  async alarm(): Promise<void> { await this.runPage(); }

  private copyUnchanged(from: number, to: number, key: string): void {
    this.ctx.storage.sql.exec("INSERT INTO documents SELECT ?, key, etag, modified, size, content_type FROM documents WHERE generation=? AND key=?", to, from, key);
    this.ctx.storage.sql.exec("INSERT INTO frontmatter_values SELECT ?, document_key, field, value FROM frontmatter_values WHERE generation=? AND document_key=?", to, from, key);
    this.ctx.storage.sql.exec("INSERT INTO document_tags SELECT ?, document_key, tag, source, occurrences FROM document_tags WHERE generation=? AND document_key=?", to, from, key);
    this.ctx.storage.sql.exec("INSERT INTO links SELECT ?, from_key, to_key FROM links WHERE generation=? AND from_key=?", to, from, key);
  }

  /** Drops every derived row for one key at one generation. Shared by delete and by re-index. */
  private removeDocument(generation: number, key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM documents WHERE generation = ? AND key = ?", generation, key);
    this.ctx.storage.sql.exec("DELETE FROM frontmatter_values WHERE generation = ? AND document_key = ?", generation, key);
    this.ctx.storage.sql.exec("DELETE FROM document_tags WHERE generation = ? AND document_key = ?", generation, key);
    this.ctx.storage.sql.exec("DELETE FROM links WHERE generation = ? AND from_key = ?", generation, key);
  }

  private indexDocument(generation: number, object: R2Object, text: string): void {
    const key = object.key;
    const { frontmatter, body } = parseFrontmatter(text);
    this.ctx.storage.sql.exec("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)", generation, key, object.etag, object.uploaded.toISOString(), object.size, object.httpMetadata?.contentType ?? null);
    for (const [field, value] of Object.entries(frontmatter ?? {})) {
      this.ctx.storage.sql.exec("INSERT INTO frontmatter_values VALUES (?, ?, ?, ?)", generation, key, field, typeof value === "string" ? value : JSON.stringify(value));
    }
    for (const [source, tags] of [["frontmatter", frontmatterTags(frontmatter)], ["body", extractTags(body)]] as const) {
      const count = new Map<string, number>();
      for (const tag of tags) count.set(tag, (count.get(tag) ?? 0) + 1);
      for (const [tag, occurrences] of count) this.ctx.storage.sql.exec("INSERT INTO document_tags VALUES (?, ?, ?, ?, ?)", generation, key, tag, source, occurrences);
    }
    for (const target of extractWikilinks(body)) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO links VALUES (?, ?, ?)", generation, key, target);
  }

  private async runPage(): Promise<void> {
    const building = Number(this.getMeta("building_generation") ?? "0");
    if (!building) return;
    const cursor = this.getMeta("refresh_cursor") || undefined;
    const active = this.active();
    const page = await this.env.MINERAL.list({ cursor, limit: 100 });
    for (const object of page.objects.filter(object => isIndexable(object.key))) {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO refresh_seen VALUES (?, ?)", building, object.key);
      const previous = rows(this.ctx.storage.sql.exec("SELECT etag FROM documents WHERE generation = ? AND key = ?", active, object.key))[0];
      if (previous?.etag === object.etag) this.copyUnchanged(active, building, object.key);
      else {
        const current = await this.env.MINERAL.get(object.key);
        if (current) this.indexDocument(building, object, await current.text());
      }
    }
    if (page.truncated) {
      this.setMeta("refresh_cursor", page.cursor ?? "");
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return;
    }
    // All writes before this point are private to the new generation. The
    // two public metadata values switch together in one SQLite statement;
    // readers select only active_generation and therefore never see a draft.
    for (const table of ["documents", "frontmatter_values", "document_tags", "links"] as const) {
      const keyColumn = table === "documents" ? "key" : table === "links" ? "from_key" : "document_key";
      this.ctx.storage.sql.exec(`DELETE FROM ${table} WHERE generation = ? AND ${keyColumn} NOT IN (SELECT key FROM refresh_seen WHERE generation = ?)`, building, building);
    }
    this.ctx.storage.sql.exec("INSERT INTO index_meta(key,value) VALUES ('active_generation', ?), ('indexed_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(building), new Date().toISOString());
    this.ctx.storage.sql.exec("DELETE FROM refresh_seen WHERE generation = ?", building);
    this.setMeta("building_generation", ""); this.setMeta("refresh_cursor", "");
    for (const table of ["documents", "frontmatter_values", "document_tags", "links"] as const) this.ctx.storage.sql.exec(`DELETE FROM ${table} WHERE generation <> ?`, building);
  }

  private query(kind: string, input: Record<string, unknown>): Row {
    const generation = this.active(); const limit = Math.min(Number(input.limit ?? 100), 1000); const prefix = String(input.prefix ?? "");
    const meta = this.freshness();
    if (kind === "tags") {
      const sources = (input.sources as string[] | undefined) ?? ["frontmatter", "body"];
      const sourceMarks = sources.map(() => "?").join(","); const tagPrefix = String(input.tagPrefix ?? "");
      const data = rows(this.ctx.storage.sql.exec(`SELECT tag, SUM(occurrences) referenceCount, COUNT(DISTINCT document_key) documentCount, SUM(CASE WHEN source='frontmatter' THEN occurrences ELSE 0 END) frontmatterReferences, SUM(CASE WHEN source='body' THEN occurrences ELSE 0 END) bodyReferences FROM document_tags WHERE generation=? AND source IN (${sourceMarks}) AND tag LIKE ? GROUP BY tag HAVING referenceCount >= ? ORDER BY tag LIMIT ?`, generation, ...sources, `${tagPrefix}%`, Number(input.minReferences ?? 1), limit));
      return { ...meta, source: "index", tags: data };
    }
    if (kind === "tag-documents") {
      const tag = String(input.tag); const descendants = input.match === "descendants"; const sources = (input.sources as string[] | undefined) ?? ["frontmatter", "body"];
      const sourceMarks = sources.map(() => "?").join(",");
      const tagCondition = descendants ? "(t.tag = ? OR t.tag LIKE ?)" : "t.tag = ?";
      const tagArgs: unknown[] = descendants ? [tag, `${tag}/%`] : [tag];
      const data = rows(this.ctx.storage.sql.exec(`SELECT d.key, d.modified, SUM(CASE WHEN t.source='frontmatter' THEN t.occurrences ELSE 0 END) frontmatterReferences, SUM(CASE WHEN t.source='body' THEN t.occurrences ELSE 0 END) bodyReferences FROM document_tags t JOIN documents d ON d.generation=t.generation AND d.key=t.document_key WHERE t.generation=? AND t.source IN (${sourceMarks}) AND ${tagCondition} AND d.key LIKE ? GROUP BY d.key, d.modified ORDER BY d.modified DESC LIMIT ?`, generation, ...sources, ...tagArgs, `${prefix}%`, limit));
      return { ...meta, source: "index", documents: data };
    }
    if (kind === "frontmatter") {
      const field = String(input.field); const clauses = ["f.generation=?", "f.field=?", "d.key LIKE ?"]; const args: unknown[] = [generation, field, `${prefix}%`];
      if (input.value !== undefined) { clauses.push("f.value=?"); args.push(String(input.value)); }
      if (input.contains !== undefined) { clauses.push("LOWER(f.value) LIKE ?"); args.push(`%${String(input.contains).toLowerCase()}%`); }
      return { ...meta, source: "index", matches: rows(this.ctx.storage.sql.exec(`SELECT d.key,d.modified,f.value FROM frontmatter_values f JOIN documents d ON d.generation=f.generation AND d.key=f.document_key WHERE ${clauses.join(" AND ")} ORDER BY d.modified DESC LIMIT ?`, ...args, limit)) };
    }
    if (kind === "outgoing") return { ...meta, source: "index", links: rows(this.ctx.storage.sql.exec("SELECT to_key link FROM links WHERE generation=? AND from_key=?", generation, String(input.key))) };
    if (kind === "backlinks") return { ...meta, source: "index", links: rows(this.ctx.storage.sql.exec("SELECT d.key,d.modified,l.to_key via FROM links l JOIN documents d ON d.generation=l.generation AND d.key=l.from_key WHERE l.generation=? AND l.to_key=? ORDER BY d.modified DESC LIMIT ?", generation, String(input.key).replace(/\.(md|markdown|mdx|txt)$/i, ""), limit)) };
    if (kind === "recent") return { ...meta, source: "index", items: rows(this.ctx.storage.sql.exec("SELECT key,modified,size FROM documents WHERE generation=? AND key LIKE ? ORDER BY modified DESC LIMIT ?", generation, `${prefix}%`, limit)) };
    if (kind === "folders") return { ...meta, source: "index", items: rows(this.ctx.storage.sql.exec("SELECT CASE WHEN instr(key,'/')=0 THEN '(root)' ELSE substr(key,1,instr(key,'/')-1) END folder, COUNT(*) count, MAX(modified) lastModified FROM documents WHERE generation=? GROUP BY folder ORDER BY lastModified DESC", generation)) };
    if (kind === "stats") return { ...meta, source: "index", total: rows(this.ctx.storage.sql.exec("SELECT COUNT(*) count, COALESCE(SUM(size),0) sizeBytes FROM documents WHERE generation=?", generation))[0] ?? { count: 0, sizeBytes: 0 } };
    if (kind === "graph") {
      const graph = this.graph(generation, prefix, limit);
      if (input.operation === "orphans") {
        const mode = String(input.mode ?? "isolated");
        return { ...meta, source: "index", mode, items: graph.nodes.filter(node => mode === "noIncoming" ? node.inDegree === 0 : mode === "noOutgoing" ? node.outDegree === 0 : node.inDegree === 0 && node.outDegree === 0) };
      }
      if (input.operation === "neighbors") {
        const selected = new Set<string>([String(input.key)]); const depth = Math.max(1, Math.min(Number(input.depth ?? 1), 3));
        for (let i = 0; i < depth; i++) for (const edge of graph.edges) if (selected.has(edge.from) && edge.to) selected.add(edge.to); else if (edge.to && selected.has(edge.to)) selected.add(edge.from);
        return { ...meta, source: "index", key: input.key, depth, nodes: graph.nodes.filter(node => selected.has(node.key)), edges: graph.edges.filter(edge => selected.has(edge.from) && (!edge.to || selected.has(edge.to))) };
      }
      return { ...meta, source: "index", ...graph };
    }
    if (kind === "filename-search") return { ...meta, source: "index", hits: rows(this.ctx.storage.sql.exec("SELECT key,modified,size FROM documents WHERE generation=? AND key LIKE ? AND key LIKE ? ORDER BY modified DESC LIMIT ?", generation, `${prefix}%`, `%${String(input.query)}%`, limit)) };
    return { ...meta, source: "index", documents: rows(this.ctx.storage.sql.exec("SELECT key,etag,modified,size,content_type contentType FROM documents WHERE generation=? AND key LIKE ? ORDER BY modified DESC LIMIT ?", generation, `${prefix}%`, limit)) };
  }

  private graph(generation: number, prefix: string, limit: number) {
    const docs = rows(this.ctx.storage.sql.exec("SELECT key,modified,size FROM documents WHERE generation=? AND key LIKE ? ORDER BY key LIMIT ?", generation, `${prefix}%`, limit)) as Array<{ key: string; modified: string; size: number }>;
    const aliases = new Map<string, string>(); for (const doc of docs) { const plain = doc.key.replace(/\.(md|markdown|mdx|txt)$/i, ""); aliases.set(doc.key, doc.key); aliases.set(plain, doc.key); aliases.set(plain.split("/").pop() ?? plain, doc.key); }
    const rawEdges = rows(this.ctx.storage.sql.exec("SELECT from_key `from`,to_key link FROM links WHERE generation=? AND from_key LIKE ?", generation, `${prefix}%`)) as Array<{ from: string; link: string }>;
    const edges: Array<{ from: string; link: string; to: string | null; dangling: boolean }> = rawEdges.map(edge => ({ ...edge, to: aliases.get(edge.link) ?? aliases.get(edge.link.replace(/\.(md|markdown|mdx|txt)$/i, "")) ?? null, dangling: !aliases.has(edge.link) }));
    const degree = new Map(docs.map(doc => [doc.key, { inDegree: 0, outDegree: 0 }])); for (const edge of edges) { degree.get(String(edge.from))!.outDegree++; if (edge.to) degree.get(String(edge.to))!.inDegree++; }
    return { nodeCount: docs.length, edgeCount: edges.length, danglingCount: edges.filter(edge => edge.dangling).length, nodes: docs.map(doc => ({ ...doc, ...(degree.get(doc.key)!) })), edges };
  }
}
