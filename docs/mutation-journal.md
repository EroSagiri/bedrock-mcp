# Mutation Journal / Mutation Bus（Phase 4D）

本文档描述 Mineral **Vault Worker 内部**的事件通知层：所有知识库修改统一收敛成一条 mutation
事实，再由两个消费者分别负责"实时广播"和"异步索引"。

它**不是**新的 App，**不是**新的 Worker，**没有**新的 RPC 链。仍然只有三个部署单元：

```text
MCP Worker
    ↓ (Service Binding: VAULT)
Vault Worker
    ├── Vault / R2
    ├── Mutation Journal      ← 事实
    ├── Sync Publisher        ← 低延迟消费者
    └── Index Scheduler       ← 索引消费者
Vault Worker
    ↓ (Service Binding: SYNC_GATEWAY)
Sync Gateway
```

---

## 1. 为什么存在

在此之前，"知识库被修改了"这件事只存在于两个互不知情的地方：

```text
Obsidian 插件写 R2 → 插件自己 POST /v1/channels/{channel}/dirty → Gateway
MCP 写 Vault/R2    → 没有任何人被告知（Phase 4D 之前的已知缺口）
```

于是：

* MCP 的写入对其他 Obsidian 客户端不可见，只能靠下次 focus / 重启时全量 LIST 才发现；
* 没有"哪些文档的索引已经过期"的持久化真相，索引只能整体重建。（这两点后来分别由 `pending_index` / `pending_vector` 物化脏集合与 live index 补上；索引本身见 [indexing.md](indexing.md)。）

本层把这件事统一成**一条事实**：

```text
任何写入入口
  → R2 mutation 成功
  → recordMutation()
  → Mutation Journal（事实）
       ├── Sync Publisher → Sync Gateway
       ├── Index Scheduler → pending_index   （笔记索引）
       └── Vector Scheduler → pending_vector （向量索引）
```

`pending_index` 和 `pending_vector` **和事实写在同一个事务里**：一次已提交的写入如果忘了它欠的索引工作，就要等到夜间审计才可能被发现。它们分成两个欠账集合，是因为一个向量发布失败不该把笔记索引重新弄脏。

> 两个索引本身的 schema、发布顺序、接受规则与审计，见 [indexing.md](indexing.md)。

最重要的一条：

> 从这一步开始，任何写入入口只需要保证"R2 mutation 成功后进入 Mutation Journal"，
> 广播与索引都不再由入口自己负责。

---

## 2. 模块依赖图

```text
apps/vault/src/
├── entrypoint.ts                 WorkerEntrypoint：RPC 适配 + /internal/* + cron drain
├── service.ts                    VaultService：唯一的写入实现，写入后调用 recorder
├── document/{objects,r2}.ts      文档辅助（写入一律经过 service，因此不再各自记录）
├── durable/vault-index.ts        VaultIndex DO：note index + Mutation Journal
│                                 + pending_index + pending_vector + 向量状态
├── mutation/
│   ├── types.ts                  MutationEvent / MutationSource / JournalEntry
│   ├── ids.ts                    mutationId 生成、path digest、结构化日志
│   ├── ingress.ts                Obsidian 报告解析 + R2 校验（幂等优先）
│   ├── committed.ts              repair：已落地写入的校验 + 有界幂等重试
│   ├── http.ts                   POST /internal/mutations 的 HTTP 语义
│   ├── recorder.ts               recordMutation()：唯一入口
│   └── store.ts                  MutationStore / MutationJournal 端口
├── index/
│   ├── indexable.ts              两个索引共同承认的"可索引"定义
│   ├── intents.ts                mutation → index intent 的策略与 coalesce 规则
│   ├── text-query.ts             检索查询 → (FTS5 表达式, 中文子串) 的规划
│   ├── live-store.ts             笔记索引 schema 与新鲜度
│   ├── journal-store.ts          SQLite 实现（journal + pending_index，同一事务）
│   ├── memory-store.ts           同语义的内存实现（消费者测试用）
│   ├── scheduler.ts              Index Scheduler：claim → apply → CAS 删除
│   ├── audit.ts / audit-runner.ts 审计状态与"列页、比较、入队"的循环
│   └── parse.ts                  正文 → 标题/标签/链接/frontmatter 派生行
├── vector/
│   ├── schema.ts                 物理契约（模型/宽度/metric）与版本
│   ├── chunk.ts                  标题感知分块 + 内容寻址的 chunk id
│   ├── sha256.ts                 运行时 SHA-256（id 在事务外预计算）
│   ├── embedding.ts              嵌入绑定、模型探针、批量嵌入
│   ├── store.ts                  pending_vector / document_vector_state / vector_chunks
│   ├── publish.ts                发布顺序、删除、GC
│   └── scheduler.ts              Vector Scheduler：claim → apply → CAS → GC
└── sync-publisher/
    ├── gateway-port.ts           GatewayPublisher 端口（只认 mutationId + changes）
    ├── gateway-rpc.ts            Service Binding / HTTP 两种实现
    └── publisher.ts              outbox drain、重试、幂等
```

依赖方向是单向的：

```text
entrypoint → service → mutation/recorder → mutation/store（端口）
                    ↘ index/intents
entrypoint → sync-publisher/publisher → mutation/store（端口）
entrypoint → index/scheduler          → mutation/store（端口）
entrypoint → vector/scheduler         → vector/store（端口）
```

`mutation/*` 不认识 Gateway，也不认识任何一个索引；三个消费者各自依赖端口，不互相依赖。

---

## 3. MutationEvent

```ts
type MutationSource = "obsidian" | "mcp" | "web" | "system";

type MutationEvent =
  | { id: string; source: MutationSource; op: "put";    path: string; etag: string; size: number; committedAt: number }
  | { id: string; source: MutationSource; op: "delete"; path: string; committedAt: number }
  | { id: string; source: MutationSource; op: "rename"; from: string; path: string; etag?: string; size?: number; committedAt: number };
```

第一版**故意不包含**：`gateway generation`、索引状态、重试状态、冲突状态、向量状态。那些属于消费者 —— 索引与向量的状态住在同一个 DO 里，但属于各自的表，从不出现在这条事实里。

`rename` 被类型接受并会被 journalled，但目前**没有任何写入方会产生它**：重命名在入口处就分解成
`delete(from)` + `put(to)`，因此 Gateway 的既有协议不需要被拓宽。

### committedAt 的语义

`committedAt` 是 **Vault 记录这条事实的时间**。它不是分布式墙钟顺序，也不假装等价于
Gateway generation 或用户的真实编辑时间。

---

## 4. Mutation id 是全链路幂等键

```text
mutation_id TEXT NOT NULL UNIQUE
```

* MCP 路径：Vault 生成 `mut_<uuid>`（`crypto.randomUUID()`），随写入结果返回。
* Obsidian 路径：客户端上报时自带，或由服务端生成。

规则：

```text
第一次 mutationId=X → insert → 返回记录
再次   mutationId=X → 不重复 insert → 返回已有记录（seq 相同）
```

场景：

```text
Obsidian POST mutation → 服务端成功 → 响应丢失 → 客户端 retry
→ 不会产生第二条 mutation，也不会二次广播
```

`INSERT` 之前的 `SELECT` 只是快速路径；真正的守卫是 `UNIQUE` 约束——两个并发请求不可能同时观察到
"不存在"然后都插入。

---

## 5. Mutation Journal schema

持久化在 `VaultIndex` Durable Object 的 SQLite 实例里。项目没有 D1 binding —— DO SQLite 就是 durable 存储，而且必须在这里，因为 Journal 事实和两个欠账集合要在同一个事务里提交。命名沿用现有 snake_case 风格。

```sql
CREATE TABLE IF NOT EXISTS mutation_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- 记录顺序，不是 generation
  mutation_id TEXT NOT NULL UNIQUE,        -- 全链路幂等键
  source TEXT NOT NULL,
  op TEXT NOT NULL,
  path TEXT NOT NULL,
  from_path TEXT,
  etag TEXT,
  size INTEGER,
  committed_at INTEGER NOT NULL,
  broadcast_state TEXT NOT NULL DEFAULT 'pending',
  broadcast_attempts INTEGER NOT NULL DEFAULT 0,
  broadcast_last_error TEXT,
  gateway_generation TEXT,                 -- 发布成功后由 publisher 写回
  created_at INTEGER NOT NULL
);
```

要点：

* Journal 表示**已经发生过的事实**，append-only 语义（只追加，只更新 broadcast 列）。
* `seq` 只表示"Vault 收到 mutation 的顺序"，**不等价于** Gateway generation。
* 索引 debounce 状态、retry 状态、`indexed_etag` 都**不在**这张表里。

---

## 6. Mutation Ingress API

```text
POST /internal/mutations
Authorization: Bearer <MUTATION_INGRESS_TOKEN>
X-Mineral-Mutation-Origin: local-write | remote-apply
Content-Type: application/json
```

**这个 HTTP 路由是服务端到服务端的内部面。** 客户端不直接调用它：Obsidian 插件把上报发给 Sync Gateway 的 `POST /v1/channels/{channel}/mutations`，Gateway 认证后通过 `VAULT` service binding 中继到 Vault 的 `recordReportedMutation()` RPC，走的是**同一段**校验与记录逻辑。Gateway 是唯一面向客户端的控制面，而验真和 Journal 都留在 Vault —— 这是两件不能搬走的事。

请求：

```json
{
  "id": "mut_01J...",
  "source": "obsidian",
  "op": "put",
  "path": "daily/2026-09-23.md",
  "etag": "...",
  "size": 1234,
  "committedAt": 1790000000000
}
```

响应：

| 状态 | 含义 | 客户端该做什么 |
| --- | --- | --- |
| `202` | accepted 或 duplicate，事实已持久化 | 什么都不用做；重试同一 id 是 no-op |
| `204` | remote apply，不是新事实 | 什么都不用做 |
| `401` | 未认证 | 检查 token |
| `400` | body 不合法 / source 不被该入口接受 | 修正请求 |
| `409` | 上报的 revision 与 R2 当前状态不符 | 重试"报告"没有意义 |
| `413` | body 过大 | 修正请求 |
| `503` | journal 未能提交 | **必须重试**（同 id），没有半记录 |

安全性：

* 未配置 `MUTATION_INGRESS_TOKEN` 时路由**关闭**（503），避免任意客户端伪造事实。
* `source` 只接受 `obsidian` / `web`；`mcp` 在 MCP 路径之外被拒绝（Vault 自己记录 MCP 写入，
  客户端自称 MCP 是伪造向量）。
* `put` 必须与 R2 当前 ETag 一致（引号归一化后比较）；`delete` 必须确认对象确实已不存在。
* 幂等检查**先于**校验：重试即使 R2 已经前进也仍然成功，否则响应丢失的 retry 永远得不到答复。

---

## 7. 两条写入路径

### MCP（server-authoritative）

```text
MCP tool
  ↓ Service Binding VAULT
VaultEntrypoint.putDocument
  ↓
VaultService.documents.put → R2 PUT（拿到 etag/size）
  ↓
recordMutation({ source: "mcp", op: "put", path, etag, size, committedAt })
  ↓
SQLite: mutation_journal insert + pending_index upsert + pending_vector upsert（同一事务）
  ↓
返回 { etag, size, mutationId, mutationSeq, mutationPending }
  ↓
ctx.waitUntil(drainConsumers())
```

MCP 侧不需要 HEAD 验证——R2 是 Vault 自己写的。MCP 也**不知道** Gateway 和 Indexer 的存在。

### Obsidian（client-authoritative report）

```text
Obsidian 自己条件 PUT R2 → 拿到 ETag
  ↓ POST /internal/mutations（可带 X-Mineral-Mutation-Origin）
Mutation Ingress：解析 → 幂等检查 → R2 HEAD 校验
  ↓
recordMutation({ source: "obsidian", ... })
  ↓
SQLite: mutation_journal insert + pending_index upsert + pending_vector upsert（同一事务）
  ↓
ctx.waitUntil(drainConsumers())
```

最终两条路径在这里完全汇合：

```text
MCP      ─┐
          ├→ recordMutation()
Obsidian ─┘
```

### remote apply 不是 mutation

```text
手机 PUT R2 → mutation → Gateway → PC 下载 → PC 本地写入
```

PC 的本地写入**不是**新的 R2 mutation。若把它也上报，就会形成：

```text
手机 mutation → PC download → PC 再 mutation → echo（永不停止）
```

因此：

* 写入可以显式声明 `X-Mineral-Mutation-Origin: remote-apply`，服务端直接返回 204，不入 journal；
* 即使客户端不声明，上报的 ETag 与 R2 当前值相同也只会是同一个 revision，且 mutation id 不同——
  真正的护栏是：**只有实际改变了 R2 的写入才有资格上报**，下载永远没有。

### 逻辑删除如何被校验（`delete` + revision）

`delete` 有两种，服务端两种都认：

```text
delete 且带 etag  → normalizeEtag(observe(path).etag) === normalizeEtag(etag)   # 该 revision 已被逻辑删除
delete 且不带 etag → observe(path) === null                                    # 硬删除，对象必须已经不在
```

写 tombstone、把对象原地保留的客户端（删除可恢复的前提）**必须**带 revision，否则它的删除报告
永远无法被校验，删除就会既进不了 journal、也广播不出去、索引还会一直留着那篇笔记。revision 只
用于 ingress 校验：`gatewayChangesFor()` 始终把两种 delete 归一成 `{ op: "delete", path }`，
所以 Gateway 的 wire 形状没有被拓宽。

---

## 8. 事务边界

```text
R2 PUT（先）
  ↓
SQLite: journal insert + pending_index upsert + pending_vector upsert（同一事务，要么都成功要么都不成功）
  ↓
commit
```

`ctx.storage.transactionSync()` 提供原子性；intent upsert 失败会让 journal insert 一起回滚。

失败语义：

| 情况 | 语义 |
| --- | --- |
| R2 失败 | 整个操作失败，没有 mutation，没有 intent |
| R2 成功 + journal 失败（MCP） | **写入仍然成功**，返回 `mutationPending: true`，错误进日志，并自动进入 repair（见下） |
| R2 成功 + journal 失败（ingress） | 返回 503，客户端必须带同一 mutation id 重试 |

绝不允许"journal 写失败但假装已经完整记录"。

---

## 8.5 R2 成功、Journal 失败的自愈（repair path）

"R2 是真相"只有在 **Journal 最终一定追上 R2** 时才成立。如果失败后只能等人工 `refresh()`，
那就不是自愈，而只是"异常被暴露出来"。所以这一层有一条不变量：

> 任何已经成功落地 R2、但没有进入 Journal 的 mutation，都必须存在自动的 durable repair path。

三件事共同保证它：

**1. mutation id 在 R2 写入之前就生成。** `VaultService` 在 PUT 之前就拿到 id，因此即使
journal 写入失败，调用方拿到的 `mutationId` 也是**这条事实的** id，而不是空串。repair 因此有稳定
的幂等键可用。

**2. 写入返回后立刻原地重试。** `VaultEntrypoint.afterWrite()` 在 `ctx.waitUntil` 里对同一个 id
重试 `REPAIR_ATTEMPTS`（3）次，退避 `REPAIR_BACKOFF_MS`（200ms）。成功后照常 drain 两个消费者；
失败则打 `mutation repair exhausted`，这次请求内不再重试。journal 的 `mutation_id UNIQUE` 让重试
天然安全——重复只会在日志里留下一条 `mutation duplicate ignored`。

**3. 调用方可以把事实交回来（`recordCommittedMutation`）。** 一个看到 `mutationPending: true`
的写入方持有全部所需信息（id / source / op / path / etag / size），可以只补记录、**不再写 R2**：

```ts
await vault.recordCommittedMutation({
  id: mutationId, source: "mcp", op: "put", path, etag, size, committedAt,
});
```

它幂等（同 id 重复调用返回同一个 seq）、有界重试、永不读写 R2，并且**不会抛错**：输入不合法时返回
`{ recorded: false }`，因为写入方的字节早已落盘，一个坏的报告请求不该看起来像一次失败的写入。

仍然诚实的边界：如果 isolate 在 repair 完成之前被打断，且没有任何调用方交回事实，那么这条事实就
只能靠写入方自己重试——服务端没有一张"未记录已提交写入"的表（那需要 Journal 之外的持久存储）。
这正是 `recordCommittedMutation` 存在的理由：它把"最终一致"落在一个**有幂等键的显式重试**上，
而不是落在"人类以后跑一次 refresh()"上。


---

## 9. Sync Publisher（outbox 语义）

```text
Mutation Journal → Sync Publisher → Sync Gateway
```

映射：

```text
op=put    → { op: "put",    path, etag, size }
op=delete → { op: "delete", path }
op=rename → 按 put 处理（rename 在入口已经被分解，第一版不拓宽 Gateway 协议）
```

* **幂等**：publish 带 `mutationId`。`broadcast_state='published'` 是持久化屏障——一旦置位，
  后续 drain（或重试的请求）**永远不会**为这条 mutation 再调用 Gateway。journal 里保存的
  `gateway_generation` 就是重放时的答案。
* **outbox**：成功 → `published`；失败 → 仍然 `pending`，`broadcast_attempts++`，
  `broadcast_last_error` 记录分类（`transport` / `auth` / `server` / `client` / `disabled`）。
  下一次请求、cron、或 scheduled drain 继续处理。一次 drain 最多 `PUBLISH_BATCH_LIMIT` 条，
  避免一次请求变成无界扇出。
* **Gateway 失败绝不影响写入结果**：publisher 只返回计数，不向写入方抛错。客户端仍可通过
  reconnect、focus reconcile、generation gap、full reconcile 自愈。
* **generation ownership 不动**：journal 的 `seq` 与 Gateway 的 `generation` 是两个独立数字空间。
  Gateway 自己维护 `mutation_id → generation`，再次收到同一 `mutationId` 时返回原 generation，
  不再次广播、不 `generation++`。
* **一次写入只有一个 announcer**：插件配置了 Mutation Ingress 后，**不再**自发 `/dirty`；该次写入的
  generation 只由 Vault 的 publisher 产生（模式级互斥，不是 fallback——报告可能已成功只是响应丢失，
  再发 `/dirty` 会 bump 第二个 generation）。未配置 Ingress 时行为与之前完全一致。
* **channel 必须真的相等**：publisher 由 `MINERAL_R2_ENDPOINT` / `MINERAL_BUCKET` /
  `MINERAL_REMOTE_PREFIX` 派生 channel。channel 是摘要，命名空间错了不会报错，只会发布到一个没人订阅
  的 channel，所以 `wrangler.jsonc` 的占位 endpoint 被视为"未配置"（记录
  `mutation broadcast channel unconfigured` 并停用 publisher），而不是算出一个错误的 channel。
  endpoint 必须是带协议的完整 URL（两侧都走 `canonicalEndpoint()` 重新解析 URL）。

Gateway 侧实现（`RemoteChangeHub`）：

```sql
CREATE TABLE IF NOT EXISTS mutation_dedupe (
  mutation_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

有界记忆（`MUTATION_MEMORY = 4096`）。`markRemoteDirty` 不传 `mutationId` 时保持旧的
level-triggered 行为（一次调用一个 generation），因此既有插件客户端不受影响。

---

## 10. pending_index schema

```sql
CREATE TABLE IF NOT EXISTS pending_index (
  path TEXT PRIMARY KEY,        -- 一个 path 一行，绝不排队
  action TEXT NOT NULL,         -- upsert | remove
  target_etag TEXT,
  source TEXT NOT NULL,
  not_before INTEGER NOT NULL,  -- debounce / retry backoff
  first_dirty_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,  -- 服务端时间：CAS 的排序证人
  attempts INTEGER NOT NULL DEFAULT 0,
  last_claim_at INTEGER,
  last_error TEXT
);
```

`pending_vector` 的形状与它**逐列相同**，由 `recordMutation` 的同一个事务写入。两个集合分开是因为它们的失败互不相关：Vectorize 宕机只应该让向量欠账变大，而不是把笔记索引重新弄脏。

这是**物化脏集合**，不是事件历史：

```text
Mutation Journal          pending_index
101 foo A                 foo → C
102 foo B                 bar → remove
103 foo C
104 bar delete
```

禁止把它们合并成一个 FIFO queue。Journal 用于审计 / 通知 / 恢复 / consumer cursor；
pending_index 只回答一个问题：**现在还有哪些索引工作没做**。

---

## 11. 索引调度规则

| 来源 | 操作 | action | notBefore |
| --- | --- | --- | --- |
| `obsidian` | put | `upsert`（target = 最新 etag） | `now + 30s`（人类编辑是突发性的） |
| `mcp` | put | `upsert` | `now`（有明确完成边界） |
| 任意 | delete | `remove` | `now`（物理删除已经完成） |
| 任意 | rename | `remove(old)` + `upsert(new)` | `now` |

coalesce：

```text
put A → put B → put C   ⇒ pending_index[foo] = upsert C，notBefore 再推迟
put A → delete          ⇒ pending_index[foo] = remove
delete → put C          ⇒ pending_index[foo] = upsert C
```

规则：

* 最新的 action / etag 永远获胜；
* `not_before` 只前进不后退；
* 一次写入让 `attempts` 归零、`last_error` 清空（新的 revision 是新的工作）；
* `INDEX_RETRY_BACKOFF_MS`（5 分钟）只作用于失败重试。

消费 `remove` 的是 `applyIndexIntent` / `applyVectorIntent`：前者重观察 R2 后删除派生行（note / FTS / headings / tags / links），后者删掉该文档在 Vectorize 里的 chunk 再忘掉账本行。

---

## 12. CAS 删除策略

```sql
DELETE FROM pending_index
WHERE path = ? AND action = ? AND IFNULL(target_etag,'') = ?
  AND (last_claim_at IS NULL OR updated_at <= last_claim_at)
```

三重守卫：

1. `path` —— 同一条目；
2. `(action, target_etag)` —— 仍然是 claim 时看到的那份工作；
3. `updated_at <= last_claim_at` —— 这一行**自 claim 以来没有被重写过**。

任何一条不满足 → 删除影响 0 行 → 保留新 intent，并记录 `index intent superseded`：

```text
worker 处理 A 期间来了 B
→ 完成 A 时不能 DELETE pending_index WHERE path=foo
→ 新的 intent B 完好保留
```

claim 也是同样的比较（`UPDATE ... WHERE path=? AND action=? AND target_etag=? AND not_before<=?`），
所以两个 worker 不可能同时"拥有"同一份工作。

---

## 13. stale protection / indexed_etag

```text
intent target_etag = A
worker GET R2 → etag = B
```

不得把 A 当作最终索引结果。实现原则：**永远 index 当前 R2 最新内容**，并把实际观察到的
revision 记录为 `indexed_etag`（`index_meta`）。于是：

```text
R2 ETag == indexed_etag → fresh
不同                     → stale
```

`VaultIndex.applyIndexIntent()` 因此忽略 intent 里的 etag（它只是"当时欠的工作"的提示），
只按 R2 的实际内容写入，并返回真实 `indexedEtag`。

---

## 14. Retention

第一版不做复杂 compaction：

* journal 保留足够长（`VaultIndex.resetMutationState()` 只用于测试）；
* 需要配置时集中定义；
* **retention 不允许影响 pending_index 的正确性**：即使旧 journal 被清理，
  `pending_index` 仍然完整表达当前索引欠账（它有自己的生命周期）。

---

## 15. 日志

不打印 raw path，也不打印正文。约定：

```text
mutation recorded            id=... seq=101 source=mcp op=put path-digest=...
mutation duplicate ignored   id=...
mutation ingress accepted    id=... seq=101 source=obsidian op=put path-digest=...
mutation ingress rejected    id=... source=obsidian op=put path-digest=...
mutation recording incomplete op=put source=mcp id=... error=...
mutation broadcast pending   id=... seq=101 op=put path-digest=... attempts=1
mutation broadcast published id=... seq=101 gatewayGeneration=42
mutation broadcast disabled
index intent upserted/completed/failed/superseded  path-digest=... action=... attempts=...
index drain failed           id=... error=...
```

`path-digest` 是 SHA-256 前 8 字节的 base64url，不可逆但足以把同一文档的多行日志关联起来。

---

## 16. 明确不在本轮范围

```text
新建 Mutation Worker / 第四个 App       → 永不（Journal 是 Vault 内部模块）
重写 Sync Gateway generation            → 不做
重写 Obsidian sync engine               → 不做
Hot Sync / Yjs                          → 未授权
完整 Vectorize 业务                     → 后续
重写 MCP tool schema                    → 不做
Kafka 风格 consumer group / 分布式事务   → 不做
把 Journal 当 index queue               → 禁止
把 index 状态塞进 MutationEvent         → 禁止
```

### 插件侧上报的状态

插件（`../mineral-obsidian-sync`，提交 `b468b3d`）已经完成上报接线：

```text
R2 PUT 响应 ──► OperationResult.remote = { size, etag }
             ──► scheduler change 列表带 etag/size
             ──► (a) Gateway /dirty 通知（hint）
                 (b) POST /internal/mutations（fact，必须有 revision）
```

要点与本文档的契约一致：只有**确认落地**的写入才上报（ambiguous PUT 没有 revision，只作为 hint
进 Gateway）；id 在落地时生成、跨重试复用，且**不由 path/etag 派生**；202 完成、204 非事实、
409 与其他 4xx 永久放弃、429/5xx/超时保留并用同一 id 重发；上报失败不改变任何 cycle 结果；
默认关闭时行为逐字节不变。

删除此前是空的，因为插件的删除是**逻辑删除**（写 tombstone、对象原地保留），而旧的校验要求对象
已经消失，于是必然 409。现在 `delete` 可以携带被删除的 revision（见第 7 节），服务端已经能校验并
记录它——插件侧把删除也纳入上报即可，wire 形状无需改动。

