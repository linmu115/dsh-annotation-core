import type { Agent } from '@deepseek-ai/dsh-agent'

interface Allowance { used: number; limit: number }
export interface NativeUpstreamUsage {
  readonly executionId: string
  readonly modelContextWindow: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/** Usage belongs to the active inner execution; URLs and the outer transcript are not estimates of it. */
function nativeHeadroom(usage: NativeUpstreamUsage | undefined, maxTokens?: number): number {
  if (!usage?.executionId || !Number.isSafeInteger(usage.modelContextWindow) || usage.modelContextWindow <= 0
    || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) return 0
  const window = usage.modelContextWindow
  const outputReserve = Math.max(4096, maxTokens ?? Math.ceil(window / 4))
  return Math.max(0, Math.min(24000, Math.floor(window * 0.2), window - usage.inputTokens - usage.outputTokens - outputReserve - 4096))
}

/** One UTF-8 byte per token is deliberately conservative; this is not a tokenizer. */
export function upstreamHeadroom(contextWindow: number | undefined, request: unknown, maxTokens?: number): number {
  if (!contextWindow || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) return 0
  const inputBytes = Buffer.byteLength(JSON.stringify(request))
  const outputReserve = Math.max(4096, maxTokens ?? Math.ceil(contextWindow / 4))
  return Math.max(0, Math.min(24000, Math.floor(contextWindow * 0.2), contextWindow - inputBytes - outputReserve - 4096))
}

/** The model never chooses its execution ID or allowance. Simultaneous calls reserve before awaiting. */
export class UpstreamToolBudgets {
  private readonly turns = new Map<string, Allowance>()
  constructor(private readonly nativeUsageFor?: (sessionId: string) => NativeUpstreamUsage | undefined) {}

  reserve(agent: Agent, requested = 8000) {
    const turn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    if (!turn) throw new Error('当前会话没有正在执行的用户轮次')
    const executionId = `turn:${turn.seq}:${turn.time}`
    const key = JSON.stringify([agent.session.id, executionId])
    const header = agent.session.requestHeader()
    const context = agent.session.requestContext()
    let headroom: number
    if (context?.provider === 'codex') {
      headroom = nativeHeadroom(this.nativeUsageFor?.(agent.session.id), header?.config.maxTokens)
    } else {
      const messages = agent.session.deriveMessages()
      // Provider-owned image/audio token costs cannot be inferred from a URL or attachment ID.
      if (messages.some(message => message.content.some(block => !['text', 'tool-call', 'tool-result', 'reasoning'].includes(block.type))))
        throw new Error('当前请求包含无法估算额度的媒体内容，本轮暂不展开上游；已选段落仍可使用')
      headroom = upstreamHeadroom(context?.contextWindow, { messages, tools: header?.tools ?? [] }, header?.config.maxTokens)
    }
    // A first tool call may precede the inner runtime's usage notification. Do
    // not freeze an unknown allowance at zero for the rest of this user turn.
    if (headroom < 1024) throw new Error('本轮可用上下文额度不足或尚未确认，请依据已读取材料回答或稍后重试')
    let state = this.turns.get(key)
    if (!state) {
      if (this.turns.size >= 10000) throw new Error('引用读取轮次数达到上限')
      state = { used: 0, limit: headroom }
      this.turns.set(key, state)
    }
    state.limit = Math.min(state.limit, state.used + headroom)
    const bytes = Math.max(0, Math.min(requested, state.limit - state.used, headroom))
    if (bytes < 1024) throw new Error('本轮可用上下文额度不足，请依据已读取材料回答')
    state.used += bytes
    let settled = false
    return {
      executionId, bytes, totalBytes: state.limit,
      settle(value?: string) {
        if (settled) throw new Error('Reference read was already settled')
        settled = true
        const used = value === undefined ? 0 : Buffer.byteLength(value)
        if (used > bytes) throw new Error('上游返回超过已预留额度，已拒绝注入')
        state!.used -= bytes - used
      },
    }
  }
}
