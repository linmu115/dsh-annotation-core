# 引用额度口径收尾（0.3.12-rc2.27）

本版补齐 `src/host/submission-budget.ts` 非原生（`native === undefined`）兜底路径上剩下的两处「字节当 token」。前三处修复见 [2026-09-21-reference-budget-units.md](2026-09-21-reference-budget-units.md)。

## 症状

额度口径修复后仍能观察到引用额度偏小：同一段引用材料在装有宿主 token 计量的会话里可提交，在没有计量的会话里被拒；带图片的请求比不带图片的请求少掉远多于图片实际价格的额度。

## 根因

`submission-budget.ts` 的非原生分支上有两处仍然混用量纲：

| 位置 | 原写法 | 后果 |
|---|---|---|
| `imageTokens`（约 120 行） | `price.visualTokens + Buffer.byteLength(price.text)` | 图片句柄文本的 UTF-8 字节数被当作 token 计入。`visualTokens` 本身是 token，不在此列 |
| `requestBytes`（约 132–133 行，无 native 时是 `Buffer.byteLength(JSON.stringify(request))`） | 经 `occupiedTokens` 直接参与 token 窗口减法 | 整个请求体的字节数（含历史、系统提示、工具目录）被当作 token 扣除，中文会话高估约三倍 |

第二处只在「既无 Codex 原生额度、又取不到宿主 `tokenMeter` 计量、又没有上下文管理器计数」这三重降级路径上生效；该路径恰是当前 web profile 的默认路径。

## 修复

- 图片：`price.text` 的字节数先经 `estimateUtf8TokensFromBytes` 换算再与 `visualTokens` 相加。
- 请求体：非原生分支新增 `requestSize = estimateUtf8TokensFromBytes(requestBytes)`，只有它进入 `occupiedTokens` 的 token 窗口减法。宿主计量（`surfaceTokens`）与上下文管理器计数（`selectedRequestTokens`）两条更优先的路径不变。
- **未改动**：`native` 分支的全部行为，包括 `requestBytes` 与 `native.maxInputBytes` 的字节比字节比较；`src/domain/budget.ts` 的非负安全整数校验保持不变。
- Codex 原生路径仍以字节上报（`inputTokens`/`maxInputTokens`/`maxInputBytes`），不经过本换算。

## 已知取舍

- 换算密度仍是 3 字节/token（本组件既有估算口径）。宿主 `dsh-token-meter` 对中文更宽松；本修复方向正确但偏保守，不是精确分词器。
- 该分支仍不是真正按路由 tokenizer 计价。若宿主提供与路由无关的额度查询 API，应改为直接取用。

## 验证

- 全量 `vitest run` 50 文件 286 项通过；`tsc --noEmit` 通过。
- 新增断言：图片句柄文本按密度计价、无宿主计量时请求体按 token 扣除；两者均做过反向验证（临时还原旧实现时对应断言失败）。
- 既有的「当前输入占满窗口」用例原先按字节选择输入规模（52800 / 80000 字节），在正确的 token 口径下已不再占满 65536 token 窗口，用例规模改为 170000 / 200000 字节以继续覆盖原意图；`tests/submission-budget.test.ts` 中依赖字节基线的阈值同步改为 token 口径。

## 未覆盖

- 未做真实中文长会话的端到端额度验收；本记录不代替用户实测。
