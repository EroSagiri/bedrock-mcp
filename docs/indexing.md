# 索引

Mineral 有两个索引，它们在同一个 Durable Object 的同一个 SQLite 实例里，但回答不同的问题：

| | 笔记索引 | 向量索引 |
|---|---|---|
| 回答 | 全文、标签、链接、frontmatter、文件名、目录、统计 | 语义、相似内容 |
| 存储 | `documents` + 派生表 + `documents_fts` | `vector_chunks` 账本 + Vectorize |
| 实体 | SQLite 内 | Workers AI（嵌入）+ Vectorize（检索） |
| 一致 | 提交即精确 | 最终一致（含 Vectorize 自身的一致性延迟） |

两者共享一个 DO，是因为 **`recordMutation()` 必须在一个事务里把 Journal 事实和它欠下的索引工作一起提交**。它们各自有独立的欠账集合（`pending_index` / `pending_vector`），因为一个向量发布失败不该把笔记索引重新弄脏。

---

## 1. 笔记索引

### 1.1 一张表描述一篇文档，一个事务提交一个版本

`documents` 每行是**当前**状态，不带 generation —— 索引不是整体重建的快照，而是每篇文档独立更新的物化视图。

```sql
documents(id, key UNIQUE, indexed_etag, content_sha256, title,
          content_type, modified, size, indexed_at, index_version)
document_headings(document_id, ordinal, level, text, line)
frontmatter_values(document_id, field, value)
document_tags(document_id, tag, source, occurrences)
links(document_id, to_key)
documents_fts(title, path UNINDEXED, headings, tags, body)   -- FTS5, unicode61
```

全部派生行、`indexed_etag` 和 `index_version` 由**同一个事务**写入。所以这两列是提交标记而不是进度标记：读者要么看到一个完整索引过的版本，要么看到上一个版本，不存在"索引说这篇是最新的、但它的标签还没写进去"。

`documents_fts` 是**普通 FTS5，不是 contentless**：搜索结果必须能只靠索引渲染出片段，而不是为了一个 snippet 再回一趟 R2。vault 小到不值得为此优化。

`content_sha256` 用来识别"内容没变但 R2 说这是一个新版本"的改写。

### 1.2 新鲜度只有一个问题

```ts
freshnessStatus(row, observedEtag):
  没有行 + R2 也没有        → absent    （确实没有，索引也知道）
  没有行 + R2 有            → missing   （从没成功发布过）
  observedEtag === null     → stale     （R2 没了但索引还留着）
  indexed_etag !== observed → stale     （R2 动了）
  index_version 落后        → outdated  （解析器变了，需要重新派生）
  否则                      → fresh
```

`absent` 和 `missing` 是两个不同的答案，这正是它值得分开的原因。

### 1.3 欠账是物化的，不是事件流

`pending_index` 用 `path` 做主键，只保留**当前最终动作**：

```
path · action · target_etag · source · not_before · first_dirty_at · updated_at
     · attempts · last_claim_at · last_error
```

它不是 FIFO 队列，是"这个路径还欠什么"。合并规则：最新的 action 和 target 赢，`not_before` 只会向前推，新到达会清掉 backoff。

防抖只针对**人的编辑**：

```
obsidian + put  → committedAt + 30s
delete          → 立即（已是既成事实）
mcp             → 立即（有完成边界）
```

### 1.4 索引器只相信 R2

`applyIndexIntent({path, action})` 会**重新观察 R2**，绝不按 intent 里的 `target_etag` 直接写入。`remove` 也一样：如果对象还在，就索引它而不是删除它。这就是为什么审计的删除候选只能是提示 —— 审计可能错，这个方法不会。

调度器逐个路径 **claim**（比对 `(action, target_etag)` 三元组），完成时用同样的条件做 CAS 删除。索引期间有新 mutation 到达，claim 会 superseded，新 intent 原样保留。

### 1.5 全文检索：拉丁词走倒排，中文走子串

`unicode61` 是面向单词的分词器：两个标点之间的一整段中文是**一个 token**。所以 `心率` 不是 token，它是 `实时查看心率的工具` 的碎片 —— MATCH 对每一篇"把词写在句子里"的笔记都回答否。

于是查询被拆开（`apps/vault/src/index/text-query.ts`）：

- **拉丁词**交给 FTS5，保留 bm25（权重 title 10 / path 0 / headings 4 / tags 2 / body 1）；
- **中文串**由 SQLite 自己按子串匹配（`instr`），精确而非 bigram 近似，不依赖分词器，本地引擎与生产行为一致，排序按出现位置（title 100 / heading 40 / tag 30 / body 10 + 出现次数）；
- 结果里的 `ranking` 说明是哪一半答的（`bm25` / `phrase`），因为两种分数不可比。

同一个查询也不再是 FTS5 表达式。`probe-tag` 曾经是 `probe NOT tag`，不配对的引号是语法错误，`*` 和 `:` 会悄悄改变问题。现在每个词都被引号包住，只有独立大写的 `AND` / `OR` / `NOT` 还是运算符。

**成本**：中文子串匹配是一次对已存文本的扫描。391 篇 / 约 1.5MB 下是毫秒级，且**不读 R2**。规模再上一个数量级时应该换成真分词器或 bigram 倒排，而不是继续扫。

### 1.6 就绪状态

```ts
indexReady = documents > 0 || indexed_at !== null || last_audit_at !== null
```

只有"从没发布过、也从没审计过"才是 false。**空的已审计 vault 是 ready 的** —— "它是空的"是一个真实答案；从未运行过的索引不是。查询工具据此返回 `index_not_ready`，而不是把一个没建好的索引报成空 vault。

---

## 2. 向量索引

### 2.1 物理契约在 `VECTOR_SCHEMA`

```ts
{ version: 1, model: "@cf/qwen/qwen3-embedding-0.6b", dimensions: 1024,
  metric: "cosine", chunkerVersion: 1 }
```

宽度和 metric 在 `wrangler vectorize create` 时定死，之后不可改；两个模型即使同宽也不共享向量空间。所以这五个值是**索引的身份**，由 `/internal/vector-health` 报告。任何一项变化都意味着新索引 + backfill，绝不原地覆盖。

首次发布时把物理身份记进 `index_meta.vector_index_schema`；之后不一致就让 drain 拒绝发布（`schemaMismatch`）—— 混两个向量空间是静默且不可修复的。

创建命令（宽度必须先用 `vault_embedding_probe` 实测确认）：

```bash
npx wrangler vectorize create mineral-notes --dimensions=1024 --metric=cosine
```

### 2.2 chunk id 是内容寻址的物理身份

```
base64url(sha256(canonical))[:32]        -- 192 bit
canonical = "mineral-vector-chunk-v1" + 长度前缀的
            (document_id, content_sha256, chunker_version, model, vector_version, ordinal)
```

两个后果都是刻意的：新版本的 chunk **不可能**与旧版本碰撞，所以慢 worker 无法覆盖已发布的版本；换 chunker 或换模型会得到不同的 id 空间，而不是悄悄复用一组由别的函数产生的向量。

摘要用的是运行时自带的 SHA-256。早期版本有一份手写同步实现（因为 id 曾在事务内推导），现在不需要了 —— id 只依赖事务开始前就已知的值，所以摘要在事务外 `await` 完成，事务只写已经存在的 id。旧实现留着当测试对照物（`test/vector-sha256-oracle.ts`），因为 id 是物理键，替换必须被**钉住**而不是被信任。

### 2.3 分块

标题是作者自己的结构，比任意字数切分更可信：

```
按 heading 切 section（跳过代码块里的 #）
  → 段落分组，目标 ~1000 字符，硬上限 1500，重叠 150
  → frontmatter 剥掉（里面是 URL 和凭据，不该进相似度空间）
  → 嵌入文本 = "Title: … / Heading: … / Tags: …" + 正文
```

### 2.4 三张表

```
pending_vector          欠下的工作（与 Journal 同一事务写入）
document_vector_state   已经发布出去的状态：active_* / desired_* / status
vector_chunks           账本：Vectorize 里的每个 chunk id + 它的文本
```

- **`pending_vector`** 在 `recordMutation` 的同一个事务里写，且只在事实**新插入**时写 —— 重复上报不能清掉一个正在失败的路径的 backoff。没有它，一次已提交的写入要等到夜间审计才可能被向量化。
- **`document_vector_state`** 把 `active_*`（Vectorize 里真正完整存在的那一版）与 `desired_*`（本次尝试瞄准的那一版）分开。`beginAttempt` **只在该行当前没有可服务的 active 版本时**才降级 `status`，所以重新嵌入期间旧版本继续被服务，直到新版本原子发布。
- **`vector_chunks`** 是唯一的清理账本。Vectorize 没有列举 API，**没被记下来的向量永远找不回来**，所以删除账本行永远是清理的最后一步。它同时存 chunk 文本，所以语义结果不需要再读 R2。

三张表都刻意没有外键、没有级联。`documents.id` 是 `AUTOINCREMENT`，被删笔记的 id 不会被交给新笔记。

### 2.5 发布顺序就是契约

```
1. chunk + 取 id        事务外，await 摘要
2. beginAttempt         记录 desired_*，让中断可见
3. 嵌入 + Vectorize 写入  必须先于第 4 步
4. 发布事务             账本行 + active_*（一次事务）
5. GC                 删掉旧版本的向量，再忘掉账本行
```

第 3 步早于第 4 步是全部安全性的来源：id 是内容寻址的，所以"已 upsert 但没发布"的版本对检索不可见（没有账本行，`active_*` 仍指旧内容），重试会算出**完全相同的 id** 并认领它们。

嵌入耗时足够长，文件可能在下面被改掉，所以发布前会再 `head` 一次；版本动了就放弃这次发布（deferred，不是 failed）。

三种中断都自愈：

| 中断点 | 状态 | 自愈方式 |
|---|---|---|
| upsert 之后、发布之前 | 孤儿向量 + `desired_*` 无 active | 重试算出相同 id 直接认领 |
| 发布之后、GC 之前 | 旧账本行仍在 | 就是 GC 的工作清单 |
| GC 删了向量、没删账本行 | 账本行仍在 | 重删幂等，然后清账本 |

**唯一不可回收的情况**：upsert 之后崩溃且内容在此期间变了。那批 id 不在账本里，GC 找不到它们，检索也看不到它们（没有账本行就无法变成文本）。它每篇最多一次、只占存储，重试同样内容时会自动认领。

### 2.6 接受规则（决定一个检索结果能不能给用户看）

一条命中只有同时满足才被接受：

```sql
账本行存在                                   -- 这是 chunk id 变成文本的唯一途径
AND status = 'ready'                         -- active 版本发布完整
AND v.content_sha256 = s.active_content_sha256   -- 属于已发布的那一版，不是待回收的旧版
AND s.active_content_sha256 = d.content_sha256   -- 笔记索引也到了同一版
AND active_chunker_version / embedding_model / vector_version 都是当前值
AND active_chunk_count = 该版本账本行数        -- 让身份列可被核对，而不是被信任
AND d.key LIKE prefix
```

任何一条不满足就拒绝。**全部候选被拒**会记 `vector search filtered every candidate` 并累计到 `filteredAllSearches` —— 那不是"没有结果"，是"索引里的向量不再描述 vault 现在持有的版本"，值得报警。

路径过滤在 SQLite 里做，不在 Vectorize 里：索引元数据因此不含路径，Vectorize 侧也就没有可以和 SQLite 打架的东西。

### 2.7 失效与 sweep

新鲜度 = `content_sha256 + chunker_version + embedding_model + vector_index_version`。

"内容没变但 chunker 变了"这种事，R2 没有任何变化，笔记索引也完全最新 —— **R2 walk 永远看不见它**。所以夜间审计在走完 R2 之后跑一次 `enqueueStaleVectors`：直接问向量状态，把 version 不匹配、状态非 ready、或 active 与笔记索引不一致的文档全部重新排队。这是让"换 chunker"变成一次后台重嵌入而不是一次人工迁移的唯一路径。

### 2.8 语义检索的最终一致性

**Vectorize 自己是最终一致的**：刚发布的 chunk 可能还检索不到，实测约 20–45 秒，删除同理。这不是 Vault 的延迟，工程上消不掉。

所以刚写完就要立刻拿到答案，请用 `search_text`（笔记索引提交即可精确回答）。这一条写在 `search_semantic` 的工具描述里。

### 2.9 成本

drain 的批量刻意小：每次请求 4 篇，审计每页 8 篇、结尾 32 篇。全量重嵌入 391 篇实测用了 7 轮 `vault_index_refresh`。日常增量远小于此。

---

## 3. 审计

审计是**纠正路径**，不是消费者。它只做三件事：列举、比较、入队 —— **从不写索引**，写入永远由同一个 `applyIndexIntent` / `applyVectorIntent` 完成，所以审计不可能变成第二套规则的写入者。

两个 cron：

```
0 */2 * * *      drain：重试投递、推进两个索引（安全网）
30 19 * * *      03:30 +08:00 夜间审计（纠正）
```

分开是因为一次全量 walk 不该拖慢低延迟路径。

- 页面大小 200 个 R2 对象，最多 200 页（防游标出错，不是常规工作量的限制）
- 每页之后推进笔记索引 32 篇、向量 8 篇；结束再扫一次 sweep、推 32 篇向量
- **删除候选带一道额外的闸**：只考虑 `indexed_at < audit_started_at` 的文档。walk 期间刚索引的文档可能只是当时还没出现在被列出的那一页上，把它当成"不存在"会给活着的文件排一次删除。
- 审计可恢复：`startIndexAudit` 会报告已在运行的那一次，游标接着走。

`vault_index_refresh` 是触发它的唯一入口，也是索引落后的唯一修复路径 —— 检索不承担修复职责。
