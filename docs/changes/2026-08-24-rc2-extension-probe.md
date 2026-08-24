# DSH 0.1.1-rc.2 注释扩展边界探针

## 结论

Task 1 的硬门槛全部通过。`dsh-annotation-core` 可以继续采用已经批准的方案：零长度 `CommandClaim` 保持原生输入正文不变；Host 创建普通、具有稳定 ID 的 user message；`agent/pre-step` 只按该 ID 的持久 journal 附加引用上下文；Client 使用显式 Typert mount；发送后的专用节点通过公开 conversation key 精确替换重复的通用 context 行。

没有使用或保留任何降级路径：没有 session FIFO 猜测、零宽字符、原生 `ReferenceInsert`、可见 `@`、未知 `form` 选择器或 EAC 适配。

## 范围和安全边界

- 目标运行时：`D:\AI\DeepSeek-Harness\runtime-0.1.1-rc.2`
- 开发仓库：`C:\Users\19717\OneDrive\文档\ChatGPT\dsh\dsh-annotation-core-staging`
- 分支：`codex/unified-annotation-core`
- 探针只读取官方 runtime 的发布文件。
- 动态写入只发生在 `%TEMP%\dsh-annotation-core-rc2-probe-*\profile-web`，完成后递归删除。
- 探针在执行前后校验关键 runtime 文件的 SHA-256；变化列表为空。
- 没有启动 DSH、没有安装插件，也没有读取或写入真实 `home\profiles\web`。

## 运行时版本

以下被探测的包均为 `0.1.1-rc.2`：

- `@deepseek-ai/dsh`
- `@deepseek-ai/dsh-agent`
- `@deepseek-ai/dsh-agent-loop`
- `@deepseek-ai/dsh-attachment`
- `@deepseek-ai/dsh-client-runtime`
- `@deepseek-ai/dsh-client-ui-conversation`
- `@deepseek-ai/dsh-client-ui-input-trigger`
- `@deepseek-ai/dsh-llm`
- `@deepseek-ai/dsh-storage-domain`
- `@deepseek-ai/dsh-typert-loader`
- `@deepseek-ai/dsh-typert-protocol`

## 红灯证据

先创建 `tests/rc2-projection.test.tsx`，但不创建探针实现。运行：

```powershell
pnpm vitest run tests/rc2-projection.test.tsx --pool=threads --maxWorkers=1
```

Vitest 按预期失败，错误为无法导入 `../scripts/probe-rc2-projection.mts`。Windows 沙箱不允许 Vitest 默认 forks pool 启动子进程，因此仓库的 `pnpm vitest` 脚本固定使用单个 threads worker；这只改变测试执行器，不改变被测接口。

## 实际接口和行为

### 1. 零长度命令声明

公开边界存在：

- `SessionInput.beginCommand(claim, span)`
- `CommandClaim.token`
- `CommandClaim.images`
- `CommandClaim.submit(args, actx, images)`

探针从官方 `lib/client.js` 中只读提取并在内存中执行实际 rc.2 `InputMachine`，没有把一份改写后的状态机当作替身。观察结果：

- `token: ""`、`span: { start: 0, end: 0 }` 被接受并进入 `claimed`。
- 输入正文 `Explain this reference.` 完全不变；提交参数仍为完整正文。
- `projectClipboard()` 仍返回完整正文。
- 官方 textarea 直接使用 `value: draft`，因此 DOM 值和可访问文本不会增加 `@` 或内部标记。
- command 返回 error 后恢复 `claimed`，正文保留。
- `images: true` 允许图片进入 command；官方实现只在 success 后释放图片，error 不释放。
- 公开 `SessionInput` 没有即时 release 方法。具体 `SessionInputShell.dispose()` 只属于完整 facade 生命周期，不能用于单次解除 claim。

这个限制确认了既定 latch 规则：最后一个 pending 被删除后，当前零长度 claim 只能由下一次成功的普通非空提交或页面重载自然解除。不能伪造一次 success 来清 claim，因为 rc.2 会同时切断 undo/redo。

### 2. Host 消息 ID 和 `pre-step`

公开边界存在：

- `createUserMessage()` 在消息发布前生成并冻结稳定 `MessageId`。
- `Agent.send(message, target, wakeup)` 接受已经具有 ID 的 `UserMessage`。
- `agent/pre-step` 接收从 inbox claim 出来的 `UserMessage[]`，waterfall 可以返回替换后的 `enter.messages`。

探针用真实 `createUserMessage()` 创建 user message，在发送前把该 ID 登记到临时 journal。`pre-step` 以相同 ID 命中并在原 user message 后附加 plugin context；另一个同 session 的 user message ID 不命中。因此实现应固定为：

```text
Host prepare -> createUserMessage -> journal[userMessage.id]
-> agent.send(message, "next-turn", true)
-> pre-step 按 messages 中的精确 ID 读取 journal
```

不允许按 session 当前 pending、队首或到达时间猜测。

### 3. 图片持久化准入

`@deepseek-ai/dsh-attachment` 公开 `admitEncodedImages(store, images)`。探针把规范 base64 PNG 交给真实准入函数，再由临时 profile 内的内容寻址 store 写入 ledger；返回 ref 与重新读取的 ledger 完全一致。无效 base64 会在进入 store 前被官方函数拒绝。

正式实现应在 Host 创建 user message 之前完成准入，并把返回的 durable `ImageAttachmentRef` 写入 message content；失败时不创建 journal，也不发送消息。

### 4. Typert Remote

确认的公开路径：

- Host 包必须导出 `./typert`，其中 `TYPERT.face` 为 `host`。
- `dsh-typert-loader` 读取该导出并调用 `ctx.typert.register(manifest)`。
- Client 必须显式执行 `await ctx.remote.$mount(TYPERT_REMOTE)`。
- 每个方法返回 `RemoteResult<T>`；Client 必须区分 `ok: true` 与 `ok: false`，不能把 error arm 当业务值。

`@deepseek-ai/dsh-api-remotes` 只显式 mount 它自己列出的官方贡献，不会自动 mount 第三方 core。

### 5. Storage Domain

`DomainFacility.open(spec)` 和调用方拥有的 `Domain.close()` 均存在。`close()` 会等待已排队写入、关闭 backend unit，再释放 domain name。core 应使用官方 web profile 已配置的 storage backend；不得实例化第二个 `storage-json`。

### 6. 会话投影

确认的公开路径：

- `conversationEvents.register(definition)` 注册自定义 `ConversationNodeDefinition`。
- `conversation.chat.node` slot 可以渲染专用节点。
- `conversationContextKey(kind, id)` 的 rc.2 公式为 `` `${kind.length}:${kind}${id}` ``。
- 通用 plugin context 会被 `input-message` definition 接受，key 应为 `conversationContextKey("input-message", contextMessageId)`。
- chat DOM 行公开 `data-chat-anchor-key` 和 `data-chat-flow-kind`；官方自身也通过逐行比较 `row.dataset.chatAnchorKey === key` 精确定位。

因此 core 只隐藏这个精确 key 对应的通用行，并在同一序列位置渲染注释 pill。不能用 CSS 类名、文字、未知 `form` 或宽泛的 plugin selector。

### 7. 不使用原生 ReferenceInsert

实际 rc.2 `referenceDraftText()` 固定返回 `@${label}`。探针输入 label `probe`，结果为 `@probe`。这正是用户要求去除的可见符号，因此 `ReferenceInsert` 只作为反例验证，不进入 core 实现。

### 8. 未知 context form

`contextForm()` 只识别 rc.2 的固定语义集合；未知值返回 `null` 并按 opaque context 展示。core 不会把自定义未知 `form` 当 DOM 或节点匹配依据。

## 绿灯证据

```powershell
pnpm typecheck
pnpm vitest run tests/rc2-projection.test.tsx
pnpm build
```

结果：

- TypeScript：通过
- rc.2 focused test：1 file passed
- Host ESM bundle：生成 `lib/index.js`
- Client module-loader bundle：生成 `lib/client.js`
- 临时 profile：已删除
- runtime 变化列表：空
- live web profile 写入：无

## 下一阶段约束

Task 2 以后继续以本报告为硬边界。若未来 DSH 版本改变零长度 claim、消息 ID、附件准入、Typert mount 或 conversation key 的任何一项，版本切换必须重新运行该探针；探针失败时停止部署，不自动改用可见 mention、零宽 token 或 session FIFO。
