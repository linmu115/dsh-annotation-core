# Core 引用轻量目录

本次为 Maintenance 的业务目录提供可选宿主只读能力 `annotationCoreHost.referenceDirectory`，不增加新的提交或撤销权威。版本由整组发布任务统一维护；本报告仅记录源码与合成验证，不代表已经部署。

## 接口与边界

- `protocolVersion: 1`。
- `listSessions({ after?, limit?, signal? })`：返回当前 profile 的 `{ nativeSessionId, sourceRevision }` 会话头及 `nextCursor`。
- `listEntries({ nativeSessionId, after?, limit?, signal? })`：返回同一业务目录修订下的引用页及 `nextCursor`。
- `subscribe(listener)`：可导出的业务条目变更且存储写入成功后通知 `{ nativeSessionId, sourceRevision }`；返回取消订阅函数。

每页 1–50 条。会话目录游标绑定 profile 和会话集合；引用游标绑定 profile、原生会话与业务目录修订。分页期间业务条目发生变化会拒绝旧游标，消费者应重新读取第一页。

`SessionAggregate.directoryRevision` 保存最后一次改变可导出目录的聚合修订号；原有事务 `revision` 与 `expectedRevision` 的意义保持不变。旧聚合没有此字段时回退到原聚合修订；之后第一次内部写入会保留这一目录修订，重启重放也继续使用同一修订与条目内容。提交日志、admission、回链作业和核对记录的内部更新不通知镜像、不使旧目录游标失效，也不会为未变化的历史摘录生成新镜像版本。

内部更新先比较只读的 pending、sentSets、deletedReferences 集合是否被替换；未替换时直接跳过目录摘要计算。业务集合替换时，按稳定条目顺序流式计算有界公开字段摘要，只在可见内容或状态实际变化时推进目录修订。快照、初始上下文、事务日志、回链内部状态与截断范围之外的正文不参与摘要；不新增完整聚合副本或持久摘要缓存。原有存储事务内部的聚合克隆流程保持不变。

目录保留当前 pending/committing/failed、已发送集合和明确 `deletedReferences`。删除记录无需旧正文，使用空摘录、空评论和保留下来的 `sourceType`。同一引用的明确删除状态优先于旧集合条目；没有条目不推导删除。

摘录限制为 4000 字符，评论为 2000 字符，截断时标记 `truncated`。DSH 来源仅提供原生会话、锚点及可用标题；固定上游保留真实 `locator.upstream.referenceId`，不假定它等于 Core 条目 ID。Obsidian 来源仅提供库、笔记路径及块定位。目录不复制完整聚合、不遍历或导出笔记快照、初始上下文、提交日志或事务记录。`restoredGraphReferences` 已由 `annotation-upstream` 表示，不重复导出。

订阅异常不影响已持久化的操作；写入失败不发送通知。关闭存储后订阅被清理，读取会拒绝。重启后消费者通过目录重新补齐，不需要新增持久队列或交易日志。

## 验证

`tests/reference-directory.test.ts` 的 13 项合成测试覆盖：状态、无正文 tombstone、独立上游 ID、摘录边界与无快照泄漏、50 条分页、旧修订与跨会话游标、持久提交后通知、失败写入、重新打开、profile 隔离、宿主暴露与取消，以及 journal-only、backlink-only 与核对记录更新不触发镜像、目录修订跨重启稳定、截断外改动不产生新目录修订、主动删除幂等。

目录修订修复后，目录、存储、存储读取、回链与撤销作业 5 个测试文件合计 38 项通过，Core 类型检查和 `npm run build` 通过。构建生成的 `lib` 已包含独立目录修订。配套 Maintenance 桥接另外验证逐页回执与重试。所有测试使用内存表或已有测试创建的临时目录，未操作真实业务引用。本次收尾未提交、未部署。
