# Phase 4B：Sync Gateway implementation

`apps/sync-gateway` implements the Phase 4A control plane only. It has one
SQLite-backed `RemoteChangeHub` Durable Object per opaque channel and stores
only the durable decimal-string generation. It has no R2 or service bindings.
Its cross-repository DTOs live in dependency-free `packages/sync-core` rather
than the backend `packages/core` package.

## Public surface

All public routes require `Authorization: Bearer <SYNC_GATEWAY_TOKEN>` and use
`Cache-Control: no-store`:

- `GET /v1/channels/{channel}` returns `{ "generation": "0" }`.
- `POST /v1/channels/{channel}/dirty` accepts `{}` or bounded optional hints
  (`source`, `kind`, `writerId`, `pathHash`) and returns the new generation.
- `GET /v1/channels/{channel}/subscribe` requires `Upgrade: websocket` and
  sends `current-generation` first, then `remote-dirty` messages.

Channels are exactly 43 unpadded base64url characters. The Gateway does not
derive them from endpoints, buckets, prefixes, or credentials.

`SyncGatewayEntrypoint.markRemoteDirty()` is the future Service Binding RPC
surface. It validates the same stable core DTO and routes to the same Hub as
HTTP. No Vault binding is added in this phase.

## Durable behavior

The hub keeps its generation as a canonical decimal string in Durable Object
storage and uses `bigint` only for arithmetic. Each mark performs storage
read/increment/write in one DO storage transaction, then broadcasts. A client
therefore cannot receive a generation which was not already durable. Socket
attachments contain only protocol metadata; client messages are ignored.

## Local verification

Run `npm run cf-typegen:sync-gateway`, `npm run typecheck`, and `npm test`.
The test runtime uses the current Cloudflare Vitest plugin rather than the
retired pool package so its compatibility date covers `2026-04-28`.
