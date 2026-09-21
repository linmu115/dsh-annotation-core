import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { submissionReferenceBudget } from '../src/host/submission-budget.ts'
import { estimateUtf8Tokens, estimateUtf8TokensFromBytes } from '../src/domain/budget.ts'

function fixture() {
  const ctx = new Context()
  const priceImages = vi.fn((images: readonly unknown[]) => images.map(() => ({ visualTokens: 12000, text: 'image handle' })))
  const fileRequestText = vi.fn(() => 'f'.repeat(10000))
  ctx.provide('llm', { imageRequestPricing: () => ({ priceImages }), fileRequestText } as never)
  const assembly = { sections: [] as unknown[], contexts: [] as unknown[], tools: [] as unknown[], variables: {} }
  const assemble = vi.fn(async () => assembly)
  ctx.provide('systemPrompt', { assemble } as never)
  const history: unknown[] = []
  const options = { maxTokens: 8192 }
  const agent = { options, session: { deriveMessages: () => history, requestHeader: () => undefined } } as unknown as Agent
  const model = { context: { contextWindow: 65536 }, defaultMaxTokens: 8192 } as LlmResolvedModelInfo
  const selection = { provider: 'test', model: 'model' }
  const user = (text = 'question', extra: unknown[] = []) => createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text }, ...extra] } as never)
  const budget = (message = user()) => submissionReferenceBudget(ctx, agent, message, selection, model)
  return { ctx, agent, model, selection, assembly, assemble, history, options, user, budget, priceImages, fileRequestText }
}

describe('initial reference allowance', () => {
  it('does not price persisted replay metadata as model-visible text', async () => {
    const f = fixture(); const message: any = f.user('old message')
    f.history.push(message)
    const before = (await f.budget()).maxTokens
    f.history[0] = { ...message, source: { ...message.source, replayState: { encrypted_content: 'x'.repeat(1000000) } } }
    expect((await f.budget()).maxTokens).toBe(before)
  })

  it('uses durable selected context and native checkpoint pricing before admitting references', async () => {
    const f = fixture(); f.history.push(f.user('old history '.repeat(100000)))
    const count = vi.fn(async (_request: unknown, _input: unknown[]) => 9000)
    const encode = vi.fn((messages: unknown[]) => messages)
    const prepareCall = vi.fn(async () => ({ config: { provider: 'test', model: 'model', maxTokens: 8192 },
      nativeContext: { format: 'native', scope: 'route', count, encode } }))
    Object.assign(f.ctx.get('llm')!, { prepareCall })
    const selector = vi.fn(async () => ({ messages: [f.user('retained')], adapterContext: { format: 'native', scope: 'route', input: [{ checkpoint: 'opaque' }] } }))
    f.ctx.provide('agents', { contextProvider: () => selector } as never)
    const budget = await f.budget()
    expect(selector).toHaveBeenCalledOnce()
    expect(budget.maxTokens).toBe(65536 - 9000 - 8192 - 4096)
    expect(count.mock.calls[0]?.[1]?.[0]).toEqual({ checkpoint: 'opaque' })
    expect(JSON.stringify(encode.mock.calls)).not.toContain('old history')
  })
  it('does not bypass failed context selection or invalid native counts', async () => {
    const f = fixture()
    Object.assign(f.ctx.get('llm')!, { prepareCall: async () => ({ config: f.selection, nativeContext: {
      format: 'native', scope: 'route', count: async () => NaN, encode: (messages: unknown[]) => messages } }) })
    f.ctx.provide('agents', { contextProvider: () => async () => ({ messages: [] }) } as never)
    await expect(f.budget()).rejects.toThrow('无效额度')
    Object.assign(f.ctx.get('agents')!, { contextProvider: () => async () => { throw new Error('compression failed') } })
    await expect(f.budget()).rejects.toThrow('compression failed')
  })

  it('uses a neutral image estimate when the routed adapter does not declare pricing', async () => {
    const f = fixture()
    vi.spyOn(f.ctx.get('llm')!, 'imageRequestPricing').mockReturnValue(undefined)
    const baseline = (await f.budget()).maxTokens!
    const image = { type: 'image', attachment: { attachmentId: 'old-image', width: 1200, height: 1200, bytes: 100, mediaType: 'image/png' } }
    const original = f.user('old question', [image])
    f.history.push(original)
    const before = JSON.stringify(f.history)
    const budget = await f.budget(f.user('new reference', [image]))
    expect(budget.maxTokens).toBeGreaterThan(0)
    expect(budget.maxTokens).toBeLessThan(baseline - 8192)
    expect(JSON.stringify(f.history)).toBe(before)
    expect(f.priceImages).not.toHaveBeenCalled()
  })
  it('prices the provider-owned image handle text at the token density, not by its bytes', async () => {
    const f = fixture()
    // The fixture quotes 12000 visual tokens plus the UTF-8 text 'image handle'
    // (12 bytes) per occurrence. visualTokens is already a token count; the
    // handle text must be converted, never added to a token window as bytes.
    expect(Buffer.byteLength('image handle')).toBe(12)
    const image = { type: 'image', attachment: { attachmentId: 'image', bytes: 3, mediaType: 'image/png' } }
    const noImage = (await f.budget()).maxTokens!
    const withImage = (await f.budget(f.user('question', [image]))).maxTokens!
    const text = 'image handle'
    expect(f.priceImages).toHaveBeenCalledOnce()
    expect(f.priceImages.mock.calls[0]?.[0]).toHaveLength(1)
    expect(estimateUtf8Tokens(text)).toBe(4)
    expect(estimateUtf8Tokens(text)).not.toBe(Buffer.byteLength(text))
    // The delta mixes three token-space terms: the 12000 visual tokens, the
    // converted 12 handle bytes, and the 17 bytes the extra projected image block
    // adds to the request JSON (5 tokens). Charging the handle bytes as 12 tokens
    // would over-subtract by 8 here (and by 3x for CJK handle text).
    expect(noImage - withImage).toBe(12000 + estimateUtf8Tokens(text) + 5)
    expect(noImage - withImage).toBeLessThan(12000 + Buffer.byteLength(text) + 8)
  })
  it('uses native inner usage and provider payload accounting instead of outer transcript size', async()=>{
    const f=fixture()
    f.history.push(f.user('outer transcript already consumed '.repeat(10000)))
    const countInputBytes=vi.fn((_messages:unknown,_text?:string)=>500+(_text?.length??0)*2)
    f.ctx.provide('codexRuntime' as never,{prepareReferenceBudget:async()=>({basis:'verified-thread',contextWindow:200000,
      inputTokens:180000,outputTokens:1000,maxInputBytes:262144,countInputBytes})})
    const budget=await submissionReferenceBudget(f.ctx,f.agent,f.user(),{provider:'codex',model:'model'},undefined)
    expect(budget.basis).toBe('verified-thread')
    expect(budget.maxTokens).toBeGreaterThan(0)
    expect(budget.maxTokens).toBeLessThan(10000)
    expect(budget.countTokens?.('"'.repeat(100))).toBe(200)
  })
  it('allows a bounded conservative initial reference without inventing a Codex model window',async()=>{
    const f=fixture(), diagnostic=vi.spyOn(console,'info').mockImplementation(()=>undefined)
    try {
      f.ctx.provide('codexRuntime' as never,{prepareReferenceBudget:async()=>({basis:'conservative',inputTokens:0,outputTokens:0,
        maxReferenceTokens:8192,maxInputBytes:262144,countInputBytes:(_messages:unknown,text='')=>1000+Buffer.byteLength(JSON.stringify(JSON.stringify(text)))})})
      const budget=await submissionReferenceBudget(f.ctx,f.agent,f.user(),{provider:'codex',model:'model'},undefined)
      expect(budget.contextWindow).toBeUndefined()
      expect(budget.basis).toBe('conservative')
      expect(budget.maxTokens).toBe(8192)
      expect(diagnostic).toHaveBeenCalled()
    } finally {diagnostic.mockRestore()}
  })
  it('retains no initial allowance when the native provider input byte limit is already exhausted',async()=>{
    const f=fixture()
    f.ctx.provide('codexRuntime' as never,{prepareReferenceBudget:async()=>({basis:'new-thread',contextWindow:200000,inputTokens:0,outputTokens:0,
      maxInputBytes:10000,countInputBytes:()=>9000})})
    expect((await submissionReferenceBudget(f.ctx,f.agent,f.user(),{provider:'codex',model:'model'},undefined)).maxTokens).toBe(0)
  })
  it('charges native system and managed tool catalogues even without a verified model capacity',async()=>{
    const f=fixture(),log=vi.spyOn(console,'info').mockImplementation(()=>undefined)
    try{
      f.ctx.provide('codexRuntime' as never,{prepareReferenceBudget:async()=>({basis:'conservative',inputTokens:0,outputTokens:0,
        maxReferenceTokens:8192,maxInputBytes:20000,toolSchemaBytes:10000,systemPromptBytes:1000,countInputBytes:()=>1000})})
      expect((await submissionReferenceBudget(f.ctx,f.agent,f.user(),{provider:'codex',model:'model'},undefined)).maxTokens).toBe(0)
    }finally{log.mockRestore()}
  })
  it.each(['history', 'system', 'tools', 'input', 'output'] as const)('subtracts the actual %s before assigning reference space', async field => {
    const f = fixture()
    const baseline = (await f.budget()).maxTokens!
    let message = f.user()
    const large = 'x'.repeat(30000)
    if (field === 'history') f.history.push(f.user(large))
    if (field === 'system') f.assembly.sections.push({ name: 'test', text: large })
    if (field === 'tools') f.assembly.tools.push({ name: 'large-tool', description: large })
    if (field === 'input') message = f.user(large)
    if (field === 'output') f.options.maxTokens += 30000
    const allowance = await f.budget(message)
    // 30000 bytes of extra material is about 10000 tokens at the shared density,
    // so the guard is token-denominated; byte counting would have taken 30000.
    expect(allowance.maxTokens).toBeLessThanOrEqual(baseline - 9000)
    expect(allowance.includeEnvelope).toBe(true)
    // '字' is three UTF-8 bytes but one token at the shared density. This used to
    // assert 3, which pinned the byte-as-token pricing this fix removes.
    expect(allowance.countTokens?.('字')).toBe(estimateUtf8Tokens('字'))
    expect(allowance.countTokens?.('字')).not.toBe(Buffer.byteLength('字'))
    expect(f.assemble).toHaveBeenLastCalledWith({ agent: f.agent, scope: f.agent })
  })
  it('prices each image occurrence including nested tool results, and uses exact file handle text', async () => {
    const f = fixture()
    const baseline = (await f.budget()).maxTokens!
    const image = { type: 'image', attachment: { attachmentId: 'image', width: 1200, height: 1200, bytes: 3, mediaType: 'image/png' } }
    f.history.push({ role: 'tool', content: [{ type: 'tool-result', content: [image] }] })
    const withImages = await f.budget(f.user('question', [image]))
    expect(withImages.maxTokens).toBeLessThan(baseline - 24000)
    expect(f.priceImages.mock.calls[0]?.[0]).toHaveLength(2)
    f.history.length = 0
    const file = { attachmentId: 'file', name: 'sample.pdf', bytes: 1000000 }
    const withFile = await f.budget(f.user('question', [{ type: 'file', attachment: file }]))
    expect(f.fileRequestText).toHaveBeenCalledWith(file)
    // The exact handle text is 10000 bytes, about 3334 tokens at the shared density.
    expect(withFile.maxTokens).toBeLessThan(baseline - 3000)
    expect(withFile.maxTokens).toBeGreaterThan(0)
  })
  it('reads the host token meter instead of raw bytes before assigning reference space', async () => {
    const f = fixture()
    const measure = vi.fn(() => ({ surfaceTokens: 50000 }))
    f.ctx.provide('tokenMeter' as never, { measure } as never)
    const metered = (await f.budget()).maxTokens!
    expect(measure).toHaveBeenCalledOnce()
    // The pending message is priced on top of the measured surface at the same
    // density the domain estimator uses, so a byte count is never subtracted
    // from the token window.
    const pendingMessageTokens = estimateUtf8TokensFromBytes(Buffer.byteLength(JSON.stringify(f.user())))
    expect(metered).toBe(65536 - 50000 - pendingMessageTokens - 8192 - 4096)
    expect(metered).toBeGreaterThan(0)
  })
  it('subtracts the JSON surface in tokens when the host token meter is absent', async () => {
    const f = fixture()
    // Without the meter there is no measured surface, so the request JSON is the
    // only usable measure of what the conversation already occupies. Its bytes
    // must be converted before they are subtracted from the token window.
    let serializedBytes: number | undefined
    const actualByteLength = Buffer.byteLength as (value: string | Uint8Array) => number
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockImplementation(((value: string | Uint8Array) => {
      const actual = actualByteLength(value)
      if (typeof value === 'string' && value.startsWith('{') && value.includes('"messages"') && value.length > 100)
        serializedBytes = actual
      return actual
    }) as never)
    let absent: number
    try { absent = (await f.budget()).maxTokens! } finally { byteLength.mockRestore() }
    expect(serializedBytes).toBeDefined()
    f.ctx.provide('tokenMeter' as never, { measure: () => ({ surfaceTokens: 1000 }) } as never)
    const metered = (await f.budget()).maxTokens!
    const pendingMessageTokens = estimateUtf8TokensFromBytes(Buffer.byteLength(JSON.stringify(f.user())))
    expect(metered).toBe(65536 - 1000 - pendingMessageTokens - 8192 - 4096)
    // The pending message JSON is longer than its canonical 'question' text, so
    // the converted request cost is a strict, non-trivial reduction: charging
    // the raw byte count as tokens would over-subtract at least threefold.
    expect(absent).toBe(65536 - estimateUtf8TokensFromBytes(serializedBytes!) - 8192 - 4096)
    expect(absent).toBeGreaterThan(metered)
    expect(estimateUtf8TokensFromBytes(serializedBytes!)).toBeLessThan(serializedBytes! - 1)
  })
  it('prices a non-native reference at the domain estimator density instead of raw UTF-8 bytes', async () => {
    const f = fixture()
    // The deployed web profile installs no codexRuntime service, so this is the
    // default DSH path: the estimator handed to the domain layer must agree with
    // the shared UTF-8 density rather than charge one token per byte.
    expect(f.ctx.get('codexRuntime' as never)).toBeUndefined()
    const text = '引用上下文'.repeat(10)
    const bytes = Buffer.byteLength(text)
    const budget = await f.budget()
    const tokens = budget.countTokens?.(text)
    expect(bytes).toBe(150)
    expect(tokens).toBe(estimateUtf8Tokens(text))
    expect(tokens).toBe(Math.ceil(bytes / 3))
    expect(tokens).not.toBe(bytes)
    // The domain layer rejects anything but a non-negative safe integer.
    expect(Number.isSafeInteger(tokens) && (tokens ?? -1) >= 0).toBe(true)
  })
  it('falls back to byte accounting when the host token meter is absent or fails', async () => {
    const absent = fixture()
    const baseline = (await absent.budget()).maxTokens!
    const throwing = fixture()
    throwing.ctx.provide('tokenMeter' as never, { measure: () => { throw new Error('meter unavailable') } } as never)
    expect((await throwing.budget()).maxTokens).toBe(baseline)
    const malformed = fixture()
    malformed.ctx.provide('tokenMeter' as never, { measure: () => ({ surfaceTokens: Number.NaN }) } as never)
    expect((await malformed.budget()).maxTokens).toBe(baseline)
    const empty = fixture()
    empty.ctx.provide('tokenMeter' as never, { measure: () => ({}) } as never)
    expect((await empty.budget()).maxTokens).toBe(baseline)
  })
  it('does not invent capacity, media costs, or unused space in an already full request', async () => {
    const f = fixture()
    await expect(submissionReferenceBudget(f.ctx, f.agent, f.user(), f.selection, undefined)).rejects.toThrow('容量')
    // 200000 bytes is about 67000 tokens, which alone exceeds the 65536-token
    // window, so the conversation has consumed all of it. A message that only
    // looked full under byte counting (65536 bytes is about 22000 tokens) must
    // still be admitted now.
    expect((await f.budget(f.user('x'.repeat(200000)))).maxTokens).toBe(0)
    expect((await f.budget(f.user('x'.repeat(65536)))).maxTokens).toBeGreaterThan(0)
    f.priceImages.mockReturnValueOnce([])
    await expect(f.budget(f.user('question', [{ type: 'image', attachment: { attachmentId: 'tiny-id' } }]))).rejects.toThrow('图片额度')
    await expect(f.budget(f.user('question', [{ type: 'audio', url: 'short' }]))).rejects.toThrow('无法计价')
  })
})
