import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { submissionReferenceBudget } from '../src/host/submission-budget.ts'

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
    expect(allowance.maxTokens).toBeLessThanOrEqual(baseline - 29000)
    expect(allowance.includeEnvelope).toBe(true)
    expect(allowance.countTokens?.('字')).toBe(3)
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
    expect(withFile.maxTokens).toBeLessThan(baseline - 9000)
    expect(withFile.maxTokens).toBeGreaterThan(0)
  })
  it('does not invent capacity, media costs, or unused space in an already full request', async () => {
    const f = fixture()
    await expect(submissionReferenceBudget(f.ctx, f.agent, f.user(), f.selection, undefined)).rejects.toThrow('容量')
    expect((await f.budget(f.user('x'.repeat(65536)))).maxTokens).toBe(0)
    f.priceImages.mockReturnValueOnce([])
    await expect(f.budget(f.user('question', [{ type: 'image', attachment: { attachmentId: 'tiny-id' } }]))).rejects.toThrow('图片额度')
    await expect(f.budget(f.user('question', [{ type: 'audio', url: 'short' }]))).rejects.toThrow('无法计价')
  })
})
