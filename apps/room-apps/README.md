# 知识库工作台

同一注册框架还提供 `games.ui.md`：[纸上游乐场](src/games/README.md)，包含表格扫雷、密码破译和分支地牢冒险。

唯一初始入口为 `workbench.ui.md`。在启用 Mineral 热同步的 Obsidian 知识库中创建笔记时输入 `workbench.ui`（Obsidian 自动补 `.md`），打开后服务器生成工作台。`search.ui.md` 不再注册。

## 使用与功能

界面位于 `src/workbench/view.tsx`，使用 TextUI React + React Router：主页 `/`、结果 `/results`、管理 `/manage`、收藏 `/saved`。

- 编辑“关键词”“目录”“模式”的方括号，勾选“搜索”。目录留空为全部，`daily` 和 `daily/` 均限定该目录。
- 模式：全文、向量、文件名；快捷入口还支持最近笔记、孤立笔记和失效链接。向量模式可输入自然语言描述，并展示片段相关度。
- 每页 5 项。全文、文件名和管理检查保留本次前 200 项，向量检索保留前 50 个相关片段。翻页使用同一查询的结果集，不重复嵌入；这不是无界全库分页。
- 管理页检查全文/向量服务、已索引笔记及待更新数量。“刷新状态”为只读；“触发索引审计与刷新”调用既有 Vault 审计流程，不直接写索引行。
- 每个工作台共享最近 10 次查询和最多 50 篇收藏。点击历史条目会重新执行查询。笔记链接直接在 Obsidian 打开笔记。

失效链接以全库索引解析目标，再按当前目录筛选来源，避免把跨目录链接误当作失效链接。管理检查均读服务器索引；不修改或删除笔记。语义结果依旧经过生产向量账本的版本接受规则，不增加 R2 扫描回退。

## 文件名与生命周期

`roomApps.register({ name, run })` 注册初始文件名。已初始化工作台的附带行为按 DocumentId 持久绑定，因此可以通过正常 Obsidian 改名为其他 `*.ui.md`（例如 `我的工作台.ui.md`），继续工作。改成普通 `.md` 后停止；未注册且未绑定的 `.ui.md` 保持普通文件行为。不同文件是独立工作台。

只在 active 且有客户端的房间运行。离开、quiesce、删除、冲突和 epoch 切换立即撤销旧运行标识。后台结果不得在失效实例写入。仅修改文件正文不会删除工作台；删除文件本身仍走正常命名空间删除流程。

## 自恢复与同步边界

工作台是服务器生成的投影，允许替换原文，应使用专用文件。正文内保留恢复 Block，房间还独立持久保存工作台状态；客户端清空全部正文、删除控件或损坏恢复记录时，从房间状态恢复查询、收藏、历史和界面。没有状态时生成主页。文件改名及 DO 休眠后绑定与状态继续保留。

注册或已绑定的工作台允许接入损坏/旧的本地副本，welcome 采用服务器状态。此例外不放宽普通笔记的内容冲突规则、R2 条件写、冷写入租约或 tombstone 围栏。初始化不等待索引 RPC，以免 Android 的首个 WebSocket 升级被索引延迟阻塞；查询时再检查服务是否可用。插件对 `.ui.md` 断线重连遇到短暂 unavailable 时保留 outbox、继续退避重试；真正的冲突仍停止。

`HotScreenPort` 使用房间正文和 `epoch:revision` 条件提交。所有输出复用 Yjs 日志、广播、Mutation Journal 和 checkpoint；没有第二个文件写入通道，没有新增热同步协议。React Root 按需创建和释放。`.ui.md` 正文仍进 R2，但不进入全文或向量索引。

## 依赖导入

`vendor/` 是 Git 忽略的生成目录。CLI `scripts/vendor-textui.mjs` 在 Gateway 构建、开发、部署及根目录 typecheck/test 前导入已构建的 TextUI Core/React。来源优先级：显式目录参数 → 非空 `MINERAL_TEXTUI_PATH` 环境变量 → 仓库根目录相邻的 `../mineral-textui`。

首次安装执行 `npm run import:textui`，会生成归档并安装依赖；来源必须已有 Core/React 的 `dist/index.js` 和类型声明。兼容 CLI 命令 `npm run vendor:textui`。使用 `npm ci` 时先 `npm run import:textui -- --pack-only`，来源须匹配 lockfile integrity。

```powershell
$env:MINERAL_TEXTUI_PATH = 'C:\path\to\mineral-textui'
npm run build
```

## 验证与基线

改造前源码基线：`C:\Users\i\work\Baselines\workbench-20261005`；首次 Search App 的完整基线仍在 `search-room-app-20261004`。

本地：`npx vitest run test/room-app.spec.ts test/room-app-hot.spec.ts`；完整检查：`npm run typecheck`、`npm test -- --run`、`npm run build`。向量 workerd 测试仅替换平台 AI/Vectorize，保留真实 DO、SQLite、R2 和生产 RPC。

部署验证：`node scripts/verify-workbench.mjs <插件 data.json 路径>`；凭据只从文件读取，验证文件仅在 `.mineral/hot-verify/` 下，结束删除。真实设备确认与本地模拟测试分别记录。

### 2026-10-05 交付证据

- Backend typecheck、完整测试（37 文件，324 项）及三个 Worker dry-run 构建通过；插件完整测试 835 项通过、3 项跳过，构建通过。
- Gateway 已部署版本 `6e44244c-ec45-4eb9-b5da-5f9e28525047`。Windows 插件已安装并重新加载，`main.js` SHA-256 为 `CD15D4E0CD9288391F22042083D8EA2E7C9633C82F42DCF969E8AE66742AA603`。
- 生产验证脚本正常退出：真实全文索引返回 9 条结果，真实 Workers AI / Vectorize 返回 50 个相关片段；双客户端同步、翻页、收藏、正文清空恢复、管理页索引状态、Vault checkpoint、离开重进均通过，验证文件已删除。
- Windows Obsidian 已打开 `workbench.ui.md`，实际提交向量查询并收到 50 个片段；清空全部正文后界面、查询与结果自动恢复，编辑器、Y.Doc 和磁盘内容一致。文件名改动通过实际 Obsidian rename 完成。
- Android 未连接设备，未进行本次实体设备安装或验证。短暂 unavailable 重试覆盖由插件测试证明；正文恢复与改名绑定覆盖由 workerd 和生产房间验证证明。
