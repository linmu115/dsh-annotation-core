# 统一注释协议与编号状态机

## 目的

为 DSH 消息引用与 Obsidian 笔记引用建立同一套纯 TypeScript 数据边界。该层不依赖 React、Cordis、DSH 或 Obsidian API，后续 Host、Client 与 Obsidian bridge 都以这里的 schema、hash 和生命周期规则为准。

## 修改前

- core 只有 rc.2 可行性探针，没有业务协议与领域模型。
- sidechat 与 sticker-board 仍各自维护来源数据、编号和序列化语义。
- 没有统一的引用 revision、幂等身份冲突规则或发送后编号冻结规则。
- 原有静态探针不能替代协议层的运行测试。

## 修改后

### 协议 v2

新增 `dsh-annotation-core/protocol` 导出：

- `ANNOTATION_PROTOCOL_VERSION = 2`
- DSH capture、DSH locator、Obsidian locator 与整篇 Markdown snapshot schema
- capture、claim、refresh、discard、backlink commit 与 receipt schema
- 所有 route 使用严格 Zod 对象，拒绝未知字段与未知协议版本
- occurrence 固定为从 0 开始的非负整数
- `selectedTextHash` 校验规范化选段，`documentHash` 校验完整 Markdown

已有贴纸协议 v1 没有被改名或升级；本提交只新增独立的 annotation protocol v2。

### Canonical hash 与安全序列化

- 文本先统一 CRLF/LF 并做 Unicode NFC，再计算 `sha256:<64 hex>`。
- SHA-256 为浏览器安全的同步实现，不引入 Node、React、DSH 或 Obsidian 依赖。
- canonical JSON 对对象 key 排序，拒绝循环、非有限数字和非 JSON 值。
- `<`、`>`、`&`、U+2028、U+2029 都写成 JSON Unicode escape。
- `<dsh-annotations>` 与 `<dsh-reference-documents>` 外层只能由序列化器关闭；来源文本不能提前结束标签。
- backlink commit digest 覆盖完整、规范化后的 commit envelope。

### ReferenceSet 与状态机

- `ReferenceSet` 增加单调递增的 `revision`。
- pending 引用按 DSH/Obsidian 混合进入顺序共享 `1…N`。
- 删除 pending 项后立即压紧编号。
- 每次新 mutation 使用 compare-and-swap revision；旧 revision 明确冲突。
- 生命周期为 `pending → committing → sent`；提交失败可经 `failed` 恢复为 pending。
- sent 集合不可删除或改写，编号永久冻结。
- 同一 `referenceId + canonical source` 重试直接返回原 set/item 对象，不增加 revision。
- 同一 reference ID 携带不同 canonical source 时抛出身份冲突。
- “重新添加到当前提问”必须提供新 set ID 与 reference ID，并创建新 pending 集；历史对象保持不变。
- 所有返回的集合与嵌套项都被冻结，避免调用方绕开状态机原地改写。

## 红灯记录

先加入 `tests/protocol.test.ts` 与 `tests/state-machine.test.ts`，运行：

```powershell
pnpm vitest run tests/protocol.test.ts tests/state-machine.test.ts --reporter=verbose
```

初次结果为 2 个 suite 均失败，原因是 `src/protocol/index.ts` 与 state-machine 尚不存在。随后才加入最小实现。

## 绿灯证据

```powershell
pnpm vitest run tests/protocol.test.ts tests/state-machine.test.ts --reporter=verbose
pnpm typecheck
pnpm build
node -e "import('dsh-annotation-core/protocol').then(m=>console.log(m.ANNOTATION_PROTOCOL_VERSION))"
```

结果：

- focused tests：2 files、10 tests 全部通过
- TypeScript strict typecheck：通过
- Host、Client 与 protocol 构建：通过
- package self-reference 导入：输出 `2`
- SHA-256 已用 `hello` 标准向量校验
- 标签闭合攻击、错误 hash、负 occurrence、缺少完整 Markdown 和协议版本漂移均被测试拒绝

## 后续边界

本提交不实现持久化、Remote、输入 claim、模型 envelope 注入或 UI。下一阶段由 Host store 使用这里的不可变 `ReferenceSet` 和 revision 语义；消费者不能重新建立第二套编号或序列化器。
