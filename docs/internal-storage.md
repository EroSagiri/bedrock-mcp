# 内部存储目录

新的正式目录只有一个顶层命名空间，位于配置的 remotePrefix 下：

```text
.mineral/
  versions/<时间戳-唯一编号>/<原文件路径>
  tombstones/<路径和被删除 ETag 的摘要>.json
```

versions 同时保存修改前备份、手动备份和 MCP 删除前副本；reason 区分 backup 和 delete。
版本编号含随机 UUID，避免同毫秒保存覆盖。删除副本保存原始字节、文件类型及原始自定义元数据；
doc_restore 直接恢复字节，支持图片等二进制文件，并拒绝恢复到内部目录。目标存在时默认拒绝覆盖。

tombstones 的内容仍采用 protocol=1、path、deletedRemoteETag、createdAt。迁移记录可增加
r2AcceptedAt，保存原始 R2 接受时间；复制对象产生的新 LastModified 不得改变同内容重建的判断。
新删除记录只写入 .mineral/tombstones/，不会继续创建 .mineral-sync/。

共享常量及版本 key 规则在 packages/sync-core/src/storage.ts；MCP、Vault、插件使用同一份协议包。
索引、静态访问、资源列举、链接更新和插件普通同步排除整个 .mineral/。

## 部署与旧数据迁移

旧 .history/、.trash/ 和 .mineral-sync/tombstones/ 只作为迁移兼容输入，不是保留的正式目录。
新版可以读取旧删除记录、恢复旧备份；旧客户端不能识别新版写入的删除记录，因此切换期间
必须暂停所有写入与同步，包括热房间尚未完成的 checkpoint，先更新所有后端和插件客户端。
任何未升级设备不能继续参与写入。

插件仓库的 scripts/migrate-internal-storage.mjs 从现有插件 data.json 读取 R2 配置，凭据不放入命令行。
默认只列举并返回计数；不输出路径、凭据或签名 URL。命令在 mineral-obsidian-sync 仓库运行：

```text
node scripts/migrate-internal-storage.mjs --settings <data.json路径>
node scripts/migrate-internal-storage.mjs --settings <data.json路径> --backup <本地备份目录>
node scripts/migrate-internal-storage.mjs --settings <data.json路径> --apply
node scripts/migrate-internal-storage.mjs --settings <data.json路径> --apply --delete-source --writers-paused
```

迁移目标由旧 key 确定：history 与 trash 使用不同的 legacy-backup / legacy-delete 后缀，避免同一时间和路径碰撞。
工具按源 ETag 条件读取，按 If-None-Match:* 创建目标，再验证正文 SHA-256、文件 HTTP 元数据及自定义元数据。
已存在且内容不同的目标会终止迁移，不覆盖。删除旧对象是独立的第二阶段：全部副本验证成功，
再检查全部源和目标 ETag，最后删除旧对象。写入暂停期间重跑可以恢复中断操作。
R2 Workers DELETE 不提供本工具可依赖的条件删除，所以 --writers-paused 是实际运维前提，不能只作为形式上的标志。

复制 tombstone 时保留原始服务器时间；不得直接使用控制台普通移动替代这一步。
所有 GET/HEAD 请求使用 Accept-Encoding: identity，避免压缩响应的弱 ETag 或解压正文破坏版本校验。
--backup 可在只读模式保存原始正文、响应元数据和 SHA-256 清单；清理旧对象前先验证本地备份完整性。
迁移不会删除 tombstone 隐藏的原路径正文，也不会改动同步 baseline、设备本地回收站或自动清理策略。
确认旧前缀没有对象后，R2 页面不再显示旧目录；客户端的旧路径读取能力可在后续版本移除。

2026-10-02 已完成生产切换与迁移：Vault、MCP、Gateway 的新版均接收 100% 流量；Windows 与 Android 的插件 bundle 已更新并通过 SHA-256 校验。32 个 history 和 20 个 trash 对象合并为 52 个 versions，3 个 tombstone 保留原始 R2 接受时间后迁入新目录。55 个目标逐一核验成功，旧 .history/、.trash/、.mineral-sync/ 对象数均为 0。本地保留迁移前原始数据与客户端备份。线上 MCP 初始化、工具列举以及 Gateway 热同步健康接口均成功。

Android 已在标准插件目录实际加载新版，热同步协调器初始化成功，状态显示 Up to date；已启动 Windows 的 Mineral Vault。未用用户笔记进行额外写入或删除测试。
