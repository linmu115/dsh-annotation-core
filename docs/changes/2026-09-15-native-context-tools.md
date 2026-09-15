# 原生 Agent 主干图与上下文工具

本次实现补充规格 W21/W22。此报告描述源码与合成验收；安装副本和联合 Engine/Adapter 交付由匹配版本发布记录确认。

## 工具与授权

新增九个工具：`dsh_graph_inspect`、`dsh_request_list`、`dsh_context_status`、`dsh_context_window_set`、`dsh_context_release`、`dsh_context_source_set`、`dsh_context_pin`、`dsh_graph_edit`、`dsh_context_discover`。使用 DSH `defineTool` 与执行 Agent 的 `agent.ctx.tools.register()`，由正常工具策略、参数校验、结果呈现、取消与卸载机制管理；写工具保持串行。

Core 从 `exec.agent.session.id` 和当前原生 `turn/start` 派生执行身份。模型参数不接受 owner、session、run、profile、actor 或 execution ID。Maintenance Host 绑定已接入的 run；用户 UI 方法和模型方法分别绑定操作方。新能力仅在匹配、ready 的 `annotation-context` Adapter 下注册，运行中每次 Host 操作再次核对启用和兼容状态。

新工具不调用或导出到 `managedTools.exportTool`，Codex 托管路由明确拒绝执行。原有上游工具的旧托管桥接不表示支持新释放功能。

## 材料与真实输入视图

材料登记只来自可信 `dsh-annotation` 原生事件（核验摘要）或工具自己的 `presentationMeta.nativeContext`。用户粘贴相同标签或 JSON 不会成为可释放材料。

- 初始包：引用选段、每个问题／回答片段以及共享笔记正文分别拥有句柄。
- 上游 read/search 和请求目录：每个返回条目独立拥有句柄；不连续窗口缩小时不会丢掉同一结果包里仍需保留的条目。
- UI 引用 ID 只参与稳定句柄键；有 `locator.upstream` 时，材料归属及范围使用权威引用 ID。共享文档的持有者同样映射和去重。
- 上游沿用其已有 UTF-16 offset；请求目录使用 Unicode 码点 `textOffset`，各自不混用。

在 `agent/pre-step` 串行边界，先执行已持久的待释放操作，再登记新增材料。原生追加替代通过 `surfaceOp: replace` 与 `sourceEventSeqs` 定位旧事件，保留原始历史。工具替代只改变 `content`，不改 DSH 强制保留的调用身份、结果配对或 meta。初始替代保留用户正文和 `userComment`，只精简指定来源片段。

工具正文中的 `nativeContextRelease` 或初始替代的 `dsh-native-context-release` 来源保存操作身份、原始事件号和已释放句柄。Host 先 flush 到 Maintenance，再提交应用回执。失败的网络／持久化回执不冒充成功；冷启动可以核对已存在替代并补回执，避免重复替代。其它压缩更改了不受本协议证明的 surface 时明确失败，禁止从原始全文恢复已裁剪内容。

## 容量与恢复

Engine 只接收句柄、摘要、范围、计数与回执，不新增整份输入备份。状态、主干和目录按 section 有界分页；游标绑定上下文／图修订。输入占用报告是原生消息序列化 UTF-8 字节测量，不冒充 tokenizer 精确用量。

请求索引、状态和发现使用现有累计读取额度。状态／发现按保留的页面额度保守计入 Engine 持久预算，冷重启不会返还；释放只减少后续输入，不能退回读取额度。历史 coverage 单独分页，不能与当前保留混淆。材料目录满时，新登记返回 `registration-pending` 和未登记数量；已有释放优先执行，管理写工具不被预登记或读额度阻塞。

分批登记中途失败后，即使同一事件已有部分材料被释放，其余保留片段仍可按原始事件身份继续登记。冷启动同样仅重建未释放片段的登记信息，不重新注入正文，也不把已释放句柄重新登记。

消费材料的管理工具先补登记本轮新进入的初始引用或工具结果，不要求模型先调用状态工具。登记失败时，按来源释放、收缩窗口或断开整条关系会明确提示登记未完成；已知 `materialIds` 的释放仍可用于腾出容量。登记改变修订号时保留原有版本冲突保护，模型根据返回的当前修订重新核对并重试。

运行中 Host 因停用或不可用而无法核对待执行操作时，只有无保留插件材料、无待注入引用的普通聊天可以继续，并卸载这些工具。有材料的请求明确暂停，不能通过停用能力绕过待释放或窗口限制。取消信号、实际替代错误和回执失败保持原有失败语义。

## 合成验收

测试使用真正 DSH `Session` 和 `AgentLoop`，模型路由为本地脚本适配器，没有调用外部模型。覆盖：

1. 实际工具目录可见性、会话作用域、托管路由拒绝和卸载。
2. 正式 `agent.inject`／`followup` 首次启动路径生成受保护的 system head；脚本化 Agent 先查状态取得句柄，再调用释放得到待生效；下一 `agent/pre-step` 改变 surface；下一次实际 `GenerateOptions.messages` 不含选中的来源正文，仍含其它片段与真实用户请求。
3. 工具配对和原始日志完整；混合引用、共享文档、不连续片段和请求目录分别释放。
4. 替代已追加但回执失败时，冷重建后不重复替代而补交回执。
5. 未知外部压缩不复活正文；取消、修订游标、范围坐标和 UI／权威引用 ID 差异有对应回归。
6. 大结果包首批登记成功、后续登记失败时，先释放已登记片段再恢复剩余登记；冷重启跳过已释放片段，保留其它正文不变。
7. 正式首次输入后，模型直接按来源释放而未先查状态，下一真实请求仍移除对应材料；Host 停用时，无材料聊天继续，保留材料和待注入引用两种路径暂停。

同时维护的 Host 测试确认 ready gate、当前 run/actor 绑定、先 flush 后回执、用户预览隔离和服务失败传播。
