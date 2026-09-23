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

let last = null;
for (let run = 1; run <= maxRuns; run++) {
  const refresh = await mcp.callTool("vault_index_refresh");
  if (refresh.isError) {
    console.error(`run ${run}: vault_index_refresh failed\n${refresh.text}`);
    process.exit(1);
  }
  const audit = JSON.parse(refresh.text);
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
