# 0.3.0 — 双向引用删除

- 增加 `sent-reference-delete-v1`，待发送与已发送引用统一通过 Core 删除。
- 已发送引用删除采用持久 tombstone 与可重试 outbox；Core 先原子解除关系，再通知来源插件清理。
- 保留剩余引用的原编号，不改写已经写入会话日志的历史提问或上下文事件。
- DSH 注释详情现在提供“删除双向引用”，删除后会热更新注释浮窗和会话中的注释入口。
- 协议 v2 增加 `reference-delete-request` 与 `reference-delete-commit`，供 Obsidian Bridge 双端同步使用。
