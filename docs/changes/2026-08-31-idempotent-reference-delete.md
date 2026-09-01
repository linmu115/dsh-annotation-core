# 0.3.5 — 已解除引用的幂等删除

- `deleteReferenceLink` 现在把“目标引用关系已经不存在”视为删除后置条件已经满足，并返回 `deleted: false`，不再抛出 `Unknown sent reference set`。
- Obsidian Bridge 的持久删除任务因此可以被 Sticker Board 正常确认并结束，不会在每次轮询和 DSH 重启后永久重试。
- 删除仍保留引用身份保护：如果同一个 `referenceId` 实际存在于另一个 `setId`，Core 会拒绝请求，避免误删其他关系。
- 幂等空操作不会改变会话聚合 revision，也不会制造 tombstone 或后台清理任务。
