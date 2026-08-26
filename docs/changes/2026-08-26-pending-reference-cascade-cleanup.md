# 0.1.2 待发送引用级联清理

## 问题

删除 DSH 输入框上方尚未发送的 Obsidian 引用时，Core 只移除了自己的 pending 项。虽然
`HostSourceAdapter.discardPending()` 已经存在，删除路径没有调用它，因此 Obsidian 的
`claimed` 记录和笔记块标记会成为孤儿。

## 修改

- 在每个会话聚合中增加 `pendingDiscardJobs` 持久清理队列；旧聚合缺少该字段时自动迁移为空队列。
- `removeReference` 和 `discardPendingOperation` 在移除 Obsidian pending 项的同一次 CAS 中写入清理任务。
- Remote 删除立即返回，不等待 Obsidian；后台 outbox 调用来源适配器，成功后删除任务，失败时保留错误并自动重试。
- Core 启动、来源适配器注册及新删除发生时都会唤醒清理队列。
- DSH 消息来源不创建外部清理任务；已经发送的不可变注释不进入该流程。

## 验证

- `pnpm check`
- 23 个测试文件、89 项测试全部通过。
- 新增覆盖：旧聚合迁移、删除原子入队、Remote 非阻塞返回、离线保留、恢复后重试、operation discard 级联。

## 回退

回退本提交会停止创建和消费新的清理任务。`pendingDiscardJobs` 是附加字段，旧代码无法识别它，
因此回退前应先让队列清空或保留 0.1.2 直到 Obsidian 恢复在线。
