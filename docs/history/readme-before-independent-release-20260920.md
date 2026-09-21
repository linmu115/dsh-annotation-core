# 历史 README：不作为当前安装教程

# dsh-annotation-core

本轮独立组件升级候选及边界见[2026-09-20 架构升级](docs/changes/2026-09-20-independent-components.md)。源码候选不代表运行副本已升级。

## 原生主会话划选

自 0.3.12-rc2.19 起，Core 独立提供主会话划选与会话内引用。扩展动作合同见 [原生划选动作](docs/native-selection-actions.md)。

为 DSH 插件提供统一注释气泡、跨会话引用、可靠发送和历史注释详情。当前源码版本 **0.3.12-rc2.12**，针对官方 **DSH 0.1.5-rc.2 / web profile**。这里的版本说明不代表已发布到 npm；使用本分支功能时请构建并安装匹配的本地包。

[English](README_EN.md) · 中文

Core 是共享基础插件，没有独立侧栏或画布。Sidechat 提供划选入口，Sticker 提供贴纸入口，ThoughtDAG 提供会话关系图，它们使用同一 Core 实例。Core 通过宿主接口接入，不依赖 EAC 或桌面壳；Maintenance/Codex 配套运行仍需核对各自要求的 RC2 宿主构件。

## 功能与使用

### 注释气泡

- 功能插件添加引用后，气泡显示在输入框上方，正文保持你输入的问题，不插入 `@`、引用块或隐藏占位符。
- 点击气泡查看选段、填写可选注解或删除引用；待发送注释删除后自动重新编号。
- 发送后，用户消息下方的“`N 条注释`”可重新打开历史详情；模型回答中的“注释 N”链接也可定位对应内容。
- 主输入框、侧边聊天和嵌入式输入框共享相同的引用状态与展示协议。
- 待发送 Obsidian 引用删除后，气泡先消失，来源记录通过后台任务清理；离线时继续重试。迟到的回链不会恢复已删除关系。

### 跨会话引用

1. 使用配套 Sidechat，选中一条**已完成 AI 回复**的文段，点击“跨会话引用”。普通注释仍支持 user 和 assistant 消息；固定上游引用只接受已完成的 assistant 回复。
2. 先选择工作区，再选择目标会话；列表支持滚动和分页加载。会话名称优先采用 DSH 会话栏的当前标题，未载入的历史会话使用 Maintenance 保存的可读名称；仅读取已有列表元数据，不逐条打开会话历史。
3. Core 打开真实目标会话，等待输入框就绪，再加入引用气泡。已有正文和附件保留，不自动发送。
4. 输入问题并发送。引用范围固定为来源会话截至那条回复**完整结束**的位置；选区用于标明重点，之后新增的轮次不会进入这条引用。

首次发送会在预算内优先带入被引用回复所在的**问题与回答**。长问答会标明未完整读取及继续位置；中间工具过程有单独的按需读取入口。AI 可自行调用 `dsh_upstream_read`、`dsh_upstream_search` 查找更早上下文，无需再次询问用户是否允许读取已经授权的来源。

不会默认复制整份上游历史、递归展开所有引用或生成逐轮上下文备份。来源版本、回复截止位置、单次页额度和本轮累计预算约束所有读取；初始材料也占用后续工具预算。详见[初始问答准备](docs/changes/2026-09-14-initial-upstream-turn.md)和[请求容量与预算](docs/changes/2026-09-14-system-audit-fixes.md)。

### 原生 Agent 管理自身图与上下文

配置并接通匹配版本的 Maintenance `annotation-context` Adapter 后，原生 DSH Agent 会获得以下会话作用域工具。工具只管理执行器当前会话，不能指定别人的 owner、profile 或 run。

| 工具 | 使用方式 |
| --- | --- |
| `dsh_graph_inspect` | 分页查看自己的主干节点、连接、来源与保留材料；用 `section` 切换目录 |
| `dsh_request_list` | 按真实用户请求索引当前会话，或指定已授权 `referenceId`；长请求用 `requestId` 和游标续读 |
| `dsh_context_status` | 查看来源状态、窗口、历史读取覆盖、保留标记及操作是否实际生效；返回有界页面和输入字节测量 |
| `dsh_context_window_set` | 在固定截止以内选择多个不连续事件区间；扩大只授权后续读取，缩小安排释放窗口外材料 |
| `dsh_context_release` | 释放已经用完的材料正文，保留连接和来源定位；不返还本轮累计读取预算 |
| `dsh_context_source_set` | 暂停／恢复来源；是否同时释放已读正文由 `release` 明确指定 |
| `dsh_context_pin` | 设置或取消模型自己的保留标记；模型不能取消用户的固定保留 |
| `dsh_graph_edit` | 添加来源或占位卡片、重命名、连接、断开和移除卡片；使用同一后端关系规则 |
| `dsh_context_discover` | 在允许工作区发现会话，或列出本会话已有笔记链接；发现元数据不等于获得正文权限 |

通常先查看状态或请求索引，再按需读取来源；材料使用结束后调用释放。`dsh_upstream_read` 可以接受索引返回的 `userRequestId`，读取仍受来源固定版本、完成回复截止、活动窗口和预算约束。模型新建的图连接具有独立操作凭据，不伪造用户发送回执。

释放工具先返回 `pending-next-step`。下一次原生模型请求前，Core 追加 DSH 原生 `surfaceOp: replace` 事件；Maintenance 核验持久日志后才记录 `applied`。混合引用包和工具结果按各个片段释放，保留其它片段、工具调用配对以及真实用户正文和 `userComment`。原始事件仍可追溯。若其它压缩已改变该材料，返回失败，不重新装回已裁剪正文。

状态和图目录分页不传整图或全文；索引和读取共用累计预算，状态与发现元数据按页额度保守计费并由 Engine 持久记录。管理写操作保留短回执，即使读额度或材料目录已满，也能释放已登记材料。未登记部分会明确报告，不冒充已追踪或已释放。历史读取覆盖通过 `section: "coverage"` 查看，与当前保留集合分开。

本阶段仅支持 **DSH 原生 Agent**。这些新增工具不导出到 Codex 托管引擎；未接通、停用或不兼容的 Adapter 不提供可用写入能力。详细实现与验收见[原生上下文管理](docs/changes/2026-09-15-native-context-tools.md)。

运行期间停用能力后，没有插件材料的普通聊天可继续，并移除本轮新增工具。若会话仍保留插件材料，或本次正要注入引用，会明确暂停请求，恢复能力后才能继续，避免绕过待释放或窗口限制。按来源释放或收缩窗口前会补登记刚进入本轮的材料；登记未完成时可用已知 `materialIds` 先释放容量，不会把空操作报成整个来源已释放。

### 可靠提交与冲突恢复

发送前重新核对后端引用版本、目标会话和输入框身份。准备期间引用发生变化时，刷新气泡并保留正文、图片和文件，提示重试，不自动再次发送。

只有执行器接受且持久化确认后，引用才进入已发送状态。响应丢失时先查原提交回执：相同消息重试不会重复发送或重复消费文件回执；修改正文或附件后的草稿使用新的提交身份，不会被旧回执误判为成功。RC2 原生图片与文件顺序、旧嵌入式 `images` 调用和旧请求摘要保持兼容。详见[发送版本冲突修复](docs/changes/2026-09-14-reference-submit-revision.md)。

预算计算包括已有会话、系统提示、工具、正文、附件和输出预留。容量不足时保留草稿；无法确认 Codex 内层用量时使用明确标记的保守准备模式，不将其称为已测得的剩余容量。

### 图谱接续、归档与撤销

从 ThoughtDAG 节点进入会话时，Core 可接续已有入向引用，复用原来源版本和截止回复，不重新捕获最新历史、不自动发送。已发送关系仍合法、但本地缺少注释记录时，恢复单独的轻量读取授权，**不伪造发送回执、用户消息或已发送快照**，也不把旧关系绑定到新的用户轮次。

来源或目标会话被 Maintenance 归档、删除，或关系被主动撤销后，引用停止继续传递上下文。Core 根据权威状态清理失效的待发送气泡及恢复授权；离线或状态未知不会被当作删除。已提交消息不会因解除关系而被重写，撤销也不能让模型忘记已收到的材料。删除恢复的引用需先得到权威确认，旧图节点不能重新激活已撤销关系。

详见[会话主干图接续与披露记录](docs/changes/2026-09-15-session-main-graph-context.md)和[合法已发送引用恢复](docs/changes/2026-09-15-graph-reference-recovery.md)。读取记录区分“准备完成”“已交付”和“失败”，不声称模型已经理解材料。

## 与其他组件的职责

| 组件 | 职责 |
|---|---|
| Annotation Core | 气泡、注解、发送事务、历史详情、目标会话内的工具读取及引用接续 |
| Sidechat | 划选浮窗、跨会话选择入口和真实侧边会话 |
| Maintenance / DSH 版本 Adapter | 会话真源、稳定身份、固定来源读取、图关系权威状态、归档撤销及披露记录 |
| Session Sticker / ThoughtDAG | 贴纸和会话节点的交互、布局与关系展示，不另存一套原生会话历史 |
| Obsidian Bridge / Reference Adapter | 笔记选区、嵌入窗口投递、笔记来源及双链同步；笔记正文由 Vault 管理 |

笔记引用投递到哪个窗口由配套 Bridge/Adapter 控制。当前配套系统只允许配置的 Obsidian 内嵌会话页面领取笔记引用，Core 不负责抢占窗口。

宿主工具服务可用时，`dsh_reference_list` / `dsh_reference_read` 读取当前会话的已提交引用、当前执行批次及合法恢复的图谱来源。`snapshot` 保持原提交内容，`refresh` 通过来源适配器读取，不改写旧输入；分支继承引用不新增回链。可选 Runtime Support 将工具接入相应 Codex 执行，不暴露任意笔记路径或模型删除能力。

## 安装与源码构建

请使用与 **DSH 0.1.5-rc.2** 配套的 Core、Maintenance 和消费插件，其他宿主版本需要独立验证。普通注释不要求整套图谱组件；固定上游与图谱接续要求 Maintenance 提供对应能力。

在源码根目录使用 [package.json](package.json) 指定的 **pnpm 11.19.0**。官方 RC2 宿主的 Node 要求以其自身声明为准：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

`build` 生成 Host、Client 和类型声明；`test`、`pack` 前均自动构建。将生成的包安装到所选实例的 `web` profile，例如：

```bash
dsh plugin --profile web add "file:/absolute/path/dsh-annotation-core-0.3.12-rc2.12.tgz"
```

随后安装匹配的 Sidechat、Sticker 或 ThoughtDAG，完整重启目标 `dsh web` 并刷新页面。Launcher/Maintenance 管理的实例应通过该实例的部署流程安装，保证版本、运行绑定和实际加载位置一致。源码构建或 GitHub 提交本身不会更新运行实例，无版本号的 registry 安装也不能保证取得此候选代码。

## 插件开发接口

运行时先协商能力，再调用 [Client API](src/public/client-api.ts) 或 [Host API](src/public/host-api.ts)。

宿主可选接口 `annotationCoreHost.referenceDirectory`（`protocolVersion: 1`）提供会话及单会话引用的分页只读目录，每页最多 50 条；摘录最多 4000 字符、评论最多 2000 字符。订阅仅在持久提交后通知会话 ID 和修订号，不导出完整存储、笔记快照或提交日志。配套 Maintenance 启用 `annotation-records` 后会补齐已有目录并持续同步，失败自动重试；只有明确删除记录会同步为删除，条目缺席不表示撤销。原生上游关系在目录中去重，恢复的图引用授权不会重复导出。详见[轻量目录与同步说明](docs/changes/2026-09-15-reference-directory-mirror.md)。

| 能力 | 入口 |
|---|---|
| `cross-session-upstream-v1` | `openCrossSessionReference` 打开共享目标选择器 |
| `graph-reference-actions-v1` | `addCrossSessionReference` 指定目标；`resolveReferenceLink` 查询单条定位元数据；`deleteReferenceLink` 解除关系 |
| `session-main-graph-v2` | `prepareGraphReferences` 接续合法固定引用，保持原版本和截止位置 |

同一次添加失败重试应保留 `operationId`。图材料可传入 `expectedSourceVersionId`，由 Maintenance 原子核对，避免预览后来源变化却悄悄引用新版本。详见[图谱操作](docs/changes/2026-09-14-thoughtdag-reference-actions.md)和[来源版本保护](docs/changes/2026-09-14-graph-material-version-guard.md)。

## 常见问题

- **安装后没有入口**：Core 单独不提供界面，请安装匹配的消费插件。Sidechat 与 Sticker 可以共享同一 Core。
- **跨会话列表不可用**：检查 Maintenance 能力、配套版本及来源/目标的归档删除状态；“不兼容”与“未启用”是不同问题。
- **发送冲突或额度不足**：草稿保留，等待状态更新后重试；需要时减少本轮材料，重复点击不能绕过校验。

完整历史见 [CHANGELOG](CHANGELOG.md)，验证范围以对应变更记录为准。单元测试通过不等于真实模型回答或整套部署已经验收。

## License

MIT
