# 统一注释输入与历史 UI 实施记录

日期：2026-08-24  
适配目标：DeepSeek Harness `0.1.1-rc.2` 官方 `web` profile

## 修改前

- Client 服务只提供引用增删改的 Remote 包装；`bindComposer()` 返回阻塞占位实现。
- 输入框上方没有统一注释轨道，sidechat 与主输入框无法共享同一发送门。
- `dsh-annotation` 持久事件没有历史节点渲染器，回答中的 `#dsh-annotation-*` 片段也不能定位详情。
- 客户端没有对 rc.2 的零长度 `CommandClaim`、会话事件投影及精确重复行抑制进行正式接线。

## 修改后

- 新增 Remote 快照源和可取消的 `waitRevision()` 长轮询；未知状态一律阻止普通降级发送，连接恢复后重新同步。
- 主输入框与窄 sidechat 共享同一个 composer binding、引用轨道、详情窗口和 Host 提交事务。
- pending 引用显示编号、来源、完整预览入口和删除按钮；删除后的编号由 Host 状态机立即顺延。
- rc.2 原生输入使用空 token、`images: true` 的 `CommandClaim`，不写入 `@`、XML、引号块、零宽字符或其他隐藏文本。
- 删除最后一条 pending 引用后，同一 claim 动态改走 `submitPlainClaim`；不会伪造成功来释放输入机。
- Host 失败和不确定结果保留正文及附件；相同请求复用提交 ID，变更请求先查询旧 admission。
- sidechat 普通发送使用 revisioned `PlainComposerPort`，较晚完成的请求不会覆盖用户刚输入的新正文。
- 新增 `dsh-annotation` conversation definition 和 keyed chat node，在用户消息后显示右对齐的“`N 条注释`”按钮。
- 仅隐藏 `conversationContextKey("input-message", contextMessageId)` 对应的精确官方重复行；延迟挂载、卸载和 HMR 时均可恢复。
- 回答链接只有在当前 session 中存在对应 set 和编号时才会打开详情；错误或伪造片段保持普通链接行为。
- 样式随 Client bundle 自注入；视觉对照 HTML 只存在于测试夹，不进入 npm 产物。

## 主要改动位置

- `src/client/composer-binding.tsx`：共享发送门、Remote 状态、失败保留和不确定 admission 处理。
- `src/client/reference-rail.tsx`：发送前引用轨道。
- `src/client/reference-dialog.tsx`：pending 可编辑详情与 sent 只读详情。
- `src/client/conversation-node.tsx`：历史“`N 条注释`”气泡。
- `src/client/answer-link.ts`：严格回答片段解析与 session 内验证。
- `src/client/service.tsx`：统一 Client 服务、来源适配器和 sent cache。
- `src/rc2/client-adapter.tsx`：官方 input dock、零长度 claim、keyed chat node 与捕获阶段链接处理。
- `src/rc2/conversation-projection.tsx`：`dsh-annotation` 历史投影及精确重复行清理。
- `tsdown.config.ts`：官方模块表外部依赖与 CSS 内联。

## 验收

- `pnpm typecheck`：通过。
- `pnpm test`：19 个测试文件、72 项测试通过。
- `pnpm build`：Host ESM 与单一 Client CJS bundle 构建通过。
- `tests/bundle-contract.test.ts`：客户端只保留 React、Cordis 和官方 client-runtime 模块表依赖；Zod 被打入包内。
- `git diff --check`：无空白错误；仅保留 Windows 换行提示。

## 尚未在本阶段执行

- 没有发布 npm、推送 GitHub或修改正式 `web` profile。
- 正式 profile 安装、consumer 插件迁移和可回退部署分别由后续实施任务完成。
