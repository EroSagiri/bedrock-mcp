import { isTextDocumentKey } from "@mineral/core/keys";
import { DurableObject } from "cloudflare:workers";
import { SqlMutationStore, type SqlDatabase } from "../index/journal-store";
import { CURRENT_INDEX_VERSION, INDEX_SCHEMA_VERSION, LIVE_INDEX_SCHEMA, freshnessStatus, type FreshnessRow, type IndexedDocument } from "../index/live-store";
import { parseDocument } from "../index/parse";
import type { IndexAction, IndexIntentSpec } from "../index/intents";
import { AUDIT_SCHEMA, type IndexAudit } from "../index/audit";
import type { DueIndexIntent, IndexClaim, PendingIndexSummary, RecordMutationResult } from "../mutation/store";
import type { JournalEntry, MutationEvent } from "../mutation/types";

type Env = { MINERAL: R2Bucket };
type Row = Record<string, unknown>;
const SYSTEM = [".history/", ".trash/", ".system/"];
const isIndexable = (key: string) => isTextDocumentKey(key) && !SYSTEM.some(prefix => key.startsWith(prefix));
const rows = (result: Iterable<Row>) => [...result];

/** How many R2 objects one audit page lists. Small enough that a page never approaches CPU limits. */
const AUDIT_PAGE_SIZE = 200;

/**
 * The single, named instance holds two different things that must not be conflated:
 *
 * - the **live note index** — one materialized row per document, each carrying the revision it observed;
 * - the **Mutation Journal** and its materialised `pending_index` dirty set — durable facts about
 *   authoritative R2 writes and the index work still owed for them.
 *
 * They live in one SQLite instance because `recordMutation()` must commit the journal fact and its
 * index intents together, and because the indexer is the natural consumer of those intents. The
 * journal is never used as a work queue, and the dirty set is never used as a history.
 */
export class VaultIndex extends DurableObject<Env> {
  private readonly mutations: SqlMutationStore;
  /** The SQLite handle, so read-only diagnostics can query the journal directly. */
  private readonly db: SqlDatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = this.ctx.storage.sql as unknown as SqlDatabase;
    this.mutations = new SqlMutationStore(this.db);
    // Only `index_meta` is created eagerly: it holds the migration marker, and it is the one table the
    // live schema never redefines. The generation-era tables are deliberately *not* created here — an
    // install that predates the live index still has them, and `migrateToLiveIndex` drops them before
    // the live schema is applied. Creating them first would recreate tables the migration is about to
    // discard, and leave their old indexes behind to collide with the new ones.
    this.db.exec("CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.migrateToLiveIndex();
  }

  private setMeta(key: string, value: string): void { this.db.exec("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)", key, value); }
  private getMeta(key: string): string | null {
    return rows(this.db.exec("SELECT value FROM index_meta WHERE key = ?", key))[0]?.value as string | undefined ?? null;
  }

  /**
   * Test-only: drops the journal, the dirty set, the live index and any audit state.
   *
   * The durable tests run against the real single named instance, and each case must start from an
   * empty index as well as an empty journal.
   */
  async resetMutationState(): Promise<void> {
    this.db.exec("DELETE FROM mutation_journal; DELETE FROM pending_index;");
    this.db.exec("DELETE FROM documents_fts; DELETE FROM documents; DELETE FROM document_headings; DELETE FROM frontmatter_values; DELETE FROM document_tags; DELETE FROM links;");
    this.db.exec("DELETE FROM index_audit; DELETE FROM index_audit_seen;");
  }

  /**
   * Phase A of the live-index migration: add the generation-less tables and seed them from whichever
   * generation was active.
   *
   * The old tables are deliberately **not** dropped — they are the rollback source, and a schema
   * migration is the wrong place for an irreversible step. Every copied document keeps
   * `index_version = 0`, which is what makes the nightly audit enqueue it: the metadata is already
   * correct, but the derived rows were produced by the previous indexer and no full text exists yet.
   */
  private migrateToLiveIndex(): void {
    // The legacy tables must go *before* the live schema is created: `CREATE TABLE IF NOT EXISTS`
    // leaves an existing table alone, so an old `documents` (which has `generation` and no
    // `index_version`) would survive, and every index the live schema declares on those columns would
    // fail to create.
    //
    // Dropping is safe because the generation-era tables were never populated in production: the
    // nightly audit that replaced the generation rebuild landed before it ever ran against the real
    // vault, so there is nothing to carry over. A deployment that *did* hold generations re-derives
    // from R2 on its first audit.
    if (this.legacyIndexPresent()) this.dropLegacyIndexTables();
    this.db.exec(LIVE_INDEX_SCHEMA);
    this.db.exec(AUDIT_SCHEMA);
    if (Number(this.getMeta("live_index_version") ?? "0") >= INDEX_SCHEMA_VERSION) return;
    this.setMeta("live_index_version", String(INDEX_SCHEMA_VERSION));
    this.setMeta("migrated_documents", "0");
  }

  /** A `documents` table without `index_version` is the generation-era one. */
  private legacyIndexPresent(): boolean {
    if (!this.legacyTableExists("documents")) return false;
    const columns = rows(this.db.exec("SELECT name FROM pragma_table_info('documents')")) as Array<{ name: string }>;
    return !columns.some(column => column.name === "index_version");
  }

  private dropLegacyIndexTables(): void {
    for (const table of ["documents", "frontmatter_values", "document_tags", "links", "refresh_seen"] as const) {
      this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }

  private legacyTableExists(name: string): boolean {
    return rows(this.db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name)).length > 0;
  }

  // ---------------------------------------------------------------------------------------------
  // The live index: one document, published atomically.
  // ---------------------------------------------------------------------------------------------

  /**
   * Publishes one document's revision, or leaves the index exactly as it was.
   *
   * Everything derived from the text — metadata, full text, headings, frontmatter, tags, links — is
   * written in one transaction, and `indexed_etag` / `index_version` are set by that same transaction.
   * That is what makes those two columns a commit marker rather than a progress flag: a reader either
   * sees a revision that is completely indexed, or the previous one.
   */
  async applyIndexedDocument(document: IndexedDocument): Promise<{ status: "indexed" | "noop"; indexVersion: number }> {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.lookupDocument(document.key);
      if (existing?.indexedEtag === document.etag && existing.indexVersion === CURRENT_INDEX_VERSION) return { status: "noop" as const, indexVersion: existing.indexVersion };
      this.writeDocument(existing?.id ?? null, document);
      return { status: "indexed" as const, indexVersion: CURRENT_INDEX_VERSION };
    });
  }

  /** Removes a document and every derived row, in the same transaction as its metadata. */
  async dropIndexedDocument(key: string): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.lookupDocument(key);
      if (!existing) return false;
      this.db.exec("DELETE FROM documents WHERE id = ?", existing.id);
      this.db.exec("DELETE FROM document_headings WHERE document_id = ?", existing.id);
      this.db.exec("DELETE FROM frontmatter_values WHERE document_id = ?", existing.id);
      this.db.exec("DELETE FROM document_tags WHERE document_id = ?", existing.id);
      this.db.exec("DELETE FROM links WHERE document_id = ?", existing.id);
      this.db.exec("DELETE FROM documents_fts WHERE rowid = ?", existing.id);
      this.setMeta("indexed_at", new Date().toISOString());
      return true;
    });
  }

  /** The index's current belief about one path. `undefined` means it has never published a revision. */
  async indexedState(key: string): Promise<FreshnessRow | undefined> {
    return this.lookupDocument(key);
  }

  /** The single freshness question, asked with an already-observed R2 revision. */
  async freshnessOf(key: string, observedEtag: string | null): Promise<ReturnType<typeof freshnessStatus>> {
    return freshnessStatus(this.lookupDocument(key), observedEtag);
  }

  private lookupDocument(key: string): FreshnessRow | undefined {
    const row = rows(this.db.exec(
      "SELECT id, key, indexed_etag, index_version, indexed_at, modified FROM documents WHERE key = ?",
      key,
    ))[0] as { id: number; key: string; indexed_etag: string | null; index_version: number; indexed_at: string | null; modified: string | null } | undefined;
    if (!row) return undefined;
    return { id: Number(row.id), key: String(row.key), indexedEtag: row.indexed_etag, indexVersion: Number(row.index_version), indexedAt: row.indexed_at, modified: row.modified };
  }

  /**
   * The one write. `id` is the row to replace, or `null` for a document the index has not seen.
   *
   * The caller must already be inside a transaction: this is the body of the commit, not a commit.
   */
  private writeDocument(id: number | null, document: IndexedDocument): void {
    const now = new Date().toISOString();
    if (id === null) {
      this.db.exec(
        "INSERT INTO documents (key, indexed_etag, content_sha256, title, content_type, modified, size, indexed_at, index_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        document.key, document.etag, document.contentSha256, document.title, document.contentType, document.modified, document.size, now, CURRENT_INDEX_VERSION,
      );
      id = Number((rows(this.db.exec("SELECT id FROM documents WHERE key = ?", document.key))[0] as { id: number }).id);
    } else {
      this.db.exec(
        "UPDATE documents SET indexed_etag = ?, content_sha256 = ?, title = ?, content_type = ?, modified = ?, size = ?, indexed_at = ?, index_version = ? WHERE id = ?",
        document.etag, document.contentSha256, document.title, document.contentType, document.modified, document.size, now, CURRENT_INDEX_VERSION, id,
      );
      this.db.exec("DELETE FROM document_headings WHERE document_id = ?", id);
      this.db.exec("DELETE FROM frontmatter_values WHERE document_id = ?", id);
      this.db.exec("DELETE FROM document_tags WHERE document_id = ?", id);
      this.db.exec("DELETE FROM links WHERE document_id = ?", id);
      this.db.exec("DELETE FROM documents_fts WHERE rowid = ?", id);
    }
    for (const [ordinal, heading] of document.headings.entries()) {
      this.db.exec("INSERT INTO document_headings (document_id, ordinal, level, text, line) VALUES (?, ?, ?, ?, ?)", id, ordinal, heading.level, heading.text, heading.line);
    }
    for (const row of document.frontmatterRows) this.db.exec("INSERT INTO frontmatter_values (document_id, field, value) VALUES (?, ?, ?)", id, row.field, row.value);
    for (const tag of document.tags) this.db.exec("INSERT INTO document_tags (document_id, tag, source, occurrences) VALUES (?, ?, ?, ?)", id, tag.tag, tag.source, tag.occurrences);
    for (const target of document.links) this.db.exec("INSERT OR IGNORE INTO links (document_id, to_key) VALUES (?, ?)", id, target);
    this.db.exec(
      "INSERT INTO documents_fts (rowid, title, path, headings, tags, body) VALUES (?, ?, ?, ?, ?, ?)",
      id, document.title, document.key, document.headingText, document.tags.map(tag => tag.tag).join(" "), document.body,
    );
    this.setMeta("indexed_at", now);
    this.setMeta("indexed_etag", document.etag);
  }

  /** Parses a body of text and builds the document to publish. The caller supplies the R2 identity. */
  buildIndexedDocument(input: { key: string; text: string; etag: string; size: number; modified: string; contentType: string | null; contentSha256: string }): IndexedDocument {
    return { ...parseDocument(input.key, input.text), etag: input.etag, contentType: input.contentType, modified: input.modified, contentSha256: input.contentSha256, size: input.size };
  }

  // ---------------------------------------------------------------------------------------------
  // The revision audit: list, diff, enqueue. It never writes the index.
  // ---------------------------------------------------------------------------------------------

  /**
   * Starts a full revision audit, or reports the one already running.
   *
   * Only one may run at a time: a second concurrent walk would build its own `seen` set and could
   * conclude that a page the first walk was still covering is absent.
   */
  async startIndexAudit(now: number): Promise<IndexAudit> {
    const running = this.auditRow("SELECT * FROM index_audit WHERE status = 'running' ORDER BY audit_id DESC LIMIT 1");
    if (running) return running;
    this.db.exec("DELETE FROM index_audit_seen");
    this.db.exec("INSERT INTO index_audit (started_at, cursor, status, scanned, dirty) VALUES (?, NULL, 'running', 0, 0)", now);
    const audit = this.auditRow("SELECT * FROM index_audit ORDER BY audit_id DESC LIMIT 1")!;
    this.setMeta("last_audit_started_at", new Date(now).toISOString());
    return audit;
  }

  async currentIndexAudit(): Promise<IndexAudit | null> {
    return this.auditRow("SELECT * FROM index_audit ORDER BY audit_id DESC LIMIT 1") ?? null;
  }

  /**
   * Walks one page of R2 and turns the differences into `pending_index` work.
   *
   * Every entry it writes is an intent to **re-observe**, never a conclusion: a changed or new path
   * becomes an upsert, and a path the index holds but R2 no longer lists becomes a remove — which the
   * indexer re-verifies against R2 before deleting anything.
   *
   * The delete candidates carry one extra guard: only documents indexed *before* this walk started are
   * considered. A document indexed while the walk was in flight may simply not have existed when its
   * page was listed, and treating that as "absent" would enqueue a deletion for a live file.
   */
  async runIndexAuditPage(): Promise<{ audit: IndexAudit; enqueued: string[]; removed: string[]; done: boolean } | null> {
    const audit = this.auditRow("SELECT * FROM index_audit WHERE status = 'running' ORDER BY audit_id DESC LIMIT 1");
    if (!audit) return null;

    const page = await this.env.MINERAL.list({ cursor: audit.cursor ?? undefined, limit: AUDIT_PAGE_SIZE });
    const fresh = page.objects.filter(object => isIndexable(object.key));
    const known = new Map<string, string | null>();
    for (const object of fresh) known.set(object.key, this.lookupDocument(object.key)?.indexedEtag ?? null);

    const enqueued: string[] = [];
    for (const object of fresh) {
      this.db.exec("INSERT OR IGNORE INTO index_audit_seen (audit_id, path) VALUES (?, ?)", audit.auditId, object.key);
      if (known.get(object.key) === object.etag) continue;
      this.enqueueIntent(object.key, "upsert", object.etag, Math.floor(audit.startedAt / 1000));
      enqueued.push(object.key);
    }

    if (page.truncated) {
      this.db.exec("UPDATE index_audit SET cursor = ?, scanned = scanned + ?, dirty = dirty + ? WHERE audit_id = ?", page.cursor ?? null, fresh.length, enqueued.length, audit.auditId);
      return { audit: this.auditRow("SELECT * FROM index_audit WHERE audit_id = ?", audit.auditId)!, enqueued, removed: [], done: false };
    }

    // Last page: whatever the index still holds that this walk never listed is a delete *candidate*.
    const gone = rows(this.db.exec(
      `SELECT d.key FROM documents d
       WHERE d.indexed_at IS NOT NULL AND d.indexed_at < ?
         AND NOT EXISTS (SELECT 1 FROM index_audit_seen s WHERE s.audit_id = ? AND s.path = d.key)`,
      new Date(audit.startedAt).toISOString(),
      audit.auditId,
    )) as Array<{ key: string }>;
    const removed: string[] = [];
    for (const row of gone) {
      this.enqueueIntent(row.key, "remove", null, Math.floor(audit.startedAt / 1000));
      removed.push(row.key);
    }

    this.db.exec("UPDATE index_audit SET status = 'completed', completed_at = ?, cursor = NULL, scanned = scanned + ?, dirty = dirty + ? WHERE audit_id = ?", Date.now(), fresh.length, enqueued.length + removed.length, audit.auditId);
    const completed = this.auditRow("SELECT * FROM index_audit WHERE audit_id = ?", audit.auditId)!;
    this.setMeta("last_audit_at", new Date().toISOString());
    this.setMeta("last_audit_scanned", String(completed.scanned));
    this.setMeta("last_audit_dirty", String(completed.dirty));
    return { audit: completed, enqueued, removed, done: true };
  }

  /** Writes one dirty-set entry, coalescing with whatever is already owed for that path. */
  private enqueueIntent(path: string, action: IndexAction, targetEtag: string | null, notBefore: number): void {
    const now = Date.now();
    this.db.exec(
      `INSERT INTO pending_index (path, action, target_etag, source, not_before, first_dirty_at, updated_at, attempts, last_claim_at, last_error)
       VALUES (?, ?, ?, 'system', ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(path) DO UPDATE SET
         action = excluded.action,
         target_etag = excluded.target_etag,
         source = excluded.source,
         not_before = MAX(pending_index.not_before, excluded.not_before),
         updated_at = excluded.updated_at,
         attempts = 0,
         last_claim_at = NULL,
         last_error = NULL`,
      path, action, action === "remove" ? null : targetEtag, Math.max(notBefore, 0), now, now,
    );
  }

  private auditRow(sql: string, ...bindings: unknown[]): IndexAudit | null {
    const row = rows(this.db.exec(sql, ...bindings))[0] as
      | { audit_id: number; started_at: number; cursor: string | null; status: string; scanned: number; dirty: number; completed_at: number | null }
      | undefined;
    if (!row) return null;
    return {
      auditId: Number(row.audit_id),
      startedAt: Number(row.started_at),
      cursor: row.cursor,
      status: row.status === "completed" || row.status === "abandoned" ? row.status : "running",
      scanned: Number(row.scanned),
      dirty: Number(row.dirty),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  }

  /**
   * The health of the live index, as a reader sees it.
   *
   * `generation` is gone with the snapshot model: the interesting number is now how many documents are
   * not yet published at the current index version, because that is exactly what makes a search answer
   * incomplete.
   */
  private freshness() {
    const row = rows(this.db.exec("SELECT COUNT(*) count FROM documents"))[0] as { count: number } | undefined;
    const stale = this.staleCount();
    return {
      documents: Number(row?.count ?? 0),
      staleDocuments: stale,
      partial: stale > 0,
      indexVersion: CURRENT_INDEX_VERSION,
      indexedAt: this.getMeta("indexed_at"),
      /** The freshest revision this note index has actually observed; compared with R2 for staleness. */
      indexedEtag: this.getMeta("indexed_etag"),
      lastAuditAt: this.getMeta("last_audit_at"),
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
  /**
   * Runs one statement against the real storage engine and reports the outcome.
   *
   * It exists so a capability question — "does this SQLite speak FTS5?" — is answered by the runtime
   * the deployment actually uses, instead of by documentation. It is read-only in spirit: nothing in
   * the index depends on it.
   */
  async probeSql(sql: string): Promise<{ ok: boolean; rows?: unknown[]; error?: string }> {
    try {
      return { ok: true, rows: rows(this.db.exec(sql)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "probe failed" };
    }
  }

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
   * This is the single write path for the index. The intent's `target_etag` is a hint about what the
   * caller believed was owed; it is never indexed directly, and an intent to remove is verified the
   * same way — if R2 still holds the object, it is indexed rather than deleted. That is what makes an
   * audit's delete candidate a hint to re-observe instead of an instruction: the audit may be wrong,
   * this method cannot be.
   */
  async applyIndexIntent(input: { path: string; action: IndexAction }): Promise<{ applied: true; indexedEtag: string | null; status: "indexed" | "removed" | "noop" } | { applied: false; error: string }> {
    try {
      if (!isIndexable(input.path)) {
        await this.dropIndexedDocument(input.path);
        return { applied: true, indexedEtag: null, status: "removed" };
      }
      const object = await this.env.MINERAL.get(input.path);
      if (!object) {
        await this.dropIndexedDocument(input.path);
        return { applied: true, indexedEtag: null, status: "removed" };
      }
      const existing = this.lookupDocument(input.path);
      if (existing?.indexedEtag === object.etag && existing.indexVersion === CURRENT_INDEX_VERSION) {
        return { applied: true, indexedEtag: object.etag, status: "noop" };
      }
      const text = await object.text();
      const document = this.buildIndexedDocument({
        key: input.path,
        text,
        etag: object.etag,
        size: object.size,
        modified: object.uploaded.toISOString(),
        contentType: object.httpMetadata?.contentType ?? null,
        contentSha256: await sha256Hex(text),
      });
      const result = await this.applyIndexedDocument(document);
      return { applied: true, indexedEtag: object.etag, status: result.status };
    } catch (error) {
      return { applied: false, error: error instanceof Error ? error.message.slice(0, 200) : "index apply failed" };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const input = await request.json<Record<string, unknown>>();
    if (url.pathname === "/query") return Response.json(this.query(String(input.kind ?? ""), input));
    if (url.pathname === "/mutation/summary") return Response.json(this.mutations.pendingSummary(Date.now()));
    return new Response("Not found", { status: 404 });
  }

  private query(kind: string, input: Record<string, unknown>): Row {
    const limit = Math.min(Number(input.limit ?? 100), 1000); const prefix = String(input.prefix ?? "");
    const meta = this.freshness();
    if (kind === "tags") {
      const sources = (input.sources as string[] | undefined) ?? ["frontmatter", "body"];
      const sourceMarks = sources.map(() => "?").join(","); const tagPrefix = String(input.tagPrefix ?? "");
      const data = rows(this.db.exec(`SELECT tag, SUM(occurrences) referenceCount, COUNT(DISTINCT document_id) documentCount, SUM(CASE WHEN source='frontmatter' THEN occurrences ELSE 0 END) frontmatterReferences, SUM(CASE WHEN source='body' THEN occurrences ELSE 0 END) bodyReferences FROM document_tags WHERE source IN (${sourceMarks}) AND tag LIKE ? GROUP BY tag HAVING referenceCount >= ? ORDER BY tag LIMIT ?`, ...sources, `${tagPrefix}%`, Number(input.minReferences ?? 1), limit));
      return { ...meta, source: "index", tags: data };
    }
    if (kind === "tag-documents") {
      const tag = String(input.tag); const descendants = input.match === "descendants"; const sources = (input.sources as string[] | undefined) ?? ["frontmatter", "body"];
      const sourceMarks = sources.map(() => "?").join(",");
      const tagCondition = descendants ? "(t.tag = ? OR t.tag LIKE ?)" : "t.tag = ?";
      const tagArgs: unknown[] = descendants ? [tag, `${tag}/%`] : [tag];
      const data = rows(this.db.exec(`SELECT d.key, d.modified, SUM(CASE WHEN t.source='frontmatter' THEN t.occurrences ELSE 0 END) frontmatterReferences, SUM(CASE WHEN t.source='body' THEN t.occurrences ELSE 0 END) bodyReferences FROM document_tags t JOIN documents d ON d.id = t.document_id WHERE t.source IN (${sourceMarks}) AND ${tagCondition} AND d.key LIKE ? GROUP BY d.key, d.modified ORDER BY d.modified DESC LIMIT ?`, ...sources, ...tagArgs, `${prefix}%`, limit));
      return { ...meta, source: "index", documents: data };
    }
    if (kind === "frontmatter") {
      const field = String(input.field); const clauses = ["f.field = ?", "d.key LIKE ?"]; const args: unknown[] = [field, `${prefix}%`];
      if (input.value !== undefined) { clauses.push("f.value = ?"); args.push(String(input.value)); }
      if (input.contains !== undefined) { clauses.push("LOWER(f.value) LIKE ?"); args.push(`%${String(input.contains).toLowerCase()}%`); }
      return { ...meta, source: "index", matches: rows(this.db.exec(`SELECT d.key, d.modified, f.value FROM frontmatter_values f JOIN documents d ON d.id = f.document_id WHERE ${clauses.join(" AND ")} ORDER BY d.modified DESC LIMIT ?`, ...args, limit)) };
    }
    if (kind === "headings") {
      const key = String(input.key);
      return { ...meta, source: "index", key, headings: rows(this.db.exec("SELECT h.level, h.text, h.line FROM document_headings h JOIN documents d ON d.id = h.document_id WHERE d.key = ? ORDER BY h.ordinal", key)) };
    }
    if (kind === "outgoing") return { ...meta, source: "index", links: rows(this.db.exec("SELECT l.to_key link FROM links l JOIN documents d ON d.id = l.document_id WHERE d.key = ?", String(input.key))) };
    if (kind === "backlinks") {
      // Wikilinks are stored as written, so a target may name the path, the path without its extension,
      // or the bare basename. All three are the same link once the vault is resolved.
      const raw = String(input.key);
      const plain = raw.replace(/\.(md|markdown|mdx|txt)$/i, "");
      const basename = plain.split("/").pop() ?? plain;
      return { ...meta, source: "index", links: rows(this.db.exec("SELECT d.key, d.modified, l.to_key via FROM links l JOIN documents d ON d.id = l.document_id WHERE l.to_key IN (?, ?, ?) ORDER BY d.modified DESC LIMIT ?", raw, plain, basename, limit)) };
    }
    if (kind === "recent") return { ...meta, source: "index", items: rows(this.db.exec("SELECT key, modified, size FROM documents WHERE key LIKE ? ORDER BY modified DESC LIMIT ?", `${prefix}%`, limit)) };
    if (kind === "folders") return { ...meta, source: "index", items: rows(this.db.exec("SELECT CASE WHEN instr(key,'/')=0 THEN '(root)' ELSE substr(key,1,instr(key,'/')-1) END folder, COUNT(*) count, MAX(modified) lastModified FROM documents GROUP BY folder ORDER BY lastModified DESC")) };
    if (kind === "stats") return { ...meta, source: "index", total: rows(this.db.exec("SELECT COUNT(*) count, COALESCE(SUM(size),0) sizeBytes FROM documents"))[0] ?? { count: 0, sizeBytes: 0 } };
    if (kind === "graph") {
      const graph = this.graph(prefix, limit);
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
    if (kind === "filename-search") return { ...meta, source: "index", hits: rows(this.db.exec("SELECT key, modified, size FROM documents WHERE key LIKE ? AND key LIKE ? ORDER BY modified DESC LIMIT ?", `${prefix}%`, `%${String(input.query)}%`, limit)) };
    if (kind === "search") return this.search(input);
    if (kind === "stale-count") return { ...meta, source: "index", stale: this.staleCount() };
    return { ...meta, source: "index", documents: rows(this.db.exec("SELECT key, indexed_etag etag, modified, size, content_type contentType FROM documents WHERE key LIKE ? ORDER BY modified DESC LIMIT ?", `${prefix}%`, limit)) };
  }

  /**
   * Full-text search, answered entirely inside SQLite.
   *
   * The result carries `partial` because the index can be mid-backfill: a search that silently
   * returned three hits while forty documents were still unindexed would be a false negative that
   * looks exactly like an answer.
   */
  private search(input: Record<string, unknown>): Row {
    const query = String(input.query ?? "").trim();
    const limit = Math.min(Number(input.limit ?? 20), 200);
    const prefix = String(input.prefix ?? "");
    if (!query) return { ...this.freshness(), source: "index", query, results: [], partial: this.staleCount() > 0 };
    const results = rows(this.db.exec(
      `SELECT d.key, d.title, d.modified, d.size,
              snippet(documents_fts, 4, '', '', '…', 12) snippet,
              bm25(documents_fts, 10.0, 0.0, 4.0, 2.0, 1.0) score
       FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
       WHERE documents_fts MATCH ? AND d.key LIKE ?
       ORDER BY score LIMIT ?`,
      query, `${prefix}%`, limit,
    ));
    const stale = this.staleCount();
    return { ...this.freshness(), source: "index", query, results, staleDocuments: stale, partial: stale > 0 };
  }

  /**
   * Documents the index has not published at the current index version.
   *
   * Zero is the only value that makes a search answer complete, and it is also the number the nightly
   * audit drives to zero when a parser change or the live-index migration requires re-derivation.
   */
  private staleCount(): number {
    const row = rows(this.db.exec("SELECT COUNT(*) count FROM documents WHERE index_version <> ?", CURRENT_INDEX_VERSION))[0] as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private graph(prefix: string, limit: number) {
    const docs = rows(this.db.exec("SELECT key, modified, size FROM documents WHERE key LIKE ? ORDER BY key LIMIT ?", `${prefix}%`, limit)) as Array<{ key: string; modified: string; size: number }>;
    const aliases = new Map<string, string>(); for (const doc of docs) { const plain = doc.key.replace(/\.(md|markdown|mdx|txt)$/i, ""); aliases.set(doc.key, doc.key); aliases.set(plain, doc.key); aliases.set(plain.split("/").pop() ?? plain, doc.key); }
    const rawEdges = rows(this.db.exec("SELECT d.key `from`, l.to_key link FROM links l JOIN documents d ON d.id = l.document_id WHERE d.key LIKE ?", `${prefix}%`)) as Array<{ from: string; link: string }>;
    const edges: Array<{ from: string; link: string; to: string | null; dangling: boolean }> = rawEdges.map(edge => ({ ...edge, to: aliases.get(edge.link) ?? aliases.get(edge.link.replace(/\.(md|markdown|mdx|txt)$/i, "")) ?? null, dangling: !aliases.has(edge.link) }));
    const degree = new Map(docs.map(doc => [doc.key, { inDegree: 0, outDegree: 0 }])); for (const edge of edges) { degree.get(String(edge.from))!.outDegree++; if (edge.to) degree.get(String(edge.to))!.inDegree++; }
    return { nodeCount: docs.length, edgeCount: edges.length, danglingCount: edges.filter(edge => edge.dangling).length, nodes: docs.map(doc => ({ ...doc, ...(degree.get(doc.key)!) })), edges };
  }
}

/** Content hash, for detecting a re-write of identical bytes that R2 reports as a new revision. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}


