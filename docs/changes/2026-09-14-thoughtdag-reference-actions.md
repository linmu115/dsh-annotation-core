# ThoughtDAG 会话关系操作接口

为已适配 DSH 0.1.5-rc.2 的本地 ThoughtDAG 分支提供统一的跨会话引用入口。此次不改版本号、不调整插件组合锁定、不部署运行中的副本。

## 公共 Client API

调用前检查 `annotationCore.features.includes('graph-reference-actions-v1')`。图谱插件负责展示关系，不直接创建 Annotation 数据、拼接模型输入或读取来源会话全文。

```ts
const link = await annotationCore.addCrossSessionReference(targetSessionId, capture, {
  operationId: stableGraphOperationId,
})
// link: { setId: string; referenceId: string; created: boolean }

const summary = await annotationCore.resolveReferenceLink(targetSessionId, referenceId)
// summary: { setId, referenceId, state } | null
// state: 'pending' | 'committing' | 'failed' | 'sent' | 'deleted'

if (summary && summary.state !== 'deleted') {
  await annotationCore.deleteReferenceLink(targetSessionId, summary.setId, summary.referenceId)
}
```

`capture` 使用现有 `DshMessageCapture`，只接受另一个会话中的 AI 回复。Host 与 Maintenance 继续校验该回复已完成，并固定来源版本及回复结束位置。选中文本标明关注点；初次模型输入优先提供该问答轮次，更多上游由既有工具有界读取。

`addCrossSessionReference` 刷新会话列表、打开真实目标会话、等待原生输入框挂载，再复用 Host `captureUpstream` 和现有 `addReference`。不会修改正文、附件或触发发送。等待来源捕获或草稿读取时若页面切换，提交前检查会拒绝添加，并保留可重试的选区。

图谱应为一次操作保存稳定的 `operationId`，失败重试使用同一个 ID。客户端只合并进行中的重复调用，不缓存全文或完成结果；同一进行中的操作不能更换来源。后续重试由 Maintenance 捕获与 Annotation 持久回执维持同一引用，已提交但回执丢失的重试返回 `created: false`。相同操作不能用于恢复已经删除的关系，恢复/重新引用必须使用新的操作 ID。

原有浮窗入口 `openCrossSessionReference` 继续选择工作区和目标会话，选中目标后复用这个公共添加流程。图端直接指定目标时无需再弹一次选择器。

`resolveReferenceLink` 是当前 Agent 范围内的单条定位查询，返回引用集合 ID、引用 ID 和状态，未知或其它会话中的引用返回 `null`。它不返回选中文本、笔记快照、初始问答或整套历史列表。已删除关系返回删除标记，便于重试和清理图中的失效链接。Host 直接检查既有聚合中的引用身份，不克隆正文。

删除沿用既有 pending/sent 状态机和后台来源清理，不从图端绕过 Maintenance。补齐了此前遗漏的 `deleteReferenceLink` Typert 描述注册，使公共删除方法实际可跨 Host/Client 调用。新增定位查询同样通过 Agent 授权，校验单条引用 ID 长度并限制返回字段。

## 验证

- 全部 32 个测试文件、151 个测试通过。
- TypeScript 类型检查及正式 Host/Client 构建通过。
- 聚焦覆盖：真实目标导航、输入框挂载等待、进行中操作合并、来源冲突、持久写入后丢失回执的重试、捕获及草稿读取期间切页拒绝、不自动发送。
- 通过实际 Typert Gateway 验证关系定位、删除、幂等删除、错误 Agent 拒绝和超长 ID 拒绝。
- 通过带有正文读取陷阱的 Store fixture 验证定位仅返回 metadata；保留初始问答、固定上游和工具预算的全部既有测试。
