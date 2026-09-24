# MCP 接口

`mineral-mcp` 对外是 **33 个工具 / 4 个 prompt / 6 个 resource**。这份文档是它们的清单，以及它们背后唯一的检索模型。

接口形状由 `apps/mcp/src/mcp/compat.ts` 统一注册，工具定义里的 schema 就是下面表格里的参数；改工具时要一起改这里。

这份文档的**理由**是手写的，**事实**是可验证的：`node scripts/dump-mcp-surface.mjs tools` 会把部署环境实际的 `tools/list` 打成 markdown 表格，和下面第 2 节逐行对拍即可。客户端真正收到的定义以部署为准 —— 工具名映射、注解和后处理都发生在注册层。

---

## 1. 检索模型：只有一个

调用方**不选择**检索方式。笔记索引回答检索，向量索引回答语义，R2 只用来读取具体文件的内容。没有 `readMode`，没有实扫回退。

```
search_text            → 笔记索引（决定"有没有"）
search_semantic        → 向量索引（决定"像不像"）
doc_read               → R2（决定"是什么"）
vault_list_documents   → R2 List（决定"有哪些"，含二进制）
```

### 索引不能回答时

| 情况 | 回答 |
|---|---|
| 索引落后于 R2 | 正常结果 + `partial: true` + `staleDocuments` + 指向 `vault_index_refresh` |
| 索引从未初始化 | `index_not_ready`（附 `documents` / `lastAuditAt` / 补救办法） |
| 索引抛错 | `index_unavailable` + 它说了什么 + 补救办法 |

三条路径都**不读取任何文档**。"没找到"和"我没法看"是两个不同的答案，返回空列表把它们混为一谈是本项目明确拒绝的做法。

### 旧客户端的 `readMode`

参数已从所有工具定义中删除。缓存了旧定义的客户端可能还会传：

- `readMode: "index"` —— 它命名的本来就是唯一正确的行为，接受并忽略
- `readMode: "live"` —— **按名字拒绝**（`live_mode_removed`）。静默用索引回答它是"对另一个问题给出了答案"，而且绝不允许它启动实扫

参数不在任何 schema 里，客户端读定义发现不了它。注册层刻意让未声明的键通过校验，正是为了能在不把它写进工具定义的前提下按名字拒绝。

---

## 2. 工具

`*` = 必填。所有工具都带 `readOnlyHint` / `destructiveHint` / `idempotentHint` 注解（由工具名映射，见 `compat.ts` 的 `TOOL_METADATA`）。

### 2.1 检索（8）

| 工具 | 参数 | 行为 |
|---|---|---|
| `search_text` | `query*`, `searchIn[content\|filename\|path]`, `prefix`, `limit` | 默认同时查正文和文件名。中文按子串，拉丁词走 bm25。见 §3 |
| `search_semantic` | `query*`, `limit`, `prefix` | 向量检索。**最终一致**，刚写完的笔记请用 `search_text` |
| `search_frontmatter` | `field*`, `value`, `contains`, `prefix`, `limit` | 按 frontmatter 字段/值；标签在 `tags` 里 |
| `tag_list` | `sources[frontmatter\|body]`, `prefix`, `contains`, `minReferences`, `limit` | `contains` 按标签名**片段**找，用于记不清全名时 |
| `tag_list_documents` | `tag*`, `sources`, `match[exact\|descendants]`, `prefix`, `limit` | 空结果会区分"标签不存在"（附相近标签）与"该范围内没有笔记" |
| `graph_get` | `prefix`, `includeDangling`, `limit` | 节点/边/死链。度数按**全库**计算，`limit` 只影响返回 |
| `graph_neighbors` | `key*`, `depth`, `prefix`, `includeDangling`, `limit` | 邻域子图 |
| `graph_find_orphans` | `prefix`, `mode[isolated\|noIncoming\|noOutgoing]`, `limit` | 孤立笔记。在全量节点上判定后再切片 |

### 2.2 链接（3）

| 工具 | 参数 | 行为 |
|---|---|---|
| `link_find_backlinks` | `key*`, `limit` | 谁链到了这篇 |
| `link_get_outgoing` | `key*` | 这篇链出去什么 |
| `link_rename_with_links` | `from*`, `to*`, `overwrite`, `updateLinks`, `dryRun` | 重命名并批量改写全库 wikilinks。**唯一会逐篇读全库的工具** —— 改链接必须先读到原文 |

### 2.3 文档（9）

| 工具 | 参数 | 行为 |
|---|---|---|
| `doc_read` | `key*`, `raw` | **直连 R2** 读原文，可选解析 frontmatter / tags / wikilinks |
| `doc_read_multiple` | `keys*` | 一次最多 20 篇 |
| `doc_write` | `key*`, `content*`, `contentType` | 创建或覆盖 |
| `doc_create` | `key*`, `content*`, `contentType` | 只创建，已存在则失败 |
| `doc_append` | `key*`, `content*`, `separator`, `createIfMissing` | 追加 |
| `doc_patch` | `key*`, `patch*`, `dryRun`, `createBackup`, `fuzzFactor` | 应用 unified diff |
| `doc_preview_diff` | `key*`, `proposedContent*`, `contextLines` | 只预览不写 |
| `doc_backup` | `key*` | 复制到 `.history/` |
| `doc_restore` | `backupKey*`, `targetKey`, `overwrite` | 从备份还原 |

### 2.4 文件 / 对象（7）

| 工具 | 参数 | 行为 |
|---|---|---|
| `file_delete` | `key*`, `permanent`, `dryRun` | 默认移到 `.trash/` |
| `file_delete_many` | `keys*`, `permanent`, `dryRun` | 同上，批量 |
| `file_move` | `from*`, `to*`, `overwrite` | 移动/重命名对象 |
| `file_upload_binary` | `key*`, `base64*`, `contentType` | 上传二进制 |
| `file_create_folder` | `path*` | 写一个 `.keep` 占位 |
| `file_public_url` | `key*` | 拼公开静态地址与 markdown 嵌入 |
| `file_create_access_token` | `prefix`, `expiresIn` | 限前缀、限时的 Bearer token |

### 2.5 Vault 运维（6）

| 工具 | 参数 | 行为 |
|---|---|---|
| `vault_stats` | — | 计数 / 大小 / 最大最小 / 目录分布，全部来自索引 |
| `vault_recent` | `limit`, `prefix` | 最近修改 |
| `vault_list_folders` | — | 顶层目录与最近活动 |
| `vault_list_documents` | `prefix`, `cursor`, `limit` | **R2 列举**，包含笔记索引不覆盖的二进制文件 |
| `vault_index_refresh` | — | 触发审计：walk R2、diff、把欠的文档排队。**索引落后的唯一修复入口** |
| `vault_embedding_probe` | `model` | 实测部署模型的真实向量宽度。建 Vectorize 索引**之前**必须跑 |

---

## 3. `search_text` 的语义（冻结）

`search_text` 更像"帮我在知识库里找东西"，而不是 `grep body`。用户记住的线索经常就是文件名 —— 日期、标题片段。

```
不传 searchIn        → content + filename   高召回默认
searchIn:["content"] → 只查正文              精确全文检索
searchIn:["filename"]→ 只查文件名/路径        导航型检索
```

### 命中信号是分级的，而且都保留

```json
{ "key": "daily/2026-06-18.md", "matched": ["name","content"], "nameQuality": "prefix", "tier": 1 }
{ "key": "notes/old-mineral.md", "matched": ["name"], "nameQuality": "substring", "tier": 3 }
{ "key": "notes/body.md", "matched": ["content"], "tier": 2 }
```

同一篇文档被两路同时命中时**只返回一条**，但两个理由都留着 —— 丢掉一个就是丢掉了"为什么可以信这条"。`matched[0]` 是主命中，排在前面，与 `tier` 一致。

分级决定了排序，而不是拍脑袋：

| 信号 | tier | 判定 |
|---|---|---|
| `name: exact` | 0 | 去掉扩展名后与查询完全相同 |
| `name: prefix` | 1 | 名字以查询开头 |
| `content` | 2 | 索引自己的排序（bm25 / phrase） |
| `name: substring` | 3 | 查询出现在名字中间 |
| `name: path` | 4 | 只在目录部分出现 |

内容夹在两类文件名信号之间：**强文件名命中（exact / prefix）上浮到全文之上，弱命中（substring / path）留在全文之下**。没有"所有 filename 都排所有 content 前面"这种硬规则。

一篇文档同时有内容命中和弱文件名命中时，按它**最强**的信号排序（弱信号不会把它拖下去，也不会把它抬上去）。

`ranking` 说明是哪一半答的：`bm25`（拉丁词）、`phrase`（中文子串）、`name`（只查文件名时）。

---

## 4. Prompts（4）

| 名称 | 参数 | 用途 |
|---|---|---|
| `prompt_note_organize` | `key*`, `style[concise\|detailed]` | 整理笔记：先给思路和风险，再用 `doc_preview_diff` 预览，用户同意后才写 |
| `prompt_weekly_report` | `startDate*`, `endDate*`, `prefix` | 日期范围周报：完成 / 进行中 / 风险 / 下周计划 |
| `prompt_meeting_to_tasks` | `key*`, `assignee` | 会议记录转任务清单、决策、待确认问题 |
| `prompt_vault_maintenance` | `prefix`, `focus[deadLinks\|orphans\|duplicates\|all]` | 维护计划。**明确禁止执行删除、移动、重命名或写入** |

每个 prompt 都把"先 diff、后写入"写进了工作流，因为这是最容易让 agent 越界的地方。

---

## 5. Resources（6）

| URI | 数据来源 |
|---|---|
| `mineral://doc/{key}` | R2（资源模板，含 key 补全） |
| `mineral://stats` | R2 列举 |
| `mineral://recent` | R2 列举 |
| `mineral://folders` | R2 列举 |
| `mineral://folder/{path}` | R2 列举 |
| `mineral://graph` | **索引**（`links` 表） |

`mineral://graph` 和标签补全曾经每篇文档读一次 R2，已改走索引 —— 一个补全列表不该在每次按键时走一遍全库。其余的列举类资源留在 R2：它们用分页 list（每 1000 个对象一次调用），不撞 subrequest 上限，而且能覆盖索引不管的二进制文件。

## 6. 非 MCP 的接口

工具之外还有三层，各自有自己的契约：

- **Vault RPC**（service binding，MCP → Vault）：`getDocument` `headDocument` `listDocuments` `putDocument` `deleteDocuments` `backupTextDocument` `moveDocument` `queryIndex` `refreshIndex` `searchSemantic` `vectorHealth` `probeStorage` `probeEmbeddingModel` `recordReportedMutation` `recordCommittedMutation`
- **Vault HTTP**（token 门禁）：`GET /internal/journal`、`GET /internal/vector-health`、`POST /internal/mutations`
- **Sync Gateway** `/v1/channels/{channel}`：`GET`（generation）、`POST /dirty`、`GET /subscribe`（WebSocket）、`POST /ticket`、`POST /mutations`（客户端上报 → 中继到 Vault 验真）
