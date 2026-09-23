#!/usr/bin/env node
/**
 * Drives the deployed revision audit to completion, and reports what both index consumers hold.
 *
 * One run is bounded on purpose: it walks at most AUDIT_PAGE_LIMIT pages of R2 and clears a capped number
 * of documents per page, for both the note index and the vector index. A first-time backfill therefore
 * needs several runs, and this script makes them until nothing is owed — which is also the only way to
 * know that a semantic search will answer completely.
 *
 * The URL is read from `.env`; see `scripts/mcp-client.mjs` for why it is never an argument.
 *
 * Usage: node scripts/backfill-live-index.mjs [maxRuns]
 */
import { connect } from "./mcp-client.mjs";

const maxRuns = Number(process.argv[2]) || 60;
const mcp = await connect();
console.log(`endpoint=${mcp.safeEndpoint}`);
console.log(`initialize → ${mcp.serverInfo}`);

/**
 * One audit run.
 *
 * A run is long — it walks R2 and clears a batch of documents in two indexes — and it talks to a
 * Durable Object the platform is free to evict underneath it. Both a tool error and a dropped
 * connection are therefore normal here, and an audit is resumable: `startIndexAudit` reports the walk
 * already in progress and its cursor picks up where it stopped. So a run is retried, and the run
 * counter only advances on a run that produced numbers.
 */
async function runAudit(run) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const refresh = await mcp.callTool("vault_index_refresh");
      if (!refresh.isError) return JSON.parse(refresh.text);
      lastError = refresh.text.trim();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
  }
  console.error(`run ${run}: vault_index_refresh failed after 3 attempts\n${lastError}`);
  process.exit(1);
}

let last = null;
for (let run = 1; run <= maxRuns; run++) {
  const audit = await runAudit(run);
  last = audit;
  console.log(
    `run ${run}: pages=${audit.pages} scanned=${audit.scanned} ` +
    `notes(enqueued=${audit.enqueued} applied=${audit.applied} owed=${audit.pendingLeft}) ` +
    `vectors(enqueued=${audit.vectorsEnqueued} applied=${audit.vectorsApplied} collected=${audit.vectorsCollected} owed=${audit.vectorsPendingLeft})`,
  );
  if (audit.pendingLeft === 0 && audit.vectorsPendingLeft === 0 && audit.scanned > 0) {
    console.log(`PASS  both indexes complete: ${audit.scanned} documents scanned, nothing owed`);
    process.exit(0);
  }
}

console.error(`stopped after ${maxRuns} runs; still owed: notes=${last?.pendingLeft} vectors=${last?.vectorsPendingLeft}`);
process.exit(1);
