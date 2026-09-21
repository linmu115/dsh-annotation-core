import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createSystemMessage, type GenerateOptions, type PreparedLlmCall, type UserMessage, type LlmResolvedModelInfo, type Message } from '@deepseek-ai/dsh-llm'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { estimateUtf8TokensFromBytes, type ReferenceBudgetOptions } from '../domain/budget.ts'

// Optional APIs exposed by the deployed RC2 context-aware host; older hosts
// retain the conservative uncompressed path below.
interface ManagedCall extends PreparedLlmCall {
  nativeContext?: { format: string; scope: string;
    encode(messages: Message[]): unknown[];
    count(request: GenerateOptions, input: unknown[]): Promise<number> }
}
interface ContextOwners {
  contextProvider?(agent: Agent): ((request: GenerateOptions, call: ManagedCall) => Promise<{
    messages: Message[]; adapterContext?: { format: string; scope: string; input: unknown[] }
  }>) | undefined
}

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
export function submissionBudgetScope(agent: Agent, allowContextCheckpoints = false): string {
  const events = agent.session.snapshotEvents().filter(event => !allowContextCheckpoints || !['context/operation', 'context/operation-result', 'context/checkpoint', 'context/checkpoint-commit'].includes(event.type))
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
  let history = agent.session.deriveMessages()
  let selectedRequestTokens: number | undefined
  const selector = native === undefined ? (ctx.get('agents') as ContextOwners | undefined)?.contextProvider?.(agent) : undefined
  if (selector) {
    // Use the same durable context owner as the loop. Raw archive length is
    // not the active provider context, and must not block its compaction.
    // The pending message identifies the protected boundary. The context owner
    // compacts only persisted history; this draft is neither persisted nor summarized.
    const prepared = await llm.prepareCall({ ...selection, ...(agent.options.maxTokens === undefined ? {} : { maxTokens: agent.options.maxTokens }) }, signal) as ManagedCall
    const systems = [createSystemMessage(renderPrompt(assembly), 'annotation-core-budget')]
    const request: GenerateOptions = { ...prepared.config, messages: [...systems, ...history.filter(value => value.role !== 'system'), message], tools: assembly.tools, ...(signal === undefined ? {} : { signal }) }
    const projection = await selector(request, prepared)
    history = projection.messages.filter(value => value.role !== 'system')
    if (projection.adapterContext) {
      const capability = prepared.nativeContext
      if (!capability || capability.format !== projection.adapterContext.format || capability.scope !== projection.adapterContext.scope)
        throw new Error('上下文管理器与当前模型不匹配，已保留引用草稿')
      selectedRequestTokens = await capability.count({ ...request, messages: systems },
        [...projection.adapterContext.input, ...capability.encode([...history, message])])
    } else if (prepared.nativeContext) {
      selectedRequestTokens = await prepared.nativeContext.count({ ...request, messages: systems }, prepared.nativeContext.encode([...history, message]))
    }
    if (selectedRequestTokens !== undefined && (!Number.isSafeInteger(selectedRequestTokens) || selectedRequestTokens < 0))
      throw new Error('上下文管理器返回无效额度，已保留引用草稿')
    signal?.throwIfAborted()
  }
  const messages = [...history, message].map(value =>
    ({ role: value.role, content: value.content.map(projectBlock) })) as Message[]
  const system = { system: renderPrompt(assembly), context: renderContextSnapshot(assembly), tools: assembly.tools }
  const request = { messages, ...system }
  const header = agent.session.requestHeader()
  const sameRoute = header?.config.provider === selection.provider && header.config.model === selection.model
  const maxTokens = agent.options.maxTokens ?? (sameRoute ? header?.config.maxTokens : undefined) ?? model?.defaultMaxTokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 0))
    throw new Error('当前模型的输出预留不可确认，已保留引用草稿')
  const reserve = Math.max(4096, maxTokens ?? (window ? Math.ceil(window / 4) : 8192))
  let imageTokens = 0
  if (images.length) {
    const pricing = llm.imageRequestPricing?.(selection.provider, selection.model)
    // Like the host meter, missing route pricing is not a media capability failure.
    // Reserve a neutral estimate per occurrence, without pricing base64 as text.
    const prices = pricing === undefined ? images.map(() => ({ visualTokens: 4096, text: '' })) : pricing.priceImages(images)
    if (prices.length !== images.length || prices.some(price => !Number.isSafeInteger(price.visualTokens)
      || price.visualTokens < 0 || typeof price.text !== 'string'))
      throw new Error('当前模型未提供可靠的图片额度，已保留正文、附件和引用草稿')
    const boxedBytes = prices.reduce((total, price) => total + Buffer.byteLength(price.text), 0)
    // visualTokens is already a token count; price.text is the provider-owned
    // textual representation, whose price is quoted in UTF-8 bytes. The
    // non-native route has no provider count to convert it with, so it reuses
    // the shared density. The native route compares bytes to bytes against
    // native.maxInputBytes, so it keeps the raw size.
    imageTokens = prices.reduce((total, price) => total + price.visualTokens, 0)
      + (native === undefined ? estimateUtf8TokensFromBytes(boxedBytes) : boxedBytes)
  }
  // One UTF-8 byte per text token is a conservative upper bound, not a tokenizer.
  const nativeBytes = native?.countInputBytes(messages)
  const nativeTools = (native?.toolSchemaBytes ?? 0) + (native?.systemPromptBytes ?? 0)
  if (!Number.isSafeInteger(nativeTools) || nativeTools < 0) throw new Error('Codex 工具额度无效，已保留草稿')
  const requestBytes = nativeBytes === undefined ? Buffer.byteLength(JSON.stringify(request))
    : nativeBytes + Buffer.byteLength(JSON.stringify(system)) + nativeTools
  // The same surface in the units of whoever measures it: bytes when the Codex
  // route reports them, tokens once converted for the token-denominated window.
  const requestSize = native === undefined ? estimateUtf8TokensFromBytes(requestBytes) : requestBytes
  // The context window is denominated in tokens, so the conversation's share of
  // it must be counted in tokens too. Raw JSON bytes are not tokens: for CJK a
  // UTF-8 byte is about a third of a token, so byte counting overstates the
  // conversation severalfold and can zero the reference allowance in a session
  // that still has ample room. Prefer the host's own meter, which prices the
  // current surface under the same fixed-density heuristic the UI reports.
  // Skip it on the bounded Codex route, which already reports tokens.
  const measuredSurfaceTokens = native === undefined ? (() => {
    try {
      return (ctx.get('tokenMeter' as never) as { measure?(session: unknown): { surfaceTokens?: unknown } } | undefined)
        ?.measure?.(agent.session)?.surfaceTokens
    } catch { return undefined }
  })() : undefined
  const surfaceTokens = typeof measuredSurfaceTokens === 'number'
    && Number.isSafeInteger(measuredSurfaceTokens) && measuredSurfaceTokens >= 0 ? measuredSurfaceTokens : undefined
  const occupiedTokens = native !== undefined ? requestBytes + imageTokens
    : selectedRequestTokens ?? (surfaceTokens === undefined ? requestSize + imageTokens
      : surfaceTokens + estimateUtf8TokensFromBytes(Buffer.byteLength(JSON.stringify(message))) + imageTokens)
  const remaining = Math.max(0, Math.min(
    window === undefined ? Infinity : window - (native?.inputTokens ?? 0) - (native?.outputTokens ?? 0) - occupiedTokens - reserve - 4096,
    native === undefined ? Infinity : native.maxInputBytes - requestBytes - reserve - 4096,
    native?.maxReferenceTokens ?? Infinity))
  if (!Number.isSafeInteger(remaining)) throw new Error('引用额度尚不可确认，已保留草稿')
  if (native?.basis === 'conservative') console.info('[annotation-core] initial reference budget: conservative cap', remaining)
  return { ...(window === undefined ? {} : { contextWindow: window }), maxTokens: remaining, includeEnvelope: true,
    basis: native?.basis ?? 'model-metadata',
    ...(native?.validateScope ? { validateScope: native.validateScope } : {}),
    // The allowance is token-denominated, so the estimator handed to the domain
    // layer must be too. Without a native meter there is no provider count to
    // lean on, so reuse the shared UTF-8 density (about one token per three
    // bytes) instead of pricing each CJK character as its three UTF-8 bytes.
    countTokens: text => native === undefined
      ? estimateUtf8TokensFromBytes(Buffer.byteLength(text))
      : Math.max(Buffer.byteLength(text), native.countInputBytes(messages, text) - nativeBytes!) }
}
