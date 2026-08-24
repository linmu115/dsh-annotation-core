# DSH 0.1.1-rc.2 注释扩展边界探针

## 结论

Task 1 的动态硬门槛已通过。`dsh-annotation-core` 可以继续采用批准后的路径：输入端用零长度 `CommandClaim` 保持正文不变；Host 先创建具有稳定 ID 的普通 user message，再按该 ID 建立 journal；`agent/pre-step` 只对精确命中的消息附加引用上下文；Client 显式挂载 Typert contribution；发送后由自定义 conversation node 渲染注释气泡，并通过公开 conversation key 精确隐藏同一 context message 的官方通用行。

未采用 session FIFO、零宽字符、原生 `ReferenceInsert`、可见 `@`、未知 `form` 选择器、EAC 或外壳专用逻辑。plain pass-through latch 仍按计划留到 Task 4，本阶段只验证所需 rc.2 边界，不提前实现业务功能。

## 范围与安全边界

- 目标运行时：`D:\AI\DeepSeek-Harness\runtime-0.1.1-rc.2`
- 开发仓库：`C:\Users\19717\OneDrive\文档\ChatGPT\dsh\dsh-annotation-core-staging`
- 分支：`codex/unified-annotation-core`
- 动态持久化只写入 `%TEMP%\dsh-annotation-core-rc2-dynamic-*`，结束后删除。
- 官方 browser bundle 只从磁盘读取，并在内存中的真实 module-loader factory 内执行。为取得未公开的诊断对象，探针只在内存字符串中增加测试导出；没有改写 runtime 文件。
- 探针会读取真实 `home\profiles\web` 以建立只读安全指纹，但不会启动 DSH、安装插件或写入该 profile。
- 安全指纹覆盖整棵树的路径、符号链接、文件大小、mtime 与 mode；对 package/lock/config/cordis 清单以及 `lib/index.js`、`lib/client.js` 额外计算内容 SHA-256。执行前后变化列表均为空。

## 红灯证据

最早的 `tests/rc2-projection.test.tsx` 只证明发布包中存在候选符号，不能证明这些边界可以组合运行，因此不再把源码字符串扫描当作硬门槛。

提交 `46f42d5 test: require dynamic rc2 seam evidence` 先加入 `tests/rc2-dynamic-integration.test.tsx`，但故意不提供 `scripts/probe-rc2-dynamic.mts`。失败记录保存在：

```text
docs/changes/evidence/2026-08-24-rc2-dynamic-red.txt
```

红灯错误为无法导入动态探针。后续绿灯由真实 rc.2 对象和临时数据路径提供，不由旧的静态扫描伪造。

## 动态验证结果

### 1. 官方输入机与零长度 claim

探针执行官方 `dsh-client-ui-conversation` bundle 中实际的 `SessionInputShell` 和 `projectClipboard()`：

- `token: ""` 与零长度 span 被 `beginCommand()` 接受。
- draft、DOM textarea 值、复制文本和可访问文本均保持原正文，不增加 `@` 或内部标记。
- command 收到真实序列化图片；submit 返回 error 后，正文和图片 ID 仍保留，图片没有被错误 release。
- IME composition 前后没有注入隐藏字符。
- 对照调用原生 `insertReference()` 会生成以 `@probe` 开头的可见文本，证明它不适合承载 core 注释身份。

rc.2 没有用于单次 claim 的公开即时 release API。因此最后一个 pending 被删除后的 plain pass-through latch 必须在 Task 4 按批准规则实现，不能用伪 success 清理状态。

### 2. 真实 AgentLoop、消息 ID 与 pre-step

探针构造实际的 `AgentRegistry`、`SessionStore`、`SystemPrompt`、`LlmRuntime`、`ToolRuntime`、`AgentLoop` 和 Agent：

- `createUserMessage()` 先生成稳定消息 ID。
- 该 ID 进入临时 journal 后，消息经真实 `agent.send()` 与 inbox claim 到达 `agent/pre-step`。
- waterfall 只为命中的 ID 附加 context；同 session 的另一个消息不会误命中。
- 下游 listener 返回 `reject` 时，core listener 保留 reject，不把它覆盖成 enter。
- `next-turn` 与 `wakeup: true` 由真实 AgentLoop 消费，最终恢复 idle。

正式实现因此固定使用：

```text
Host prepare -> createUserMessage -> journal[userMessage.id]
-> agent.send(message, "next-turn", true)
-> pre-step 按 messages 中的精确 ID 查 journal
```

### 3. Storage Domain 与附件准入

探针在临时 profile 中启动官方 JSON backend，仅用于验证 rc.2 持久化边界：

- domain 写入、close、重新 open 后仍能读取同一记录。
- `admitEncodedImages()` 接收规范 PNG，写入真实 `LocalAttachmentStore`，返回 durable ref，并可重新读取内容。
- 畸形 base64 在写入前被拒绝，附件树没有增加文件。

正式 core 只调用真实 web profile 已配置的 storage backend，不会在 live profile 再实例化一套 `storage-json`。

### 4. Typert Host/Client 往返

探针动态创建一个带 `./typert` 导出的临时包，并运行实际的：

- `dsh-typert-loader`
- `TypertRegistry`
- `TypertRemoteService`
- `TypertGatewayService`
- 官方 `dsh-api-gateway` client bundle

Host descriptor 被 loader 注册；Client 显式执行 `$mount()` 后得到 `remote.probe.echo()`；请求经真实 gateway 调用 Host service，Client 正确解包 `RemoteResult`，结果为 `echo:round-trip`。这验证了第三方 core 必须自行 mount，不能依赖官方 remotes 包自动挂载。

### 5. 官方 conversation 投影与精确行恢复

探针从官方 conversation bundle 中以内存诊断导出取得实际 `messageDefinition`，并与临时 core definition 一起注册到真实：

- `ConversationEventRegistry`
- `ConversationViewRegistry`
- `ConversationNodeAssembler`

同一 plugin context event 同时生成官方 `input-message` node 与 core `dsh-annotation` node，两者保留相同 `anchorSeq`。官方通用行 key 与 `conversationContextKey("input-message", contextMessageId)` 完全一致。DOM 验证只隐藏该精确 `data-chat-anchor-key` 行，不影响同 kind 的无关行；dispose 后原 display 值被恢复。

静态发现探针同时确认：未知 context `form` 会按 opaque context 处理，因此正式实现不会把自定义 form 当 selector。

## 绿灯证据

执行：

```powershell
pnpm typecheck
pnpm vitest run tests/rc2-projection.test.tsx tests/rc2-dynamic-integration.test.tsx --reporter=verbose
pnpm build
```

结果：

- TypeScript：通过
- focused tests：2 files、6 tests 全部通过
- Host ESM 与 Client module-loader bundle：构建通过
- runtime 安全指纹变化：空
- live web 安全指纹变化：空
- 临时根目录残留：空

## 后续约束

Task 2 以后继续以动态探针为 rc.2 硬边界。未来切换 DSH 版本时必须重跑；任何关键边界失败都应停止部署并更新设计，不能自动降级到可见 mention、零宽 token、session FIFO 或外壳补丁。
