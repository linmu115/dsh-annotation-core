import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserMessage, LlmResolvedModelInfo, Message } from '@deepseek-ai/dsh-llm'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import type { ReferenceBudgetOptions } from '../domain/budget.ts'

interface NativeBudget {
  basis: 'new-thread' | 'verified-thread' | 'conservative'
  contextWindow?: number
  inputTokens: number
  outputTokens: number
  maxReferenceTokens?: number
  maxInputBytes: number
  toolSchemaBytes?: number
  systemPromptBytes?: number
  countInputBytes(messages: readonly Message[], referenceText?: string): number
  validateScope?(): Promise<void>
}
export function submissionBudgetScope(agent: Agent): string {
  const events = agent.session.snapshotEvents()
  return JSON.stringify([agent.options, agent.session.header?.cwd, events.length, events.at(-1)])
}

/** Count the proposed request, including provider-owned media representations, before reading a source. */
export async function submissionReferenceBudget(ctx: Context, agent: Agent, message: UserMessage,
  selection: { provider: string; model: string } | undefined, model: LlmResolvedModelInfo | undefined,
  signal?: AbortSignal): Promise<ReferenceBudgetOptions> {
  let native: NativeBudget | undefined
  if (selection?.provider === 'codex') {
    const runtime = ctx.get('codexRuntime' as never) as { prepareReferenceBudget?(agent: Agent, model: string, signal: AbortSignal): Promise<NativeBudget> } | undefined
    if (typeof runtime?.prepareReferenceBudget !== 'function') throw new Error('Codex 初始引用额度能力尚未就绪，已保留草稿')
    native = await runtime.prepareReferenceBudget(agent, selection.model, signal ?? new AbortController().signal)
    if (typeof native.countInputBytes !== 'function' || !Number.isSafeInteger(native.maxInputBytes) || native.maxInputBytes < 1
      || !Number.isSafeInteger(native.inputTokens) || native.inputTokens < 0 || !Number.isSafeInteger(native.outputTokens) || native.outputTokens < 0)
      throw new Error('Codex 初始引用额度无效，已保留草稿')
  }
  const window = native?.contextWindow ?? model?.context?.contextWindow
  if (!selection || (window !== undefined && (!Number.isSafeInteger(window) || window <= 0)) || (!window && native?.basis !== 'conservative'))
    throw new Error('无法确认当前模型的上下文容量，已保留正文、附件和引用草稿')
  const prompt = ctx.get('systemPrompt')
  const llm = ctx.get('llm')
  if (!prompt || !llm) throw new Error('当前系统提示与工具额度尚不可确认，已保留引用草稿')
  const assembly = await prompt.assemble(assembleContextFor(agent, signal))
  signal?.throwIfAborted()
  const images: ImageAttachmentRef[] = []
  // Transform every nested occurrence, including tool-result attachments. Binary sizes and URLs
  // are not image prices; files contribute the exact read-on-demand handle used by this provider.
  function projectBlock(value: unknown): unknown {
    if (!value || typeof value !== 'object') throw new Error('请求内容无法计价，已保留引用草稿')
    const record = value as Record<string, unknown>
    if (record.type === 'image') {
      if (!record.attachment) throw new Error('图片缺少可计价的持久附件，已保留引用草稿')
      images.push(record.attachment as ImageAttachmentRef)
      return { type: 'image' }
    }
    if (record.type === 'file') {
      if (!record.attachment || typeof llm!.fileRequestText !== 'function')
        throw new Error('文件上下文额度尚不可确认，已保留引用草稿')
      return { type: 'text', text: llm!.fileRequestText(record.attachment as FileAttachmentRef) }
    }
    if (record.type === 'tool-result' && Array.isArray(record.content))
      return { ...record, content: record.content.map(projectBlock) }
    if (!['text', 'reasoning', 'tool-call'].includes(String(record.type)))
      throw new Error('当前请求包含无法计价的内容，已保留引用草稿')
    return record
  }
  const messages = [...agent.session.deriveMessages(), message].map(value =>
    ({ ...value, content: value.content.map(projectBlock) })) as Message[]
  const system = { system: renderPrompt(assembly), context: renderContextSnapshot(assembly), tools: assembly.tools }
  const request = { messages, ...system }
  let imageTokens = 0
  if (images.length) {
    const prices = llm.imageRequestPricing?.(selection.provider, selection.model)?.priceImages(images)
    if (prices?.length !== images.length || prices.some(price => !Number.isSafeInteger(price.visualTokens)
      || price.visualTokens < 0 || typeof price.text !== 'string'))
      throw new Error('当前模型未提供可靠的图片额度，已保留正文、附件和引用草稿')
    imageTokens = prices.reduce((total, price) => total + price.visualTokens + Buffer.byteLength(price.text), 0)
  }
  const header = agent.session.requestHeader()
  const sameRoute = header?.config.provider === selection.provider && header.config.model === selection.model
  const maxTokens = agent.options.maxTokens ?? (sameRoute ? header?.config.maxTokens : undefined) ?? model?.defaultMaxTokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 0))
    throw new Error('当前模型的输出预留不可确认，已保留引用草稿')
  const reserve = Math.max(4096, maxTokens ?? (window ? Math.ceil(window / 4) : 8192))
  // One UTF-8 byte per text token is a conservative upper bound, not a tokenizer.
  const nativeBytes = native?.countInputBytes(messages)
  const nativeTools = (native?.toolSchemaBytes ?? 0) + (native?.systemPromptBytes ?? 0)
  if (!Number.isSafeInteger(nativeTools) || nativeTools < 0) throw new Error('Codex 工具额度无效，已保留草稿')
  const requestBytes = nativeBytes === undefined ? Buffer.byteLength(JSON.stringify(request))
    : nativeBytes + Buffer.byteLength(JSON.stringify(system)) + nativeTools
  const remaining = Math.max(0, Math.min(
    window === undefined ? Infinity : window - (native?.inputTokens ?? 0) - (native?.outputTokens ?? 0) - requestBytes - imageTokens - reserve - 4096,
    native === undefined ? Infinity : native.maxInputBytes - requestBytes - reserve - 4096,
    native?.maxReferenceTokens ?? Infinity))
  if (!Number.isSafeInteger(remaining)) throw new Error('引用额度尚不可确认，已保留草稿')
  if (native?.basis === 'conservative') console.info('[annotation-core] initial reference budget: conservative cap', remaining)
  return { ...(window === undefined ? {} : { contextWindow: window }), maxTokens: remaining, includeEnvelope: true,
    basis: native?.basis ?? 'model-metadata',
    ...(native?.validateScope ? { validateScope: native.validateScope } : {}),
    countTokens: text => Math.max(Buffer.byteLength(text), native ? native.countInputBytes(messages, text) - nativeBytes! : 0) }
}
