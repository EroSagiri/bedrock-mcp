# Phase 4A：同步网关与远端变化流

状态：**已实现并部署。** 本文冻结 `mineral-sync-gateway` 的职责和协议边界，是后续实现的依据；实际实现见 [sync-gateway-implementation.md](sync-gateway-implementation.md)。下文第 10、12 节是当时的计划与验证记录，保留原样以便追溯，**不代表当前状态**。

审计基线：`74880389d68ea9c306590fa8895997bd1f6d7858`（`7488038 refactor: serve mcp statelessly`）。

## 1. 已审计的后端

仓库是 npm workspaces monorepo：根 `package.json` 的 `apps/*` 与 `packages/*` 组成工作区；根 `tsconfig.json` 用 `@mineral/core/*` 路径映射共享纯 TypeScript 源码。

| 区域 | 当前实际职责 | 证据 |
| --- | --- | --- |
| `apps/mcp` / `mineral-mcp` | 公共 MCP HTTP、静态令牌认证、MCP tool dispatch；通过 `VAULT` Service Binding 调 Vault RPC | `apps/mcp/wrangler.jsonc`、`src/vault-client.ts` |
| `apps/vault` / `mineral-vault` | 私有 Vault RPC、规范 R2 (`MINERAL`) 操作、`VaultIndex` DO、两小时 cron | `apps/vault/wrangler.jsonc`、`src/entrypoint.ts`、`src/service.ts` |
| `packages/core` | 可跨 Worker 序列化 DTO 与纯 path/search/document 规则 | `packages/core/src/vault-rpc.ts` |

部署命名以各 app 的 `wrangler.jsonc` 为准；根脚本分别是 `deploy:mcp`、`deploy:vault`。MCP 现已通过 `exports` 将旧 `MineralMCP` DO 标为 deleted。Vault 的 `VaultIndex` 是现有 SQLite DO export；历史转移只存在于明确标注 **不得部署** 的 `wrangler.transfer-dry-run.jsonc`。因此新 Gateway 是全新的 DO namespace，**不复制** `MCP_OBJECT`、`MineralMCP` 或 `VaultIndex` 的 migration/transfer 历史。

真正 durable mutation 的入口在 `apps/vault/src/service.ts`：`documents.put` → `MINERAL.put`、`documents.delete` → `MINERAL.delete`、`backupText` → `MINERAL.put`、`move` → `get`、`put`、`delete`。`VaultEntrypoint` 的 `putDocument`、`deleteDocuments`、`backupTextDocument`、`moveDocument` 都只转给这一服务；MCP files/documents/links tools 最终也都走 `VaultClient` → `VAULT` RPC。故 MCP transport 层不拥有“R2 已 durable 成功”的事实。

## 2. 决策与职责边界

新增应用（Phase 4B 才创建）：

```text
apps/
  mcp/                 mineral-mcp：公共 MCP、认证与工具传输层
  vault/               mineral-vault：数据与存储平面
  sync-gateway/        mineral-sync-gateway：同步控制平面
    src/
      index.ts
      auth.ts
      remote-change-hub.ts
packages/
  core/
    src/
      vault-rpc.ts
  sync-core/
    src/
      sync-change.ts    # Obsidian 与 Gateway 共用、无 core 依赖的 DTO
```

`mineral-vault` 继续是规范数据平面：R2 真值、VaultIndex、R2 LIST 和文件读写仍在这里。`mineral-sync-gateway` 是控制平面：RemoteChangeHub、持久 generation、认证后的 HTTP/WS 客户端会话，以及未来的写入方队列、R2 事件通知消费者、临时凭据引导与 Hot 入口。它不是 R2 代理、索引器、规划器、previous state 或 MCP 入口。

不放在 `mineral-mcp`：MCP 请求、认证、工具生命周期与长连接、非 MCP 客户端、未来实时控制平面相互正交；把 WS 挂在 `/mcp` 会把传输权限与同步权限混在一起。

不放在 `mineral-vault`：Vault 应保持私有的权威存储服务；Gateway 是面向外部但受认证保护的客户端会话服务。少一个 Worker 不值得把连接、认证和未来临时凭据的暴露面塞进数据平面。

`packages/core` 只放双方真正需要的稳定、可序列化契约，例如 `RemoteChangeChannel`、`RemoteGeneration`、`RemoteChangeSource`、受限的 `RemoteChangeHint` 与 `MarkRemoteDirtyRequest`。DO 存储结构、socket attachment、认证解析、日志和重连策略都是 Gateway 内部实现，不能塞进 core。

## 3. 通道与 Hub

### 3.1 通道身份

规范身份是插件已有 `RemoteIdentity` 的无密钥规范化值：

```text
canonical endpoint + bucket + normalized remotePrefix
```

`accessKeyId`、`secretAccessKey`、签名 headers、Bearer/Gateway credential 都绝不参与。相同 bucket 的不同 prefix 是不同通道；相同规范身份的 MCP/Vault 与 Obsidian 必须收敛至同一个通道。

网关公开路径不暴露原始 identity。客户端和受控后端共同计算 `channel = base64url(SHA-256(versioned canonical RemoteIdentity))`；`v1:` 的输入域分隔必须保留，且 channel 只允许固定长度的 base64url 字符。Gateway 完成认证和授权后只按不透明通道路由，因此无需得到 R2 secret。实施前必须决定 Vault 的规范身份由何处配置：不能从 MCP 请求或 R2 credential 推导，也不能猜测插件 endpoint。

### 3.2 RemoteChangeHub

一个逻辑通道对应一个 `RemoteChangeHub` DO，使用确定性的 `getByName(channel)` 路由。预期 binding/class：

```text
REMOTE_CHANGE_HUB : DurableObjectNamespace<RemoteChangeHub>
RemoteChangeHub   : 新 SQLite-backed DO class
```

持久状态仅为单调的 `generation: bigint/decimal-string`（初始 `0`）及可选、有上限的协议 metadata。成功 `markRemoteDirty` 先持久递增 generation，再向当前 WebSocket 发出该 generation。内存态只包含连接；使用 DO WebSocket hibernation 时，每个连接只保存最小 attachment（例如认证后的 channel 与协议版本），并假定 constructor 后内存会丢失。DO 重启或逐出不得使 generation 回退。

Hub **不是** R2 真值、对象清单、事件日志、文件体存储、previous state、SyncPlan 或局部扫描执行器。它也不承诺“一次 R2 mutation 恰好一次 increment”：重复 producer 通知可使同一 mutation `+2`，这是正确的保守唤醒。

当前 Cloudflare 文档推荐 DO WebSocket 服务端使用 hibernation API；休眠时连接仍保留但内存会重置，因而状态必须能从持久存储或 attachment 重建。[DO WebSocket 最佳实践](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

## 4. 最小接口与认证

统一版本前缀为 `/v1`。公共 HTTP 与内部 RPC 分开，但最终调用同一个 Gateway 内部的 `hub.markDirty()`：

| 调用方 | 接口 | 行为 |
| --- | --- | --- |
| Obsidian 写入方 | `POST /v1/channels/{channel}/dirty` | Gateway credential 认证；验证小而封闭的 body 后标记为脏，返回当前 generation |
| Obsidian 读取方 | `GET /v1/channels/{channel}` | Gateway credential 认证；返回快照 `{ generation }` |
| Obsidian 读取方 | `POST /v1/channels/{channel}/ticket` | 用 bearer credential 换一个 60 秒的 WebSocket ticket。订阅时可用 ticket 代替长期凭据，URL 里因此不会出现长期 secret |
| Obsidian 读取方 | `GET /v1/channels/{channel}/subscribe`，Upgrade WebSocket | bearer credential 或 ticket 认证并验证 Upgrade；初始先发当前 generation 快照，之后仅发 generation 推进消息 |
| Obsidian 写入方 | `POST /v1/channels/{channel}/mutations` | 客户端报告"我已自行提交到 R2"的写入；Gateway 认证后**中继到 Vault 验真**，把 verdict 原样带回（`accepted` / `duplicate` / `refused`）。Gateway 不读对象、不持 R2 凭据 |
| Vault | `WorkerEntrypoint` RPC `markRemoteDirty(request)` | Service Binding，非公共 HTTP；同样验证契约并汇聚到 Hub |

建议 Gateway 默认入口同时提供经过认证的 HTTP 路由和 `WorkerEntrypoint` RPC class。Vault 侧的 binding 名为 `SYNC_GATEWAY`，service 为 `mineral-sync-gateway`，**必须写 `entrypoint: "SyncGatewayEntrypoint"`** —— 只绑默认导出会打到 fetch handler，那里没有 `markRemoteDirty`，失败形态是每次 mutation 都报 `The RPC receiver does not implement the method "markRemoteDirty"`，而事实会一直堆在 pending。这条由 `scripts/validate-worker-bindings.mjs` 静态守住。

Gateway 需要**一个** Vault Service Binding（`VAULT`），且只用于 `POST /mutations` 这条中继路径：客户端上报的是"我已把某个 revision PUT 到 R2"，只有 R2 能证实它，所以验真和 Journal 都留在 Vault。除这一条外，Gateway 不需要 Vault binding，也不需要 R2 binding；Hub 不读取或验证 R2 内容。Vault 单向调用 Gateway 是不经公网的 Service Binding，符合 [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) 的 Worker 间通信模型。

第一版 Gateway 认证使用独立的最小权限 bearer secret（存为 Worker secret，固定时间比较），不能复用 R2 key。Gateway 设置以后包含 endpoint、credential、opaque channel；它们与 R2 endpoint/access-key/secret-key 分离。实施时可升级为短期签名 token/OAuth，而不改变 channel 或客户端 generation 协议。所有 HTTP 与 WS 请求在进入 DO 前先在 Worker 验证 path、method、auth、body/Upgrade，以避免未认证请求消耗 DO。

`POST` body 可携带受限提示：`source`、`kind`、`writerId`、相对 path 的哈希或经审计的 path。它们仅用于诊断和未来优化：不能成为客户端命令、R2 授权、局部扫描或自我抑制的依据；不得含 content、patch、R2 credentials 或 signed headers。

## 5. 写入方契约

正常顺序固定为：

```text
确认 R2 的持久 mutation 成功
  -> 尽力调用 markRemoteDirty(channel, hint)
  -> Hub 持久递增 generation
  -> WebSocket 唤醒客户端
```

通知不属于 R2 transaction。R2 成功但通知失败时，写仍为成功；绝不 rollback R2，也绝不把 document/MCP write 改报失败。它只表示低延迟发现延后；启动 reconciliation、focus/resume、Sync Now、WS 重连快照都是修复路径。

| 写入方 | Phase 4B/4C/4D 契约 |
| --- | --- |
| Obsidian Cold Sync | 成功 PUT 或已确认可能改变远端的操作后，以 Gateway HTTP 尽力通知；文件不经过 Gateway。 |
| Obsidian ambiguous PUT | 保持 executor 的 `unresolved/ambiguous-put`，不写 previous；**应当**尽力发送 unknown-dirty，以额外 reconciliation 换取不漏掉已被 R2 接受的写。通知不能重定义 PUT 成功。 |
| Vault/MCP | 在 VaultService 内，紧邻每个真实 `MINERAL.put/delete` 成功边界触发；不是 MCP tool 成功时触发。move 的 put 和 delete 是各自 mutation，允许多个 increment。 |
| Hot checkpoint（未来） | 仅 checkpoint 持久写入 R2 后遵守同一契约；hot patch 不进入 Hub。 |
| Queue（未来） | `writer -> Queue -> sync-gateway consumer -> Hub`，允许至少一次投递和重复；客户端仍只看 generation。 |
| R2 Event Notifications（未来） | `R2 events -> Queue -> sync-gateway -> Hub`，作为新增写入方，不替换客户端协议。 |

Vault 的 Service Binding 调用是可观察、受限的尽力副作用：捕获、结构化记录 category（不记 secret/content），不得传播为 R2 mutation failure；本阶段不要求内联重试，也不创建 Queue。未来 Queue 用来缓冲、重试、吸收突发流量，**不是**规范事件历史、恰好一次日志或客户端回放源。

## 6. Generation、WebSocket 与客户端游标

Generation 表示“远端可能已经变化”的持久、水平触发 generation，不是事件序列、版本向量、R2 清单版本或 scheduler `syncDirtyVersion`。后者仍只管理本机 scheduler 的单飞与重新执行；两个数字空间绝不能比较或合并。

WebSocket payload 保持单一的 cold-sync 通知模型：

```json
{ "type": "remote-dirty", "generation": "1843" }
```

首次连接必须先收到 `{ "type": "current-generation", "generation": "1843" }`。不传文档、patch、SyncPlan、对象清单或凭据；未来 Hot realtime 另用 `LiveDocumentRoom`（path-level），而 Hub 是 vault/channel-level。不要预先共用一个 DO class 或消息联合类型。

客户端持久 cursor 分两项：

| 游标 | 含义 | 何时变化 |
| --- | --- | --- |
| `highestAnnouncedGeneration` | 已从 GET/WS 知道的最大 Hub generation | 成功解析 generation 快照或通知后可提升 |
| `lastReconciledGeneration` | 最后被一个**确已覆盖其对应远端观察窗口**的成功完整 reconciliation 确认的 generation | 仅在该 cycle 的结束握手成功后提升到该 cycle 可证明的 generation |

收到 `G` 只提升 `highestAnnouncedGeneration` 并请求 `requestReconcile("remote-change")`；不能直接把 `lastReconciledGeneration = G`。重连不回放 `G+1..N`：读到当前 `N` 后，若 `lastReconciledGeneration != N`，请求一次现有完整 reconciliation。WS 断开仅做有上限的重连退避；**不得**降级为桌面端每 15 秒 R2 LIST polling。

### reconciliation 中 generation 变化时的正确性

每个远端触发的 cycle 在开始前或开始时取得 `cycleStartRemoteGeneration`；它执行现有完整的 `local + remote + previous -> planner -> SafeExecutor`。cycle 结束时必须再次 GET/读取 Hub 的 `generationAfterReconcile`，并只在以下条件全部成立时写 `lastReconciledGeneration = cycleStartRemoteGeneration` 或更高、已被本轮完整观察证明的值：cycle 成功、没有被 config/visibility 停止，且结束读取等于可证明的边界。实现上最简单、最保守的规则是：

```text
start = read current generation (10)
full reconcile against R2
end = read current generation
if cycle succeeded and end == start:
    lastReconciledGeneration = start
else:
    leave lastReconciledGeneration unchanged
    request another remote-change reconciliation
```

时序证明：Windows `last=10`；cycle 取得 `start=10` 并 LIST；期间其他写入方的 R2 mutation 成功、Hub `10 -> 11`，WS 可能到达；cycle 结束读取到 `11 != 10`，所以它不能写 `last=11`，只保留 `10` 并排队下一 cycle。下一 cycle 捕获 `11` 后才有机会成功确认，因此 G11 不会被吞掉。若 WS 消失，结束读取同样保住正确性；若结束读取失败，也不前进游标并依靠重连、启动、focus、Sync Now 修复。该握手是 Gateway 进入插件后的必需契约，不能仅依赖目前 scheduler 的本地 `syncDirtyVersion` 清理逻辑。

本期允许自我通知：Windows upload -> generation++ -> Windows WS -> 完整 reconciliation -> noop。不得按 `writerId == self` 静默忽略，因为同一窗口可混入他人 mutation；额外 noop 比漏掉变化安全。

## 7. 失败矩阵

| 场景 | R2 结果 | 变化信号 | 预期行为 |
| --- | --- | --- | --- |
| R2 写入发生确定性失败 | 失败 | 不得声称 mutation 成功；不发普通 dirty | 保持现有写失败语义；不假设远端变化 |
| R2 写入成功、通知成功 | 成功 | generation 推进 | 对端被唤醒后完整 reconciliation |
| R2 写入成功、通知失败 | 成功 | 缺失或延迟 | 写成功语义不变；修复路径最终发现 |
| ambiguous PUT、通知成功 | unresolved | generation 可能推进 | 不提交 previous、不报告写成功；对端可进行无害 reconciliation |
| ambiguous PUT、通知失败 | unresolved | 缺失 | 保持 unresolved 和既有重试/修复行为 |
| Vault 写入时 Gateway 不可用 | 成功 | 尽力通知失败 | MCP 响应仍成功；记录安全分类 |
| 插件上传时 Gateway 不可用 | 成功 | 尽力通知失败 | executor 结果仍只由 R2/state 决定 |
| 重复调用 markDirty | 持久数据未变 | `+1` 或更多 | 有效；可出现一次或多次 reconciliation/noop |
| Gateway/Hub 重启 | 未变化 | 保留持久 generation，socket 重连 | generation 不回退；重连快照追上 |
| WS 断开 | 未变化 | 允许漏掉帧 | 有上限的重连后比较当前 generation |
| 客户端重启 | 未变化 | 恢复游标后读取 GET/WS 快照 | 不一致时完整 reconciliation |
| reconciliation 中 generation 变化 | 已变化 | 结束检查不一致 | 不得把 `lastReconciled` 推进超过已观察 cycle；重新执行 |

## 8. 必须覆盖的时序案例

1. **Android -> Windows 在线：**Android SafeExecutor PUT 成功 -> 插件标记为脏 -> Hub generation 递增 -> Windows WS 收到 `G` -> `requestReconcile("remote-change")` -> 既有 planner 安全地选择 download。
2. **Windows 断开：**Android mutation 令 Hub 从 10 到 15；Windows 重连快照返回 15；保存的 `lastReconciled=10` 不一致，因此执行一次完整 reconciliation，绝不回放 11..15。
3. **MCP 写入：**MCP tool -> `VAULT` RPC -> VaultService `MINERAL.put` 成功 -> Vault 尽力调用 `SYNC_GATEWAY.markRemoteDirty` -> 所有已认证订阅者被唤醒。
4. **Gateway 失败：**Vault 的 R2 成功后，binding 调用失败仍保持 MCP 成功；发现工作等待修复路径。
5. **自身事件：**客户端 upload 后收到自身的 G；允许一次额外 no-op cycle。
6. **reconciliation 期间：**第 6 节的开始/结束 generation 协议保留新的 G 为 pending，因此下一完整 cycle 会观察它。
7. **Ambiguous PUT：**插件可以发送 unknown-dirty，保留 `unresolved/ambiguous-put` 且不写 previous baseline；绝不因为通知而报告成功。
8. **未来 Queue：**Vault/插件写入方 -> Queue -> Gateway consumer -> 同一个 Hub；客户端不变。
9. **未来 R2 Event Notifications：**event -> Queue -> Gateway -> 同一个 Hub；重复仍然无害。
10. **未来 Hot checkpoint：**只有持久 checkpoint 写入才发布至 Hub；活跃 patch 流量留在独立的 LiveDocumentRoom。

## 9. 实施契约

### 必须遵守

1. Gateway 必须位于本 monorepo 的 `apps/sync-gateway`。
2. 部署的 Worker 必须命名为 `mineral-sync-gateway`。
3. Vault 必须保持为数据与存储平面。
4. Gateway 必须保持为同步控制平面。
5. 每个通知必须只被视为提示，绝不能视为 R2 真值。
6. 一个规范通道必须路由至一个确定性的 Hub DO。
7. 必须在宣告前持久写入 generation。
8. Hub 重启或休眠后必须保留 durable generation。
9. 只能经现有完整 scheduler/planner 路径 reconciliation。
10. 重连时必须比较 generation。
11. 必须维护相互独立的已宣告和已 reconciliation 游标。
12. 推进 reconciliation 游标前必须执行开始/结束握手。
13. 必须容忍重复通知和不连续的 generation 跳跃。
14. 只有确认 R2 mutation 已持久成功后才能发送普通通知。
15. 必须将通知失败与 R2 写成功分开处理。
16. ambiguous PUT 必须保持 unresolved，同时允许尽力发送 unknown-dirty。
17. 公共 HTTP 与 WS 必须在路由至 DO 前认证。
18. 必须使用独立的 Gateway credential。
19. 公共 HTTP 和 Vault RPC 必须分离，但在内部汇聚。
20. 必须为 Queue 保留写入方至 Hub 的插入点。
21. WS 必须使用有上限的重连退避。
22. 将来修改 binding config 后必须生成 binding types，并测试两个 app 的契约。

### 严禁

1. 严禁把规范 R2 存储迁入 Gateway。
2. 严禁让所有文档字节经 Gateway 代理。
3. 严禁让 Gateway 成为 planner、state store 或 R2 inventory。
4. 严禁把 generation 解释为一次 mutation 恰好对应一个事件。
5. 严禁要求恰好一次投递。
6. 严禁回放每个漏掉的 generation。
7. 严禁增加桌面端定期 R2 LIST polling。
8. 严禁根据 event kind/path hint 直接触发本地 delete/download。
9. 严禁合并 LiveDocumentRoom 和 RemoteChangeHub。
10. 严禁在事件或通道身份中放入 R2 credentials 或 signed headers。
11. 严禁从 credential 推导 channel。
12. 严禁让 MCP transport 在 Vault 确认 mutation 前宣告变化。
13. 严禁因 Gateway 失败 rollback R2。
14. 严禁因通知失败把成功的 R2 写报告为失败。
15. 严禁因通知成功把 ambiguous PUT 变成成功。
16. 严禁仅因收到 WS 就推进 `lastReconciledGeneration`。
17. 严禁跨越 cycle 开始后看到的 generation 变化推进游标。
18. 严禁创建一个全 Vault 共用的 Hub DO。
19. 严禁把旧 DO transfer/migration 历史复制到 Gateway。
20. 严禁在 Phase 4A 创建 Queue、DO、Worker config、WebSocket 或插件代码。
21. 严禁在 Hub 中存储无上限的事件历史或文件 payload。
22. 严禁向 Gateway 暴露 Vault 的 R2 binding。

## 10. 预期的未来绑定与阶段（历史记录）

> 本节是实施前的计划。实际落地与之有两处不同，都以本文第 4 节为准：Gateway **确实**需要一个 Vault Service Binding（只用于 `POST /mutations` 中继），并且 `/ticket` 已经实现，订阅可以用 60 秒 ticket 代替长期 bearer secret。Phase 4C/4D/4E 的状态见文末。

Phase 4B 的配置（本阶段不创建）只需要指向新 `RemoteChangeHub` 的 `REMOTE_CHANGE_HUB`；它不需要 R2 或 Vault service binding。Phase 4D 才只向 Vault 增加 `SYNC_GATEWAY`，指向 `mineral-sync-gateway`。Gateway 应拥有自己的 SQLite DO export/migration；其 compatibility date、可观测性 trace/log 及生成的 binding 都必须在实施时对照已安装的 Wrangler schema 验证。Cloudflare 文档要求先在 Worker 验证和路由 WebSocket Upgrade，再代理给 DO，并建议闲置的长连接 DO WebSocket 使用 hibernation。[WebSocket 路由指引](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

实施顺序：

```text
Phase 4A  本文冻结的 Gateway/Hub 语义
Phase 4B  apps/sync-gateway：DO generation、HTTP/RPC 与 WebSocket
Phase 4C  Obsidian 写入方/客户端接入及游标握手
Phase 4D  在 VaultService mutation 边界接入 Vault/MCP 写入方
Phase 4E  由 Queue 支持的写入方投递
Future    R2 Event Notifications 写入方；另行授权的 Hot realtime
```

## 11. 收敛后的实施问题

只保留以下实施时选择：

- exact production hostname and Gateway bearer/token encoding/rotation process;
- exact `RemoteIdentity` configuration authority for Vault, including migration if plugin and backend configs differ;
- exact hibernation attachment fields and WS close/reconnect timings;
- final binding names and DO export tag after checking current Wrangler schema/types;
- telemetry sampling/retention and safe diagnostic fields;
- whether first generation is a decimal string or another explicitly lossless client representation.

## 12. Phase 4A 验证（历史记录）

> 当时的验证只修改文档。当前状态见文末。

本阶段只修改文档。后端基线校验通过：`npm run typecheck`；`npm test` 在 4 个文件中通过 12 个测试。测试运行时警告：本地 Miniflare 最高支持 compatibility date `2026-03-10`，而 Worker config 要求 `2026-04-28`；这不影响 TypeScript/文档架构，但 Phase 4B 在宣称功能验证前，必须使用兼容的当前运行时完成 runtime/WS 测试。

---

## 13. 实际落地状态

| 阶段 | 状态 |
|---|---|
| Phase 4A 本文的语义 | ✅ 冻结 |
| Phase 4B `apps/sync-gateway` | ✅ 已实现并部署（generation、HTTP、RPC、WebSocket、ticket 均已上线） |
| Phase 4C 客户端接入 | ✅ 插件已接入（ticket 订阅 + 上报） |
| Phase 4D Vault/MCP 写入方接入 | ✅ 由 Mutation Journal 承担：写入方只记事实，Sync Publisher 投递 |
| Phase 4E Queue 投递 | ❌ 未做。当前是 Vault 内的 outbox + 2 小时 cron 重试 |
| Future R2 Event Notifications / Hot realtime | ❌ 未做 |

Phase 4D 的最终形态与本文最初设想不同：不是"Vault 直接调 Gateway"，而是**先写 Mutation Journal**，再由 Sync Publisher 以 outbox 语义投递。这样 Gateway 宕机只会留下 pending 事实，不会让一次已成功的 R2 写入看起来失败。

**当时结论：同步网关架构已准备好进入实现阶段：是。**

**现在：已实现、已部署、已在生产验证。**
