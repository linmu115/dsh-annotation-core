# 引用额度口径修复（0.3.12-rc2.24）

本版修正两处同源的额度计算缺陷：把会话请求的 **JSON 字节数**直接当作 **token** 去减模型的 token 上下文窗口。

## 症状

在中文长会话中，引用会被拒绝并报「引用上下文额度不足（额度 0 token）」，即使会话实际只用到窗口的一小部分。

## 根因

两条额度路径都在做量纲不一致的减法：

| 位置 | 原写法 | 后果 |
|---|---|---|
| `src/host/submission-budget.ts` | `window - requestBytes - reserve - 4096` | 提交引用时额度被算成 0 |
| `src/host/upstream-budget.ts` | `contextWindow - inputBytes - outputReserve - 4096` | 展开读取上游时报「本轮可用上下文额度不足」 |

`window`/`contextWindow` 的单位是 token，`requestBytes`/`inputBytes` 的单位是 UTF-8 字节。一个汉字约占 1 个 token、3 个字节，于是「会话占用」被高估约三倍。实测某中文会话：请求体 2,093,723 字节，而模型窗口为 1,000,000 token —— 字节数超过窗口，额度被 `Math.max(0, …)` 夹成 0。

## 修复

- 提交路径：优先读取宿主 `@deepseek-ai/dsh-token-meter` 的 surface 计量（与界面显示的同一口径），拿不到计量时退回估算。
- 上游路径：把请求字节数按密度换算为 token 后再参与窗口减法。
- 新增 `estimateUtf8TokensFromBytes`（`src/domain/budget.ts`），供持有字节数而非文本的调用方复用同一密度。
- Codex 原生路径不变：该路径本来就以 token 上报（`inputTokens`/`maxInputTokens`），不经过字节估算。

## 已知取舍

换算密度取 3 字节/token（本组件既有估算口径）。宿主自身的 `dsh-token-meter` 使用 4 字符/token，对中文而言更宽松。因此本修复方向正确但偏保守：不再把字节当 token，但仍不是精确分词器。上游读取另有 24,000 字节的硬上限不变。

## 验证

- 全量测试 282 项通过，类型检查与构建通过。
- 新增 `tests/upstream-budget.test.ts` 固定该口径；`tests/submission-budget.test.ts` 增加宿主计量路径与降级路径的用例。
- 既有 `tests/upstream.test.ts` 中依赖旧字节口径的断言随本修复更新。

## 未覆盖

- 未做真实中文长会话的端到端额度验收；本记录不代替用户实测。
- 未改为按实际 tokenizer 计费；如需精确定价，应由宿主提供路由无关的额度查询 API。
