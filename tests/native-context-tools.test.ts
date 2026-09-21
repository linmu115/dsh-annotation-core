import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { nativeContextPage, nativeContextToolDefinitions, registerNativeContextTools } from '../src/host/native-context-tools.ts'
import { NativeSurfaceController, nativeMaterialMeta } from '../src/host/native-context-surface.ts'
import { isNativeContextAgent, type NativeContextHost } from '../src/host/native-context-contract.ts'
import { UpstreamToolBudgets } from '../src/host/upstream-budget.ts'

function fixture(provider = 'deepseek') {
  const session = Session.create(SessionId('caller-session'))
  session.append('turn/start', { turn: 1 })
  const ctx = new Context()
  const agent = { ctx, id: 'different-agent-id', options: { provider }, session } as unknown as Agent
  const request = vi.fn(async (_session: string, operation: string, _input: object) => operation === 'release-plans' ? { items: [], materials: [] }
    : { ownerSessionId: 'logical-caller', objectId: 'context', revision: 3, sources: [], materials: [], operations: [] })
  const host = { protocolVersion: 1, capabilities: { nativeSurface: true, tools: true }, request } as unknown as NativeContextHost
  const controller = new NativeSurfaceController(host)
  const settle = vi.fn()
  const budgets = { reserve: vi.fn(() => ({ executionId: 'turn-budget', bytes: 4000, totalBytes: 24000, settle })) } as unknown as UpstreamToolBudgets
  const tools = nativeContextToolDefinitions(host, controller, budgets)
  const exec = { agent, signal: new AbortController().signal }
  return { ctx, agent, session, host, controller, request, budgets, settle, tools, exec }
}
describe('native context DSH tool boundaries', () => {
  it('derives scope from exec.agent.session and rejects all caller scope overrides', async () => {
    const f = fixture(), tool = f.tools.find(tool => tool.name === 'dsh_context_release')!
    await tool.execute({ operationId: 'op', expectedRevision: 3, materialIds: ['material'] }, f.exec as never)
    expect(f.request).toHaveBeenLastCalledWith('caller-session', 'release', expect.objectContaining({ executionId: expect.stringMatching(/^turn:/), operationId: 'op' }), f.exec.signal)
    for (const field of ['ownerSessionId', 'sessionId', 'runId', 'profileId', 'executionId', 'actor']) {
      await expect(tool.execute({ operationId: 'op', expectedRevision: 3, materialIds: ['material'], [field]: 'forged' }, f.exec as never)).rejects.toThrow('Unexpected context argument')
    }
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.budgets.reserve).not.toHaveBeenCalled()
  })
  it('does not execute native capabilities for managed or unknown routes', async () => {
    const f = fixture('codex')
    expect(isNativeContextAgent(f.agent)).toBe(false)
    await expect(f.tools[0]!.execute({}, f.exec as never)).rejects.toThrow('managed context release is unsupported')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('charges request index text and metadata using the existing cumulative read allowance', async () => {
    const f = fixture(), tool = f.tools.find(tool => tool.name === 'dsh_request_list')!
    f.request.mockResolvedValueOnce({ items: [{ requestId: 'r1', text: 'bounded user request' }], nextCursor: null } as never)
    const output = await tool.execute({ referenceId: 'source', requestId: 'r1' }, f.exec as never)
    expect(f.request).toHaveBeenLastCalledWith('caller-session', 'requests', { referenceId: 'source', requestId: 'r1', executionId: 'turn-budget', maxBytes: 4000, totalBytes: 24000 }, f.exec.signal)
    expect(f.settle).toHaveBeenLastCalledWith(output)
    expect(tool.output.presentationMeta?.({ referenceId: 'source' }, output as string)).toMatchObject({ nativeContext: { kind: 'requests', referenceIds: ['source'] } })
  })
  it('keeps pending release pending until the next pre-step instead of applying inside a tool body', async () => {
    const f = fixture()
    await f.tools.find(tool => tool.name === 'dsh_context_release')!.execute({ operationId: 'release-op', expectedRevision: 3, materialIds: ['m'] }, f.exec as never)
    expect(f.request.mock.calls.map(call => call[1])).toEqual(['release'])
  })
  it('charges model-visible metadata durably while keeping status outputs bounded', async () => {
    const f = fixture()
    const result = await f.tools.find(tool => tool.name === 'dsh_context_status')!.execute({}, f.exec as never)
    expect(f.request).toHaveBeenLastCalledWith('caller-session', 'status', { executionId: 'turn-budget', modelReadBytes: 4000, totalBytes: 24000 }, f.exec.signal)
    expect(Buffer.byteLength(result as string)).toBeLessThanOrEqual(4000)
  })
  it('rejects whole-source release while registration is incomplete but allows explicit known handles to free capacity', async () => {
    const f = fixture(), output = JSON.stringify({ referenceId: 'reference', items: [{ eventId: 'answer', text: 'new context', offset: 0 }] })
    f.session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('read-call'), content: [{ type: 'text', text: output }], isError: false }),
      meta: nativeMaterialMeta('read', {}, output)! }, { surfaceOp: 'append' })
    const implementation = f.request.getMockImplementation()!
    f.request.mockImplementation(async (id, operation, input) => {
      if (operation === 'materials-register') throw new Error('catalog full')
      return implementation(id, operation, input)
    })
    const tool = f.tools.find(value => value.name === 'dsh_context_release')!
    await expect(tool.execute({ operationId: 'whole-source', expectedRevision: 3, referenceId: 'reference' }, f.exec as never)).rejects.toThrow('尚未登记')
    expect(f.request.mock.calls.some(([, operation]) => operation === 'release')).toBe(false)
    await tool.execute({ operationId: 'known-material', expectedRevision: 3, materialIds: ['persisted-material'] }, f.exec as never)
    expect(f.request).toHaveBeenLastCalledWith('caller-session', 'release', expect.objectContaining({ materialIds: ['persisted-material'] }), f.exec.signal)
    expect(f.budgets.reserve).not.toHaveBeenCalled()
  })
  it.each(['ordinary', 'retained', 'incoming'] as const)('handles an unavailable optional host without bypassing material controls (%s)', async kind => {
    const f = fixture(), registered = new Set<string>()
    const scoped = new Context()
    scoped.provide('tools', { register: (tool: { name: string }) => { registered.add(tool.name); return () => registered.delete(tool.name) } } as never)
    const agent = { ...f.agent, ctx: scoped } as Agent
    f.ctx.provide('tools', { register: vi.fn() } as never)
    f.ctx.provide('sessionNativeContext' as never, f.host)
    registerNativeContextTools(f.ctx, f.budgets)
    await vi.waitFor(() => expect(f.ctx.get('sessionNativeContext' as never)).toBe(f.host))
    f.ctx.emit('agent/created', { agent })
    await vi.waitFor(() => expect(registered.size).toBe(9))
    f.request.mockRejectedValue(new Error('Adapter 已停用'))
    if (kind === 'retained') {
      const output = JSON.stringify({ referenceId: 'reference', items: [{ eventId: 'answer', text: 'must not bypass pending release', offset: 0 }] })
      f.session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId: ToolCallId('read-call'), content: [{ type: 'text', text: output }], isError: false }),
        meta: nativeMaterialMeta('read', {}, output)! }, { surfaceOp: 'append' })
    }
    const messages = kind === 'incoming' ? [createUserMessage({ source: { kind: 'dsh-annotation', schemaVersion: 1, setId: 'set',
      targetUserMessageId: 'user', count: 1, digest: 'digest' }, content: [{ type: 'text', text: 'pending injection' }] })] : []
    const enter = f.ctx.waterfall('agent/pre-step', { agent, messages, turn: 1, step: 1, signal: f.exec.signal }, async () => ({ kind: 'enter', messages }))
    if (kind === 'ordinary') await expect(enter).resolves.toEqual({ kind: 'enter', messages: [] })
    else await expect(enter).rejects.toThrow('本次请求已暂停')
    expect(registered.size).toBe(0)
    expect(f.request.mock.calls.map(([, operation]) => operation)).toEqual(['release-plans'])
  })
  it('registers only agent-scoped native tools and disposes them with the optional capability', async () => {
    const f = fixture(), globalRegister = vi.fn(), scopedDisposes: (() => void)[] = [], scopedRegister = vi.fn(() => { const dispose = vi.fn(); scopedDisposes.push(dispose); return dispose })
    f.ctx.provide('tools', { register: globalRegister } as never)
    f.ctx.provide('sessionNativeContext' as never, f.host)
    const nativeCtx = new Context(); nativeCtx.provide('tools', { register: scopedRegister } as never)
    const nativeAgent = { ...f.agent, ctx: nativeCtx } as Agent
    registerNativeContextTools(f.ctx, f.budgets)
    await vi.waitFor(() => expect(f.ctx.get('sessionNativeContext' as never)).toBe(f.host))
    f.ctx.emit('agent/created', { agent: nativeAgent })
    await vi.waitFor(() => expect(scopedRegister).toHaveBeenCalledTimes(9))
    f.ctx.emit('agent/created', { agent: { ...nativeAgent, options: { provider: 'codex' } } as Agent })
    expect(scopedRegister).toHaveBeenCalledTimes(9)
    expect(globalRegister).not.toHaveBeenCalled()
    f.ctx.emit('agent/disposed', { agent: nativeAgent })
    expect(scopedDisposes.every(dispose => vi.mocked(dispose).mock.calls.length === 1)).toBe(true)
  })
})

describe('bounded graph and context metadata projection', () => {
  it('keeps long material metadata addressable and separates historical coverage from retention', () => {
    const ids = Array.from({ length: 64 }, (_, index) => `${index}-${'x'.repeat(250)}`)
    const value = { ownerSessionId: 'session', objectId: 'object', revision: 1, coverageRevision: 'coverage-1', coverageTruncated: true,
      materials: [{ materialId: 'material', state: 'retained', pinnedByUser: true, pinnedByModel: false, referenceIds: ids, releasedReferenceIds: ids,
        ranges: ids.map(id => ({ referenceId: id, eventId: id, start: 0, end: 10 })) }],
      coverage: [{ referenceId: 'r', sourceVersionId: 'v', executionId: 'execution', eventId: 'e', ranges: [{ start: 0, end: 10 }] },
        { referenceId: 'r', sourceVersionId: 'v', executionId: 'execution', eventId: 'e2', ranges: [{ start: 0, end: 20 }] }] }
    const material = nativeContextPage(value, { section: 'materials' }, 4000)
    expect(material.items[0].materialId).toBe('material')
    expect(material.items[0].pinnedByUser).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(material))).toBeLessThanOrEqual(4000)
    const coverage = nativeContextPage(value, { section: 'coverage', limit: 1 })
    expect(coverage.meaning).toContain('independent')
    expect(coverage.coverageTruncated).toBe(true)
    expect(() => nativeContextPage({ ...value, coverageRevision: 'coverage-2' }, { section: 'coverage', cursor: coverage.nextCursor })).toThrow('Context changed')
  })
  it('paginates without loading graph bodies and binds cursors to exact context revision', () => {
    const value = { ownerSessionId: 'session', objectId: 'object', revision: 1,
      sources: Array.from({ length: 80 }, (_, index) => ({ referenceId: `r${index}`, title: 'title '.repeat(50), window: null })),
      materials: [], operations: [], graph: { revision: 4, payload: { nodes: Array.from({ length: 10000 }, (_, index) => ({ id: `n${index}`, label: 'node', text: 'body should not leak' })), edges: [] } } }
    const first = nativeContextPage(value, { limit: 5 }, 4000)
    expect(first.items).toHaveLength(5)
    expect(first.counts.nodes).toBe(10000)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(4000)
    const next = nativeContextPage(value, { limit: 5, cursor: first.nextCursor }, 4000)
    expect(next.items[0].referenceId).toBe('r5')
    expect(() => nativeContextPage({ ...value, revision: 2 }, { cursor: first.nextCursor })).toThrow('Context changed')
    const nodes = nativeContextPage(value, { section: 'nodes', limit: 5 })
    expect(JSON.stringify(nodes)).not.toContain('body should not leak')
  })
})
