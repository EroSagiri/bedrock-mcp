import { isDeletionIndexPage, type DeletionIndexPage } from "@mineral/sync-core/deletion-index";

export type VaultDeletionBinding = {
  listSyncDeletions?(input: { channel: string; snapshotSeq?: string; cursor?: string; limit: number }): Promise<DeletionIndexPage | null>;
};

const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers });

/** Read-only relay. The Gateway authenticates and scopes; the Vault owns the journal query. */
export async function handleDeletionIndex(request: Request, channel: string, vault: VaultDeletionBinding | undefined): Promise<Response> {
  if (!vault?.listSyncDeletions) return json(503, { error: "deletion_index_unavailable" });
  const url = new URL(request.url);
  const snapshotSeq = url.searchParams.get("snapshot") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitText = url.searchParams.get("limit") ?? "200";
  if (snapshotSeq !== undefined && !/^(0|[1-9]\d*)$/.test(snapshotSeq)) return json(400, { error: "invalid_request" });
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4096 || cursor.startsWith("/") || cursor.includes("\0"))) return json(400, { error: "invalid_request" });
  if (!/^\d+$/.test(limitText)) return json(400, { error: "invalid_request" });
  const limit = Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return json(400, { error: "invalid_request" });
  try {
    const page = await vault.listSyncDeletions({ channel, snapshotSeq, cursor, limit });
    if (page === null) return json(404, { error: "unknown_channel" });
    if (!isDeletionIndexPage(page)) return json(503, { error: "deletion_index_unavailable" });
    return Response.json(page, { headers });
  } catch (error) {
    if (error instanceof TypeError) return json(400, { error: "invalid_request" });
    return json(503, { error: "deletion_index_unavailable" });
  }
}
