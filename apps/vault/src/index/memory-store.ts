import { applyIntent, type IndexAction, type IndexIntent, type IndexIntentSpec } from "./intents";
import type { DueIndexIntent, IndexClaim, MutationStore, PendingIndexSummary, RecordMutationResult } from "../mutation/store";
import type { BroadcastState, JournalEntry, MutationEvent, MutationSource } from "../mutation/types";

type MemoryEntry = {
  seq: number;
  event: MutationEvent;
  broadcastState: BroadcastState;
  broadcastAttempts: number;
  broadcastLastError: string | null;
  gatewayGeneration: string | null;
};

/**
 * An in-memory `MutationStore` with the same semantics as the SQLite one.
 *
 * It exists so the Sync Publisher and the Index Scheduler — the two consumers, which are the parts
 * with the interesting policy — can be tested without a Durable Object. The durable implementation
 * in `SqlMutationStore` is exercised separately.
 */
export class MemoryMutationStore implements MutationStore {
  private readonly entries: MemoryEntry[] = [];
  private readonly byId = new Map<string, MemoryEntry>();
  private readonly intents = new Map<string, IndexIntent>();
  private sequence = 0;

  /** Records every atomic write, so a test can prove the two tables committed together. */
  readonly commits: Array<{ mutationId: string; seq: number; intents: number }> = [];

  record(event: MutationEvent, intentSpecs: IndexIntentSpec[]): RecordMutationResult {
    const existing = this.byId.get(event.id);
    if (existing) return { inserted: false, seq: existing.seq, entry: this.entryOf(existing) };
    const entry: MemoryEntry = {
      seq: ++this.sequence,
      event,
      broadcastState: "pending",
      broadcastAttempts: 0,
      broadcastLastError: null,
      gatewayGeneration: null,
    };
    this.entries.push(entry);
    this.byId.set(event.id, entry);
    for (const spec of intentSpecs) this.upsertIntent(spec, event.source, event.committedAt);
    this.commits.push({ mutationId: event.id, seq: entry.seq, intents: intentSpecs.length });
    return { inserted: true, seq: entry.seq, entry: this.entryOf(entry) };
  }

  private upsertIntent(spec: IndexIntentSpec, source: MutationSource, now: number): void {
    const current = this.intents.get(spec.path);
    if (!current) {
      this.intents.set(spec.path, {
        path: spec.path,
        action: spec.action,
        targetEtag: spec.action === "remove" ? null : spec.targetEtag,
        source,
        notBefore: spec.notBefore,
        firstDirtyAt: now,
        updatedAt: now,
        attempts: 0,
        lastError: null,
      });
      return;
    }
    const next = applyIntent(current, spec, source, now);
    // A changed intent is new work: its retry budget resets, exactly like the SQL upsert.
    this.intents.set(spec.path, next === current ? current : { ...next, attempts: 0, lastError: null });
  }

  private entryOf(entry: MemoryEntry): JournalEntry {
    return {
      ...entry.event,
      seq: entry.seq,
      broadcastState: entry.broadcastState,
      broadcastAttempts: entry.broadcastAttempts,
      broadcastLastError: entry.broadcastLastError,
      gatewayGeneration: entry.gatewayGeneration,
    };
  }

  findByMutationId(mutationId: string): JournalEntry | null {
    const entry = this.byId.get(mutationId);
    return entry ? this.entryOf(entry) : null;
  }

  listPendingBroadcasts(limit: number): JournalEntry[] {
    return this.entries.filter(entry => entry.broadcastState === "pending").slice(0, limit).map(entry => this.entryOf(entry));
  }

  markBroadcast(input: { mutationId: string; state: "published" | "pending"; generation?: string; error?: string }): void {
    const entry = this.byId.get(input.mutationId);
    if (!entry) return;
    if (input.state === "published") {
      entry.broadcastState = "published";
      entry.broadcastAttempts++;
      entry.broadcastLastError = null;
      entry.gatewayGeneration = entry.gatewayGeneration ?? input.generation ?? null;
      return;
    }
    entry.broadcastAttempts++;
    entry.broadcastLastError = input.error ?? null;
  }

  pendingSummary(now: number): PendingIndexSummary {
    const all = [...this.intents.values()];
    return {
      due: all.filter(intent => intent.notBefore <= now).length,
      upserts: all.filter(intent => intent.action === "upsert").length,
      removes: all.filter(intent => intent.action === "remove").length,
      earliestNotBefore: all.length ? Math.min(...all.map(intent => intent.notBefore)) : null,
    };
  }

  listDueIndexPaths(now: number, limit: number): DueIndexIntent[] {
    return [...this.intents.values()]
      .filter(intent => intent.notBefore <= now)
      .sort((left, right) => left.updatedAt - right.updatedAt || left.path.localeCompare(right.path))
      .slice(0, limit)
      .map(intent => ({ path: intent.path, action: intent.action, targetEtag: intent.targetEtag }));
  }

  claimPendingIndex(input: { path: string; etag: string | null; action: IndexAction; now: number }): IndexClaim {
    const intent = this.intents.get(input.path);
    if (!intent) return { status: "missing" };
    if (intent.action !== input.action || intent.targetEtag !== input.etag || intent.notBefore > input.now) return { status: "superseded" };
    intent.attempts++;
    return { status: "claimed", intent: { ...intent }, attempts: intent.attempts };
  }

  completeIndex(input: { path: string; etag: string | null; action: IndexAction }): boolean {
    const intent = this.intents.get(input.path);
    if (!intent || intent.action !== input.action || intent.targetEtag !== input.etag) return false;
    this.intents.delete(input.path);
    return true;
  }

  failIndex(input: { path: string; etag: string | null; action: IndexAction; error: string; notBefore: number }): void {
    const intent = this.intents.get(input.path);
    if (!intent || intent.action !== input.action || intent.targetEtag !== input.etag) return;
    intent.lastError = input.error.slice(0, 200);
    intent.notBefore = Math.max(intent.notBefore, input.notBefore);
  }

  /** Test-only inspection: the current materialised dirty set. */
  snapshotIntents(): IndexIntent[] {
    return [...this.intents.values()].map(intent => ({ ...intent }));
  }

  /** Test-only inspection: the append-only facts, in sequence order. */
  snapshotJournal(): JournalEntry[] {
    return this.entries.map(entry => this.entryOf(entry));
  }
}
