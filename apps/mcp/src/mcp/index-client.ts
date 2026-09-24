import type { CallToolResult } from "@modelcontextprotocol/server";
import { err } from "./shared";
import type { Env } from "../types";

/**
 * How every query is answered.
 *
 * Mineral has one retrieval model and a caller does not choose it: the note index answers search, tags,
 * links, frontmatter, filenames, folders and statistics, the vector index answers meaning, and R2 is read
 * only when a specific document's contents are wanted. `doc_read` reads R2; `search_text` never does.
 *
 * There is no mode parameter, and there is no fallback. An index that cannot answer is reported as such,
 * because the alternative — silently walking the vault — is a different question at a different cost, and
 * on a vault of any size it is also a hard failure ("Too many subrequests by single Worker invocation")
 * that names neither the cause nor the remedy.
 */

export type IndexOutcome<T> = { ok: true; data: T } | { ok: false; result: CallToolResult };

function indexError(body: Record<string, unknown>): CallToolResult {
  return err(JSON.stringify(body, null, 2));
}

/**
 * Reads the index, or explains why it could not.
 *
 * Two failures are worth naming separately, because the caller's next action differs. An index that has
 * never published anything is not broken — it has not been built yet, and one `vault_index_refresh` fixes
 * it. An index that throws is a fault, and the honest answer includes what it said.
 *
 * A merely *incomplete* index is not a failure at all: results come back with `partial: true` and the
 * number of documents still owed, which is the difference between "not found" and "not known yet".
 */
export async function readIndex<T = Record<string, unknown>>(env: Env, kind: string, input: Record<string, unknown>): Promise<IndexOutcome<T>> {
  let data: Record<string, unknown>;
  try {
    data = await env.vault.index.query(kind, input);
  } catch (error) {
    return {
      ok: false,
      result: indexError({
        error: "index_unavailable",
        kind,
        detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        remedies: [
          "调用 vault_index_refresh 触发一次审计：它会走一遍 R2，把索引欠的文档重新排队",
          "如果审计也失败，那是索引本身的问题，而不是索引落后于 R2",
        ],
      }),
    };
  }

  if (data.indexReady === false) {
    return {
      ok: false,
      result: indexError({
        error: "index_not_ready",
        kind,
        documents: data.documents ?? 0,
        indexVersion: data.indexVersion ?? null,
        lastAuditAt: data.lastAuditAt ?? null,
        detail: "索引还没有完成过任何一次发布，无法回答检索问题。它不会退化成对 R2 的全库扫描。",
        remedies: ["调用 vault_index_refresh 触发审计与回填，完成后再检索"],
      }),
    };
  }
  return { ok: true, data: data as T };
}

/**
 * Starts a revision audit, or reports the one already running.
 *
 * The name outlived its meaning: there is no metadata generation to rebuild, so this asks the Vault to
 * walk R2, diff it against the live index, and enqueue the difference for the indexer.
 */
export async function refreshIndex(env: Env): Promise<Record<string, unknown>> {
  return env.vault.index.refresh();
}
