# Phase 4B：Sync Gateway implementation

`apps/sync-gateway` 实现 Phase 4A 描述的控制平面。每个不透明 channel 一个
SQLite-backed `RemoteChangeHub` Durable Object，只持久化十进制字符串形式的
generation。

它**没有 R2 binding**，也永远不该有：Gateway 不读、不写、不校验 R2 内容。

跨仓库 DTO 放在零依赖的 `packages/sync-core`，而不是后端的 `packages/core`。

## Public surface

所有公共路由都要求 `Authorization: Bearer <SYNC_GATEWAY_TOKEN>`，并带
`Cache-Control: no-store`：

- `GET /v1/channels/{channel}` 返回 `{ "generation": "0" }`。
- `POST /v1/channels/{channel}/dirty` 接受 `{}` 或有界提示
  （`source`、`kind`、`writerId`、`pathHash`），返回新的 generation。
- `GET /v1/channels/{channel}/subscribe` 要求 `Upgrade: websocket`，
  先发 `current-generation`，之后只发 `remote-dirty`。
- `POST /v1/channels/{channel}/ticket` 签发短期 WebSocket ticket
  （`{ protocol, ticket, expiresAt }`，TTL 60 秒）。订阅可以带 bearer secret，
  也可以带 ticket，因此长期凭据不必进入浏览器或 WebSocket URL。ticket 交换
  本身要求 bearer secret —— ticket 不能用来换 ticket。
- `POST /v1/channels/{channel}/mutations` 接收客户端**已自行提交到 R2** 的
  mutation 报告，中继到 Vault 验真，并把 verdict 原样带回。

channel 恰好是 43 个无填充 base64url 字符。Gateway 不根据 endpoint、bucket、
prefix 或凭据推导 channel。

## Vault 中继（Phase 5）

Gateway 持有一个 `VAULT` service binding（`mineral-vault` 的默认 entrypoint），
只用于一条路径：`POST /v1/channels/{channel}/mutations`。

分工是刻意的。客户端上报的是"我已经把某个 revision PUT 到 R2 了"，只有 R2 能
证实这句话。所以 **Vault 保留两件不能搬走的事**：对着权威对象验真，以及
Journal。Gateway 提供的是唯一面向客户端的控制面 —— 认证、channel、generation
—— 加上一次 service binding 调用，不碰凭据，也不解释内容。

`SyncGatewayEntrypoint.markRemoteDirty()` 是反向的 Service Binding RPC 面，
由 Vault 的 Sync Publisher 调用。它验证同一套稳定 core DTO，并汇聚到与 HTTP
相同的 Hub。

## Durable behavior

Hub 把 generation 作为规范十进制字符串存在 Durable Object storage 里，只用
`bigint` 做算术。每次 mark 都在一个 DO storage 事务里完成读/自增/写，然后广播。
因此客户端不可能收到一个尚未 durable 的 generation。Socket attachment 只含协议
元数据；客户端消息被忽略。

## 本地验证

`npm run cf-typegen:sync-gateway`、`npm run typecheck`、`npm test`。
测试运行时用的是当前 Cloudflare Vitest 插件，而不是已废弃的 pool 包，所以它的
compatibility date 能覆盖 `2026-04-28`。

对已部署实例做认证与协议冒烟：

```bash
node scripts/validate-sync-gateway-deployment.mjs <gatewayBaseUrl> <tokenFile>
```

token 只从文件路径读，**不要**放到命令行上。
