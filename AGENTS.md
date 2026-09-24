# Mineral — agent notes

自托管的 Obsidian 知识库后端：三个 Cloudflare Worker、两个索引、一个 Mutation Journal。先读 [README.md](README.md) 了解全局，再读 [docs/](docs/) 里对应那一层。**不要**在没有读过 `docs/indexing.md` 的情况下改索引，它是唯一说明发布顺序与接受规则的地方。

## 不变量（改任何东西之前先看这条）

1. **R2 是内容的事实源，索引是检索的事实源。** 搜索只问索引，精确读取才问 R2。没有 `readMode`，没有实扫回退 —— 索引不能回答时要**明说**不能，不能偷偷走一遍全库。
2. **事实和它欠的索引工作必须在同一个事务里提交。** `recordMutation()` 的 `transactionSync` 里同时写 `mutation_journal`、`pending_index`、`pending_vector`。分开写就等于承认"已提交的写入可以无声地不被索引"。
3. **索引器只相信 R2。** `applyIndexIntent` / `applyVectorIntent` 重新观察对象，绝不按 intent 里的 etag 直接写。intent 里的 etag 是提示，不是指令。
4. **向量发布顺序**：chunk/取 id（事务外）→ beginAttempt → 嵌入 → Vectorize upsert → 一个事务写账本 + active。倒过来会让检索看到一半的版本。
5. **账本行是清理的唯一线索。** Vectorize 没有列举 API，没被记下来的向量永远找不回来。所以删除账本行永远是清理的**最后**一步。
6. **日志不带原始路径。** 用 `pathDigest()`；也不要把 token、正文或 URL 放进日志。
7. **密钥不进命令行、不进文档、不进 `present`/reply。** MCP 访问路径本身就是凭据，只存在于 `.env`；`wrangler secret` 只在交互式提示里输入。

## 命令

```bash
npm run typecheck          # 4 个 tsconfig（3 个 app + test），提交前必须过
npm test                   # vitest + @cloudflare/vitest-plugin，跑在真实 workerd 里
npm run build              # 绑定静态校验 + 三个 Worker dry-run 打包
npm run validate:bindings  # 只跑绑定校验（service binding / entrypoint / DO class）
npm run cf-typegen         # 改 wrangler.jsonc 的绑定之后必须重跑
npm run deploy:vault | deploy:sync-gateway | deploy:mcp
```

## 测试的边界

测试跑在真实 workerd 里：真实 DO SQLite、真实 R2 模拟。**只有两个绑定被替换** —— Miniflare 无法本地模拟 Workers AI 和 Vectorize（都是 remote-only）—— 替换发生在 `test/worker/index.ts`（导出生产的 DO / entrypoint 子类），**不在生产代码里留 seam**。加新平台绑定时照这个模式做。

`test/support.ts` 是访问 bindings / DO / entrypoint 的唯一入口，spec 不要自己 cast `env`。

## 代码风格

- 注释解释**为什么**，不解释是什么。一条约束的由来（哪次故障、哪个平台行为）比约束本身更值得写。
- 不做没有触发条件的防御。宁可在真正的边界上失败并说清楚，也不要留一个永远不会走的 fallback。
- 中文只出现在面向用户的字符串（工具描述、拒绝理由、prompt）和文档；代码与注释用英文。

## Cloudflare 平台

STOP。你的 Cloudflare Workers 知识可能过时。做任何 Workers、KV、R2、D1、Durable Objects、Queues、Vectorize、AI 或 Agents SDK 的事之前先查当前文档。

- Workers: https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`
- 限额与配额一律查各产品的 `/platform/limits/` 页面

本项目实际用到的、容易记错的几点：

- **WorkerEntrypoint 只能由运行时构造。** 测试里用 `exports.<Name>` 拿 RPC stub（见 `test/worker/index.ts` 的注释）。
- **Service binding 打 RPC 方法必须写 `entrypoint`。** 只绑默认导出会打到 fetch handler，失败形态是运行时错误而不是类型错误 —— `npm run validate:bindings` 静态守住这条。
- **`Vectorize` 是 remote-only**，本地无模拟；`AI` 同理。
- **DO 的 `transactionSync` 不能 `await`。** 需要摘要或网络 I/O 时，在事务外先做完。
- **DO SQLite 的 `rowsWritten` 不等于影响行数**：`INSERT ... SELECT ... ON CONFLICT` 会把它算成碰过的索引数。要精确计数就先 SELECT。
- **Vectorize 自身最终一致**：刚 upsert 的向量可能几十秒内检索不到。
- **错误 1102**（CPU/内存超限）与全部错误码：`/workers/platform/limits/`、`/workers/observability/errors/`。

Durable Objects 与 Workflows 的最佳实践：

- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## Node.js 兼容

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## 另一个仓库

Obsidian 插件在 `C:\Users\i\work\Projects\mineral-obsidian-sync`，通过 `packages/sync-core` 的协议与 Gateway 通信。改协议时要同步两边，并把 `packages/sync-core` 重新 `npm pack` 后 vendor 进插件。
