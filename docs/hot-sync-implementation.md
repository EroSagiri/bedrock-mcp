# 热同步实现（Phase Hot-A … Hot-E）

状态：已实现、已部署、已用自动化端到端验证。日期：2026-09-28。
设计文档：backend 仓库 `docs/hot-sync-design.md`（本文件描述**实现**与**验证证据**，以及尚未完成的部分）。

---

## 1. 交付了什么

```text
packages/sync-core      hot-protocol / namespace-protocol / tombstones / paths（冻结的线上协议）
apps/vault              条件 R2 checkpoint：If-Match / If-None-Match、tombstone 前提、commitId、Journal
apps/sync-gateway       LiveDocumentRoom（每 DocumentId 一个 DO）
                        NamespaceCoordinator（每知识库一个 DO）
                        /v1/channels/{channel}/hot/* 路由 + 短期会话 ticket
插件 src/hot            session（持久 outbox / 确认 / 交接）、coordinator（ownership + 冷同步栅栏）、
                        editor-binding（Yjs ↔ Obsidian editor）、store（独立的 IndexedDB）
scripts/verify-hot-sync.mjs        对已部署实例的 27 项端到端验证
插件 src/hot/deployed.integration.test.ts  插件自身热路径对已部署实例的双端验证
```

### 1.1 线上协议（sync-core）

| 模块 | 内容 |
| --- | --- |
| `hot-protocol` | `DocumentId + Epoch`、`PathBinding`、操作信封、`OperationAck`、`CheckpointReceipt`、acquire/release、cold authority lease、会话 ticket |
| `namespace-protocol` | CREATE / DELETE / RENAME 意图、phase 状态机、结果与拒绝原因 |
| `tombstones` | tombstone 命名空间与 key 派生，**插件与 Vault 共用一份实现**（这是 §12.4/§25 语义能被服务端执行的前提） |
| `paths` | 唯一一份路径规范化 + 远端前缀拼装 |

`sync-core` 升到 `0.2.0`，插件 vendored tarball 同步更新。

### 1.2 服务器侧

- **LiveDocumentRoom**：每 `DocumentId` 一个 SQLite DO。持有 `Y.Doc`、操作日志（`(clientId, clientOperationId)` 去重）、
  revision 计数、`pending_target`（**在调用 R2 之前**持久化，含该 revision 的 Markdown 与 contentHash）、
  epoch 栅栏、durable alarm。
  保存节奏：`min(now + 2s, dirtySince + 10s)`；失败退避重试（1s → 30s 上限）；冲突时停止并广播。
  receipt 永远只命名**目标 revision**：V42 在飞行中产生的 V43–V45 不会被标成 saved。
- **NamespaceCoordinator**：路径绑定、epoch、CREATE/DELETE/RENAME 的持久 phase 状态机（按 `operationId` 幂等，
  且**校验意图身份**——同一个 operationId 指向不同意图时拒绝为 `stale-intent`，这是部署测试发现并修掉的真实缺陷）、
  hot ownership、cold lease。
- **Vault**：`observeHotPath` / `checkpointHotDocument` / `deleteHotDocument` / `moveHotDocument`。
  checkpoint 先核对 contentHash，再核对物理 revision（`If-Match` / `If-None-Match: *`），
  tombstone 命中即拒绝（除非该 room 本身就是"在已删除 revision 上重建"）；
  commitId 写入对象 metadata，**响应丢失后靠观察恢复**，而不是盲重写。

  > 恢复的顺序是有意的：**先问"这个对象是不是我自己的 commit"，再判定冲突**。
  > 一次 PUT 成功但响应丢失时，调用方手里的 expected ETag 已被自己的写坏掉，若先做前提比较就会把它
  > 报成 `EXTERNAL_CONFLICT` —— 用户会在一次网络抖动之后看到一个假冲突。`move` 同理：重试时源路径
  > 已经 tombstone 了，所以必须**先**看目标是不是本 commit 写的，否则每一步源检查都会失败。
  > 这条路径由 `test/hot-durability.spec.ts` 锁死（同 commitId + 同旧期望重放 ⇒ `recovered: true`，
  > 且 Journal 里只有一个事实）。

### 1.3 插件侧

- 编辑先写持久 outbox，再发送；只有 ack 才删除 outbox 行。
- 断线/重启后 `resume()` 重发 outbox（服务端按 operationId 去重），跨 epoch 的旧行被丢弃。
- 交接：写 handoff 记录 → flush → 请求覆盖 `lastAcceptedRevision` 的 receipt → **本地字节哈希必须等于 receipt 的 contentHash**
  → release → 提交冷 baseline。任一步失败即保持 `handoff-pending` 并继续围栏冷同步。
  另一个设备仍在编辑时返回 `saved-hot-elsewhere`：本机工作已保存、baseline 已提交，但路径仍然热，栅栏不释放。
- 栅栏：三层。**计划层**（`buildSyncPlan` 的 `deferPath`）让被持有的 key 在 plan 里就是
  `noop(deferred-by-hot-ownership)`，因此删除推断/冲突根本不会被产出（同形态下不带围栏会得到
  `delete-local`，即删掉用户正在编辑的文件）；**执行边界**上 scheduler 再问一次并计 `deferred`
  （与 `blocked` 同属确定性结论，不阻塞 generation 游标，也不参与 merge-base 回填）；
  **跨设备**上每个冷 mutation 前向 Gateway 申请 `/hot/cold/acquire`：`deferred` 则跳过，
  `unreachable` 则继续（控制平面不可达不能停掉 R2 同步，由 R2 条件写 + 房间 checkpoint 的 `If-Match` 兜底）。
- rename：命中热路径时先做命名空间操作（同 DocumentId、epoch+1、旧路径 tombstone、新路径写入）；
  **成功则不登记任何冷变更**（Vault 已写新路径，再 mark 会与命名空间操作抢前提），
  **被拒绝则登记两个路径**（Obsidian 已把文件移走，那确实是需要冷侧协调的本地变更）。
- 编辑器桥：远端增量作为**一次带范围的 editor.transaction** 应用（保光标/选择/undo）；
  本地改动取"编辑器新值 vs CRDT"的最小差异；回声抑制用 **origin 标记 + 写入后文本内容比对**，不是时间窗口。
- 设置项 `hotSyncEnabled` 默认关闭：只有显式打开才改变文件权威归属。

---

## 2. 验证证据

### 2.1 本地（真实 workerd / 真实 R2 模拟）

```bash
cd bedrock-mcp && npm test          # 291 passed（含 test/hot-protocol.spec.ts、hot-session.spec.ts、
                                    #   hot-namespace.spec.ts、hot-durability.spec.ts）
cd mineral-obsidian-sync && npm test # 627 passed（另有两项对已部署服务的 E2E，见下）（含 src/hot/*.test.ts 24 项、scheduler 栅栏/authority 4 项、
                                    #   状态栏热状态 7 项、自检控制流 3 项、main 接线 6 项、planner 计划层 defer 2 项）
```

覆盖：双端收敛、重传去重、stale-epoch 拒绝、**客户端全部离线后仍完成 checkpoint**、最后客户端关闭触发最终 checkpoint、
receipt 只确认明确 revision、外部改写 → 冲突不覆盖、外部 tombstone → 不复活、create 竞争、delete、
rename（同 DocumentId、epoch+1、旧路径 effective deleted、迟到旧 epoch 操作被拒）、目标已存在 → 不覆盖、
删除后重建 → 新 DocumentId 且旧 tombstone 不遮蔽、冷 lease 拒绝/放开、operationId 意图冲突，
以及**两类"必须活下来而不是被报成功"的故障**：R2 不可用（保留 target、继续 pending、退避后自重试落地）
与**响应丢失**（同 commitId 重放被识别为自己的 commit，而不是冲突或第二次写），以及**日志压缩**
（300 条操作折进 snapshot 后 operations=0，驱逐重建后字节完整、下一条编辑落在 revision 301）。

> 测试部署现在把 `SYNC_GATEWAY` 指回本 worker 自己的 Gateway entrypoint，并把 `MINERAL_R2_ENDPOINT`
> 设成真实形状的地址：每条 mutation 都**真的**经过 journal → publisher → RemoteChangeHub
> （日志是 `mutation broadcast published … gatewayGeneration=N`），而不是永远 pending。剩下的唯一噪声：
> journal 修复重试与索引 drain 跑在 `waitUntil` 里，vitest 拆除环境时可能仍在飞行中，于是报一个
> `EnvironmentTeardownError` 的 unhandled rejection——**测试全部通过**，只是进程退出码可能为 1。
> 这不是热同步的问题：热相关的四个 spec 单独跑恒为 exit 0，全量跑也从不失败任何一个断言。

### 2.2 自动化验收（设计文档 §38）逐条对应

设计文档自己列了验收类别。逐条对照一遍，避免"看起来都测了"：

| § | 覆盖位置 | 说明 |
| --- | --- | --- |
| 38.1 Editing | `hot-session.spec.ts` | 双向收敛、并发非重叠合并、重传去重、旧 epoch 拒绝 |
| 38.2 Persistence | `hot-session.spec.ts`"客户端全部离线" | 客户端全断后 alarm 仍完成 checkpoint |
| 38.3 Debounce | `hot-schedule.spec.ts` + `hot-durability.spec.ts` | 2s/10s 两个界是**纯函数** `hotCheckpointDelayMs`（算术断言，不靠等 10 秒）；"ack 之后房间确实已排好 alarm"由 `storageStats().alarmAt` 观测 |
| 38.4 Revision correctness | `hot-session.spec.ts` | V42 的 receipt 只确认 V42，V43–45 仍 pending |
| 38.5 R2 failure | `hot-durability.spec.ts` | target durable、继续 pending、退避后自重试、不报假 saved |
| 38.6 Crash recovery | 四点分别覆盖 | before R2（outage）；after R2/before Journal（`mutation-repair.spec.ts` + `committedInPlace`）；after Journal/before receipt（丢失响应同 commitId 重放）；**after receipt/before baseline**（`coordinator.test.ts` 的 `resumeHandoff` 用例） |
| 38.7 Cold/hot mutual exclusion | `scheduler.test.ts` + `coordinator.test.ts` | 冷计划先产生、路径变热、执行前被栅栏拦下 |
| 38.8 Create | `hot-namespace.spec.ts` | 并发 create：一个赢，一个 path-state 冲突 |
| 38.9 Delete | `hot-namespace.spec.ts` | checkpoint → tombstone → epoch 退休 → 迟到旧 epoch 被拒 |
| 38.10 Rename | `hot-namespace.spec.ts` | 同 DocumentId、epoch+1、旧路径 effective deleted、目标已存在不覆盖 |
| 38.11 Recreate | `hot-namespace.spec.ts` | 新 DocumentId，旧 tombstone 不遮蔽 |
| 38.12 External mutation | `hot-namespace.spec.ts` + `hot-durability.spec.ts` | 外部改写 → 下次 checkpoint 冲突、不覆盖；外部 tombstone → 不复活 |
| 38.13 Gateway disabled | `main.test.ts`"stays entirely out of the way" | 不构造热层、不记失败，冷路径逐项不变（本地 mark 照旧） |

设备侧另有两条只有真机才能覆盖的路径，已补上**离线**测试（`transport.test.ts`、`main.test.ts` 的
socket 适配器用例）：Obsidian `requestUrl` 的 `throw:false`/超时/定时器清理，以及 WebSocket 在
**CONNECTING 阶段 `send` 会抛异常**这一平台行为——会话可能在握手完成前就产生一帧（outbox 按自己的
定时器排空），所以适配器改为把帧排队到 open，握手始终不完成则关闭连接，让 durable outbox 去重发。

### 2.3 对已部署实例

```bash
node scripts/verify-hot-sync.mjs https://sync.mineral.sighjune.com <tokenFile> <identityFile>
# 32/32 checks passed
```

包含：acquire/create/join、双端收敛、重传去重、stale-epoch、receipt 命名 revision + R2 etag 与 receipt 一致、
**无人请求时 debounce checkpoint 落地**、rename/delete/recreate 语义、冷写入被 hot ownership 拒绝、最后一个会话关闭后
ownership 释放、cold lease 重新授予、测试路径清理。

```bash
HOT_E2E_GATEWAY=... HOT_E2E_TOKEN_FILE=... HOT_E2E_IDENTITY_FILE=... \
  npx vitest run src/hot/deployed.integration.test.ts
# 2 passed：
#  ① 两个"设备"在真实服务上收敛并完成交接；第三个设备在会话期间被拒发冷写 lease、最后一个会话交接后被授予。
#  ② 冲突全链路：用插件自己的 R2 客户端**绕过房间**直写对象（真实签名请求），房间下一次 checkpoint 必须
#     拒绝覆盖（客户端拿不到 receipt），用户的 keep-local 决定打到已部署的 /hot/resolve 后 R2 最终持有
#     被决定的那一版；随后本机"磁盘 vs 编辑器"的外部修改也被标记为冲突并按同一界面解算。
```

真机侧另有一个 **Obsidian 内自检命令**（`Mineral Sync (dev): Hot Sync Self-Test`，只在开发构建里存在）：
用 Obsidian 真实的 `requestUrl`/WebSocket 与真实 `MarkdownView` 编辑器跑完
配置 → 打开 → 本地编辑回环 → 远端更新落到真编辑器 → 交接与 baseline → 插件信号接线 → 清理，
并把报告写到 `last-hot-self-test-report.txt`。它还接受**文件触发器**（`RUN-HOT-SELFTEST`），
所以锁屏的手机上也能由 `adb` 单独跑（见插件侧 `docs/hot-sync.md` §6）。协议组固定落在被同步过滤器忽略的
`.mineral-sync/selftest/<run-id>/`，wiring 组落在可同步的 `.mineral-sync-test/<run-id>/`；
设备拒绝点目录时自动退到 `private/mineral-sync-hot-selftest/<run-id>/`（该前缀也在内建排除里）。
控制流本身有 5 项 vitest（未配置 ⇒ 1 fail + 其余 skipped；网关不可达 ⇒ 逐场景失败而不是抛异常；
创建的本地文件只落在被忽略的命名空间内；无标记 ⇒ 什么都不做；有标记 ⇒ **先消费再跑**）。

验证路径固定在 `.mineral-sync/hot-verify/`（插件忽略、索引排除），结束时会 delete 收尾。

### 2.4 部署

```text
mineral-vault          cd561f41… → 420a6b88… → 6ddb8b3c…（含 hot checkpoint RPC 与丢失响应恢复顺序）
mineral-sync-gateway   d9b2d845… → acd2a3bc… → 4c0cd81c… → 443cff00… → 1a3f6429…（房间 / 协调器 / 解算 / 有界恢复 alarm / 调度策略提取）
插件 main.js 273 KB 已安装到 Windows vault（SHA-256 校验）；Android 上已装 dev 构建并放置自检触发器（等待解锁设备）
```

---

## 3. 设计条目 → 实现对照

有几处实现不是设计的逐字翻译，列在这里，免得读者去找一个不存在的数据结构。

| 设计条目 | 实现 | 说明 |
| --- | --- | --- |
| §22 `deferredRemoteFactsByPath` | 三道机制的组合 | ① per-path ownership（`hot_ownership` + session/handoff 的持久记录）保证路径在交接完成前一直让路；② plan 层给出 `noop(deferred-by-hot-ownership)`、执行层计 `deferred`，两者都不是"已应用"；③ 权威是房间的条件 checkpoint——R2 若被第三方改动，下一次 `If-Match` 必然失败并报 `EXTERNAL_CONFLICT`；④ 交接提交 baseline 后主动 `requestReconcile("hot-handoff")`。没有 per-path 游标，因为"这条 cold fact 有没有落实"由 R2 的前提检查回答，而不是由客户端记忆回答。 |
| §26/§27 冲突解算 | `POST /hot/resolve` + `HotConflictModal` | 两个决策、不传内容：`keep-local` 把房间的下次 checkpoint 前提重指到 R2 当前 revision（revision 已被删除时记为有意替换），并把文档标成**欠一次保存**，由房间自己的 alarm 落地——不需要客户端保持连接；`accept-remote` 释放所有权，文件交回冷同步按普通规则协调。路由核对 binding 的 document+epoch，过期/错认的请求返回 404，否则一个错认的解算能替别的文档放弃某个路径的所有权。决定失败时冲突保持冻结。 |
| §24 外部本地修改 | **保守版**：磁盘内容 vs **绑定编辑器缓冲区**比较（不是 vs CRDT——用户正在输入时文件短暂落后于缓冲区是正常的，拿 CRDT 比会在每次普通保存上误报）；不一致即 `flagExternalEdit` → 该路径进入 conflict 栅栏 + 通知一次。外部字节**不合并、也不静默覆盖**；diff import 属后续版本。 |
| §31 LiveDocumentRoom 回收 | 日志压缩 + 可观测 | checkpoint 成功后把 `latestCheckpointedRevision` 之前的操作折进 snapshot（阈值 256 行）；`storageStats()` 暴露 `operations / snapshotRevision / lastAccepted / lastCheckpointed`（只有计数与 revision，没有正文）。房间不会因为 `connectedClients == 0` 就被删除：绑定仍指向它的 DocumentId。 |
| §18/§19 命名空间崩溃恢复 | 协调器自带 alarm | 每个中间 phase 在**写入时**就武装一次恢复（`NAMESPACE_RESUME_MS = 5s`，最多 6 次）：客户端在 `quiescing`/`checkpointed`/`r2-applied` 之间消失时，由对象自己用**存下来的 intent** 重试并完成；次数用尽则显式失败（`resume-exhausted`）并把 quiescing 的 binding 放回 `active`——路径卡在 quiescing 是比"明确失败"更糟的结果。|
| §32 鉴权 | channel 作用域 + 会话 ticket | 所有 HTTP 路由要求 bearer；socket 只接受绑定 `channel + documentId + epoch + clientId` 的短期 ticket。**没有 per-path ACL**：本部署是一个 channel = 一个知识库 + 一个 bearer，路径级权限没有可依凭的调用者身份模型——这是部署事实，不是遗漏。 |
| §33 sync-core 分层 | `scripts/validate-sync-core-layering.mjs` | 静态检查 import specifier（`cloudflare:` / `obsidian` / `node:` / `apps/` / `@mineral/core`）、零运行时依赖、以及每个子路径都必须显式 export。跑在 `npm run build` 里，因为 vitest 侧运行在 workerd，没有文件系统可读源码。 |
| §17 冷 mutation authority | 每个 mutation 前一次 lease | `granted → 执行后 settle`；`deferred → 跳过`；`unreachable → 继续执行`（控制平面不可达不得停掉 R2 同步，由 R2 条件写 + 房间 `If-Match` 兜底）。 |
| §21 RemoteChangeHub | 未改动 | 仍然只表示"远端 durable state 可能变了"；热 checkpoint 走同一条 Mutation Journal → Hub 链路唤醒未参与会话的冷客户端。 |

---

## 4. 明确未完成 / 需要真机验证

以下**不是**"已实现但未测"，而是确实还没做或无法在当前环境验证：

1. **Windows / Android 真机行为**（**已在真机上全绿**：`Mineral Sync (dev): Hot Sync Self-Test` 在 OPPO Find X8 上 `7 passed, 0 failed`，见插件侧 docs/hot-sync.md §6；它抓出的三个真实缺陷——seed 从不发送、seed 跑在会话注册之前、先关会话再检查面板——已修复并回归）：中文 IME composition、光标、selection、undo/redo、多窗格、
   Obsidian 自动保存，以及 `file-open` / `editor-change` / `vault.rename` 在 Android WebView 上的实际触发与顺序。
   插件已在 Windows vault 装好，并且已经有 Obsidian 内的一条命令自检（见 2.2）；但
   "两端互相看见、中文输入手感" 只能由人在设备上做一次。
2. **热冲突的第三种出路**：解算界面给的是"保留本文件"与"改用另一侧"两个决策（§26/§27 要求的那两个）。
   设计里提到的"合并"（diff import）与"另存为新文件"还没有：需要合并时用户先复制内容，
   再选一侧，然后用冷冲突解算器处理具体差异。
3. **Android kill / 断网编辑** 的端到端：服务端持久化路径已用"客户端全部离线 + alarm"覆盖，
   真机断网重连尚未做。
4. 附件/图片/PDF 热协作、跨文件原子 rename、热正文进索引 —— 设计文档第 35 节明确不做。

---

## 5. 已知取舍

- **纯文本 Y.Text**：Markdown 整体作为一个 Y.Text，不做 AST merge。这是第一版的选择，
  换来的是"任何输入都不会丢"，代价是并发块级编辑的粒度。
- **未编辑过的新文档** 由客户端把编辑器内容作为首个 CRDT 操作推入；已有远端内容的文档**只接受**
  本地哈希与房间已知 revision 一致时加入，否则返回 `local-remote-mismatch` —— 保守，不合并。
- **ownership 释放** 依赖"最后一个客户端关闭 + 无待保存"；被强杀且 socket 未及时关闭时，
  coordinator 侧的 claim 有 60 秒 TTL 兜底。









