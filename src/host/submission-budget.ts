import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserMessage, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import type { ReferenceBudgetOptions } from '../domain/budget.ts'

/** Count the proposed request, including provider-owned media representations, before reading a source. */
export async function submissionReferenceBudget(ctx: Context, agent: Agent, message: UserMessage,
  selection: { provider: string; model: string } | undefined, model: LlmResolvedModelInfo | undefined,
  signal?: AbortSignal): Promise<ReferenceBudgetOptions> {
  const window = model?.context?.contextWindow
  if (!selection || !window || !Number.isSafeInteger(window) || window <= 0)
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
  const request = { messages: [...agent.session.deriveMessages(), message].map(value =>
    ({ ...value, content: value.content.map(projectBlock) })),
    system: renderPrompt(assembly), context: renderContextSnapshot(assembly), tools: assembly.tools }
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
  const reserve = Math.max(4096, maxTokens ?? Math.ceil(window / 4))
  // One UTF-8 byte per text token is a conservative upper bound, not a tokenizer.
  const remaining = Math.max(0, window - Buffer.byteLength(JSON.stringify(request)) - imageTokens - reserve - 4096)
  return { contextWindow: window, maxTokens: remaining, includeEnvelope: true,
    countTokens: text => Buffer.byteLength(text) }
}
