# Mineral

一个自托管的 Obsidian 知识库后端。笔记存在 R2 里，检索由索引回答，写入通过一个 Mutation Journal 同时驱动客户端同步和两个索引，夜间审计负责让索引追上 R2。

它由三个 Cloudflare Worker 组成：

```
Obsidian 插件 ──┐
                ├─► Sync Gateway ──► RemoteChangeHub (DO)     客户端发现"远端变了"
MCP 客户端 ─────┘        │
                         └─► Vault (service binding)          上报的 mutation 在这里验真
                                 │
                                 ├─► R2 (MINERAL)             内容的事实源
                                 └─► VaultIndex (DO, SQLite)  索引 + Journal 的事实源
                                        ├─ 笔记索引：全文 / 标签 / 链接 / frontmatter / 文件名 / 目录 / 统计
                                        └─ 向量索引：Workers AI + Vectorize 语义检索
```

## 一条规则

**R2 是内容的事实源，索引是检索的事实源，Mutation 与 Audit 保证索引最终追上 R2。**

由此得出四个不可越过的边界：

```
搜索              → 索引        （决定"有没有"）
精确读取          → R2          （决定"是什么"）
对象列举          → R2 List     （决定"有哪些"，含二进制）
写操作需要内容    → R2          （link_rename_with_links，唯一例外）
```

没有 `live` / `index` 模式选择，没有实扫回退。索引不能回答时，它明说不能，而不是偷偷退化成对 R2 的全库扫描 —— 后者在 391 篇的 vault 上就是一个名为 `Too many subrequests by single Worker invocation` 的硬失败。

## 三个 Worker

| Worker | 角色 | 绑定 |
|---|---|---|
| `mineral-vault` | 规范数据平面：R2 读写、笔记索引、向量索引、Mutation Journal、审计 | `MINERAL` (R2)、`VAULT_INDEX` (DO)、`SYNC_GATEWAY` (service)、`AI`、`VECTORIZE` |
| `mineral-sync-gateway` | 唯一客户端控制面：认证、generation、WebSocket、mutation 中转 | `REMOTE_CHANGE_HUB` (DO)、`VAULT` (service) |
| `mineral-mcp` | MCP 服务器，33 个工具 / 4 个 prompt / 6 个 resource | `VAULT` (service) |

Gateway 不持有 R2 凭据 —— 它只是个中转，**验真和 Journal 都在 Vault**。

## 快速开始

```bash
npm install
npm run typecheck      # 四个 tsconfig：三个 app + test
npm test               # 232 个测试，27 个 spec（vitest + @cloudflare/vitest-plugin）
npm run build          # 绑定静态校验 + 三个 Worker 的 dry-run 打包
```

测试跑在真实的 workerd 里，含真实的 Durable Object SQLite 和真实的 R2 模拟。只有两个平台绑定被替换 —— Miniflare 无法在本地模拟 Workers AI 和 Vectorize（都是 remote-only）—— 替换发生在测试 Worker 里（`test/worker/index.ts`），不在生产代码里。

改绑定之后要重新生成类型：

```bash
npm run cf-typegen
```

### 部署

```bash
npm run deploy:vault
npm run deploy:sync-gateway
npm run deploy:mcp
```

Secret 各自 `wrangler secret put`：Vault 需要 `MUTATION_INGRESS_TOKEN`，Gateway 需要 `SYNC_GATEWAY_TOKEN`，MCP 需要访问路径（见下）与静态文件 token 的 secret。

MCP 的**访问路径本身就是凭据**（这个路由上没有 Authorization 头）。它放在仓库根目录的 `.env` 里，形如 `MINERAL_MCP_URL=https://<host>/mcp/<secret>`，**不要**写到命令行或文档里 —— 会被 shell history、进程列表和日志记住。所有运维脚本都只从 `.env` 读它，也只打印脱敏后的 endpoint。

### 运维脚本

| 脚本 | 用途 |
|---|---|
| `node scripts/mcp-call.mjs list` \| `call <tool> '<json>'` | 调一次已部署的 MCP |
| `node scripts/dump-mcp-surface.mjs [tools\|prompts\|resources\|all]` | 把部署环境实际的接口面打成 markdown，用于和 `docs/mcp-surface.md` 对拍 |
| `node scripts/backfill-live-index.mjs` | 反复触发审计直到两个索引都不欠账 |
| `node scripts/validate-worker-bindings.mjs` | 静态检查 service binding / entrypoint / DO class（`npm run build` 会跑） |
| `node scripts/validate-sync-gateway-deployment.mjs <base> <tokenFile>` | 对已部署 Gateway 做认证与协议冒烟 |

## 仓库结构

```
apps/vault/         规范数据平面
  src/entrypoint.ts       WorkerEntrypoint：RPC 面 + /internal/* + cron
  src/durable/            VaultIndex DO：笔记索引 + Journal + pending_* + 向量状态
  src/index/              笔记索引：schema、解析、调度、审计
  src/vector/             向量索引：schema、分块、嵌入、发布、GC、状态
  src/mutation/           Journal、ingress、幂等与修复
  src/sync-publisher/     把 Journal 的事实投递给 Gateway（outbox 语义）
apps/sync-gateway/  唯一客户端控制面
apps/mcp/           MCP 服务器
packages/core/      跨 Worker 的可序列化契约（MCP ↔ Vault）
packages/sync-core/ 跨仓库协议（Gateway ↔ 插件），零依赖
test/               集成测试 + 只在测试里存在的假绑定
docs/               架构文档
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/mcp-surface.md](docs/mcp-surface.md) | MCP 接口全清单 + 查询架构 |
| [docs/indexing.md](docs/indexing.md) | 两个索引：schema、调度、发布顺序、审计、就绪状态 |
| [docs/mutation-journal.md](docs/mutation-journal.md) | Journal、ingress、两条写入路径、修复、CAS 调度 |
| [docs/sync-gateway.md](docs/sync-gateway.md) | Gateway 的职责边界、通道、generation、客户端游标 |
| [docs/sync-gateway-implementation.md](docs/sync-gateway-implementation.md) | Gateway 实现与公共面 |
| [AGENTS.md](AGENTS.md) | 给在本仓库工作的 agent 的约定与不变量 |

## 两条同步链路

**MCP 写入是 server-authoritative**：写 R2 → Journal 记事实 → 投递给 Gateway + 排队索引。写操作返回 `mutationPending`，表示字节已落地但事实还没进 Journal；调用方把同一个 `mutationId` 交回来即可补记，**永远不重写文件**。

**Obsidian 写入是 client-authoritative report**：插件自己带 R2 凭据做条件 PUT，然后把结果报给 Gateway，Gateway 中继到 Vault，**由 Vault 对着 R2 验真**。验不过就是 `refused`，不是异常 —— 调用方需要区分"重试"和"放弃"。

两条路径汇合在同一个 Journal，因此 MCP、插件和任何未来的写入方对下游完全不可区分。
