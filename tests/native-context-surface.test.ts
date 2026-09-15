import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { NativeSurfaceController, nativeMaterialMeta } from '../src/host/native-context-surface.ts'
import type { NativeContextHost, NativeMaterial, NativeReleasePlan } from '../src/host/native-context-contract.ts'
import { canonicalJson, canonicalSha256 } from '../src/protocol/index.ts'

const signal = () => new AbortController().signal
function fixture() {
  const session = Session.create(SessionId('native-surface-test'))
  const materials = new Map<string, NativeMaterial>(), plans: NativeReleasePlan[] = [], receipts: any[] = []
  const request = vi.fn(async (_sessionId: string, operation: string, input: any) => {
    if (operation === 'materials-register') { for (const item of input.materials) materials.set(item.materialId, item); return { recorded: true } }
    if (operation === 'release-plans') return { items: plans, materials: [...materials.values()], revision: 1 }
    if (operation === 'release-receipt') { receipts.push(input); plans.find(plan => plan.operationId === input.operationId)!.state = input.state; return { recorded: true } }
    throw new Error(operation)
  })
  const host = { protocolVersion: 1, capabilities: { nativeSurface: true, tools: true }, request } as unknown as NativeContextHost
  const controller = new NativeSurfaceController(host)
  return { session, materials, plans, receipts, host, controller, request }
}
function appendRead(session: Session, body = 'upstream secret content '.repeat(40), referenceId = 'reference-A') {
  const output = JSON.stringify({ referenceId, items: [{ eventId: 'source-answer', text: body, offset: 0, complete: true }] })
  const message = createToolResultMessage({ callId: ToolCallId('source-read-call'), content: [{ type: 'text', text: output }], isError: false })
  return session.append('tool/result', { turn: 1, step: 1, message,
    meta: nativeMaterialMeta('read', { referenceId }, output)! }, { surfaceOp: 'append' })
}
function appendInitial(session: Session, separateAuthority = false) {
  const annotations = ['A', 'B'].map(id => ({ number: id === 'A' ? 1 : 2, referenceId: `reference-${id}`, sourceType: 'dsh-message', selectedText: `selected-${id}`,
    userComment: `user instruction ${id}`, locator: { sessionId: `source-${id}`, ...(separateAuthority ? { upstream: { referenceId: `authority-${id}` } } : {}) }, initialContext: { kind: 'selected-turn', sourceVersionId: 'v1', cutoffEventId: `answer-${id}`,
      items: [{ eventId: `question-${id}`, role: 'user', text: `question-${id}`, offset: 0, complete: true },
        { eventId: `answer-${id}`, role: 'assistant', text: `source-body-${id} `.repeat(60), offset: 0, complete: true }], turnComplete: true, hasMore: false, nextCursor: null } }))
  const documents = [{ key: 'shared-note', vaultId: 'vault', notePath: 'note.md', documentHash: 'hash', markdown: 'shared-note-body '.repeat(90), referenceIds: ['reference-A', 'reference-B'] }]
  const digest = canonicalSha256({ schemaVersion: 1, setId: 'set-A', annotations, documents })
  const text = `<dsh-annotations version="1" set-id="set-A">\n${canonicalJson({ items: annotations })}\n</dsh-annotations>\n<dsh-reference-documents>\n${canonicalJson({ documents })}\n</dsh-reference-documents>`
  const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'actual current user request' }] })
  session.append('user/message', ordinary, { surfaceOp: 'append' })
  return session.append('user/message', createUserMessage({ source: { kind: 'dsh-annotation', schemaVersion: 1, setId: 'set-A', targetUserMessageId: ordinary.id, count: 2, digest },
    content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}
describe('native material release on the actual DSH Session surface', () => {
  it('uses authoritative upstream IDs for ownership and keeps UI IDs solely in stable material keys', async () => {
    const f = fixture(); appendInitial(f.session, true)
    await f.controller.synchronize(f.session, 'execution', signal())
    expect([...f.materials.values()].flatMap(item => item.referenceIds)).not.toContain('reference-A')
    expect([...f.materials.values()].find(item => item.ranges[0]?.eventId === 'answer-A')?.referenceIds).toEqual(['authority-A'])
    expect([...f.materials.values()].find(item => item.referenceIds.length === 2)?.referenceIds).toEqual(['authority-A', 'authority-B'])
  })
  it('replaces a tool result, preserves pairing and raw history, and verifies the next derived input', async () => {
    const f = fixture(), original = appendRead(f.session)
    await f.controller.synchronize(f.session, 'execution', signal())
    const item = [...f.materials.values()][0]!
    expect(item.ranges[0]).toMatchObject({ referenceId: 'reference-A', eventId: 'source-answer', start: 0 })
    f.plans.push({ operationId: 'release-1', materialIds: [item.materialId], state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(JSON.stringify(f.session.deriveMessages())).not.toContain('upstream secret content')
    expect(f.session.eventAt(original.seq)).toEqual(original)
    const replacement = f.session.snapshotEvents().at(-1)!
    expect(replacement.type).toBe('tool/result')
    if (replacement.type !== 'tool/result') throw new Error('Unexpected event')
    expect(replacement.data.message.source).toEqual(original.data.message.source)
    expect(replacement.data.message.content[0].toolCallId).toBe('source-read-call')
    expect(replacement.sourceEventSeqs).toContain(original.seq)
    expect(f.receipts[0]).toMatchObject({ state: 'applied', operationId: 'release-1', surfaceEventSeqs: [replacement.seq] })
    expect(f.receipts[0].releasedBytes).toBeGreaterThan(0)
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.session.snapshotEvents()).toHaveLength(2)
  })
  it('releases one initial source while retaining the other source, shared document and real user message', async () => {
    const f = fixture(), original = appendInitial(f.session)
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.materials.size).toBe(7)
    const first = [...f.materials.values()].filter(item => item.referenceIds.length === 1 && item.referenceIds[0] === 'reference-A')
    f.plans.push({ operationId: 'initial-release', materialIds: first.map(item => item.materialId), state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    const input = JSON.stringify(f.session.deriveMessages())
    expect(input).not.toContain('source-body-A')
    expect(input).not.toContain('selected-A')
    expect(input).toContain('source-body-B')
    expect(input).toContain('shared-note-body')
    expect(input).toContain('actual current user request')
    expect(input).toContain('user instruction A')
    expect(f.session.eventAt(original.seq)).toEqual(original)
    const shared = [...f.materials.values()].find(item => item.referenceIds.length === 2)!
    const second = [...f.materials.values()].filter(item => item.referenceIds.length === 1 && item.referenceIds[0] === 'reference-B')
    f.plans.push({ operationId: 'last-holder-release', materialIds: [shared.materialId, ...second.map(item => item.materialId)], state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(JSON.stringify(f.session.deriveMessages())).not.toContain('shared-note-body')
    expect(JSON.stringify(f.session.deriveMessages())).not.toContain('source-body-B')
    expect(JSON.stringify(f.session.deriveMessages())).toContain('actual current user request')
  })
  it('recovers after replacement but failed receipt without a duplicate replacement or false early success', async () => {
    const f = fixture(); appendRead(f.session)
    await f.controller.synchronize(f.session, 'execution', signal())
    const item = [...f.materials.values()][0]!
    f.plans.push({ operationId: 'recover-release', materialIds: [item.materialId], state: 'pending-next-step' })
    const realRequest = f.request.getMockImplementation()!
    f.request.mockImplementation(async (sessionId, operation, input) => {
      if (operation === 'release-receipt') throw new Error('durable flush unavailable')
      return realRequest(sessionId, operation, input)
    })
    await expect(f.controller.synchronize(f.session, 'execution', signal())).rejects.toThrow('durable flush')
    expect(f.plans[0]!.state).toBe('pending-next-step')
    expect(f.receipts).toHaveLength(0)
    const restored = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header)
    f.request.mockImplementation(realRequest)
    await new NativeSurfaceController(f.host).synchronize(restored, 'execution', signal())
    expect(restored.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(f.plans[0]!.state).toBe('applied')
    expect(JSON.stringify(restored.deriveMessages())).not.toContain('upstream secret content')
  })
  it('does not classify user-authored envelopes or arbitrary tool output as releasable material', async () => {
    const f = fixture()
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '<dsh-annotations version="1"> user paste </dsh-annotations>' }] }), { surfaceOp: 'append' })
    f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('other-tool'),
      content: [{ type: 'text', text: 'arbitrary other tool content' }], isError: false }) }, { surfaceOp: 'append' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.materials.size).toBe(0)
    expect(f.session.deriveMessages()).toHaveLength(2)
  })
  it('registers request-list material independently and obeys cancellation before mutation', async () => {
    const f = fixture(), output = JSON.stringify({ items: [{ requestId: 'user-1', eventId: 'user-1', text: 'request index text', offset: 0 }] })
    f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('index-call'), content: [{ type: 'text', text: output }], isError: false }),
      meta: nativeMaterialMeta('requests', {}, output)! }, { surfaceOp: 'append' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect([...f.materials.values()][0]).toMatchObject({ kind: 'requests', referenceIds: [] })
    const controller = new AbortController(); controller.abort()
    await expect(f.controller.synchronize(f.session, 'execution', controller.signal)).rejects.toThrow()
    expect(f.session.surface.nodes).toHaveLength(1)
  })
  it('keeps disjoint requested upstream entries when releasing another item from one shared tool result', async () => {
    const f = fixture(), referenceId = 'source-A'
    const output = JSON.stringify({ referenceId, sourceVersionId: 'fixed-version', cutoffEventId: 'reply-40', nextCursor: 'older-cursor',
      items: [35, 38, 40].map(n => ({ eventId: `reply-${n}`, role: 'assistant', text: `body-${n} `.repeat(100), offset: 0, complete: true })) })
    const original = f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('multi-read'), content: [{ type: 'text', text: output }], isError: false }),
      meta: nativeMaterialMeta('read', { referenceId }, output)! }, { surfaceOp: 'append' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.materials.size).toBe(3)
    const removed = [...f.materials.values()].find(item => item.ranges[0]?.eventId === 'reply-35')!
    f.plans.push({ operationId: 'shrink-disjoint', materialIds: [removed.materialId], state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    const input = JSON.stringify(f.session.deriveMessages())
    expect(input).not.toContain('body-35')
    expect(input).toContain('body-38')
    expect(input).toContain('body-40')
    expect(input).toContain('older-cursor')
    expect(input).toContain('fixed-version')
    expect(f.session.eventAt(original.seq)).toEqual(original)
  })
  it('releases only one initial question/answer fragment while retaining descriptor and other fragments', async () => {
    const f = fixture(); appendInitial(f.session)
    await f.controller.synchronize(f.session, 'execution', signal())
    const removed = [...f.materials.values()].find(item => item.ranges[0]?.eventId === 'answer-A')!
    f.plans.push({ operationId: 'initial-fragment', materialIds: [removed.materialId], state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    const input = JSON.stringify(f.session.deriveMessages())
    expect(input).not.toContain('source-body-A')
    expect(input).toContain('selected-A')
    expect(input).toContain('question-A')
    expect(input).toContain('source-body-B')
    expect(input).toContain('shared-note-body')
  })
  it('does not resurrect source text after an unrelated native compaction rewrites the tool result', async () => {
    const f = fixture(), original = appendRead(f.session)
    await f.controller.synchronize(f.session, 'execution', signal())
    const item = [...f.materials.values()][0]!
    const replacement = f.session.append('tool/result', { ...original.data,
      message: { ...original.data.message, content: [{ ...original.data.message.content[0], content: [{ type: 'text', text: '[external compaction summary]' }] }] } },
    { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
    f.plans.push({ operationId: 'externally-compacted', materialIds: [item.materialId], state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.receipts[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('another compaction') })
    expect(f.session.surface.nodes).toEqual([replacement.seq])
    expect(JSON.stringify(f.session.deriveMessages())).not.toContain('upstream secret content')
  })
  it('applies an accepted release before registering new material and reports a full catalog without blocking management', async () => {
    const f = fixture(); appendRead(f.session)
    await f.controller.synchronize(f.session, 'execution', signal())
    const item = [...f.materials.values()][0]!
    f.plans.push({ operationId: 'free-capacity', materialIds: [item.materialId], state: 'pending-next-step' })
    appendRead(f.session, 'new unread body '.repeat(80), 'reference-B')
    const implementation = f.request.getMockImplementation()!
    f.request.mockImplementation(async (sessionId, operation, input) => {
      if (operation === 'materials-register') throw new Error('material catalog is full')
      return implementation(sessionId, operation, input)
    })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.plans[0]!.state).toBe('applied')
    expect(f.controller.registrationState(f.session)).toMatchObject({ state: 'registration-pending', unregisteredMaterials: 1 })
    expect(JSON.stringify(f.session.deriveMessages())).not.toContain('upstream secret content')
    expect(JSON.stringify(f.session.deriveMessages())).toContain('new unread body')
  })
  it('records each overlapping accepted operation even when the prior operation already released the same material', async () => {
    const f = fixture(); appendRead(f.session)
    await f.controller.synchronize(f.session, 'execution', signal())
    const item = [...f.materials.values()][0]!
    f.plans.push({ operationId: 'overlap-1', materialIds: [item.materialId], state: 'pending-next-step' },
      { operationId: 'overlap-2', materialIds: [item.materialId], state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.receipts.map(receipt => receipt.operationId)).toEqual(['overlap-1', 'overlap-2'])
    expect(f.receipts[1]!.releasedBytes).toBe(0)
    const last = f.session.snapshotEvents().at(-1)!
    if (last.type !== 'tool/result') throw new Error('Unexpected event')
    const content = last.data.message.content[0].content[0]!
    if (content.type !== 'text') throw new Error('Unexpected content')
    expect(JSON.parse(content.text).nativeContextRelease.operationIds).toEqual(['overlap-1', 'overlap-2'])
    expect(JSON.stringify(f.session.deriveMessages())).not.toContain('upstream secret content')
  })
  it('recovers unregistered siblings after a batch fails and an already registered part is released', async () => {
    const f = fixture(), referenceId = 'source-A'
    const output = JSON.stringify({ referenceId, items: Array.from({ length: 55 }, (_, n) => ({ eventId: `reply-${n}`,
      role: 'assistant', text: `body-${n}-retained `.repeat(20), offset: 0, complete: true })) })
    const original = f.session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('large-read'), content: [{ type: 'text', text: output }], isError: false }),
      meta: nativeMaterialMeta('read', { referenceId }, output)! }, { surfaceOp: 'append' })
    const implementation = f.request.getMockImplementation()!
    let registrationCalls = 0
    f.request.mockImplementation(async (sessionId, operation, input) => {
      if (operation === 'materials-register' && ++registrationCalls === 2) throw new Error('temporary registration failure')
      return implementation(sessionId, operation, input)
    })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.materials.size).toBe(50)
    expect(f.controller.registrationState(f.session)).toMatchObject({ state: 'registration-pending', unregisteredMaterials: 5 })
    const removed = [...f.materials.values()][0]!
    f.plans.push({ operationId: 'release-before-registration-recovery', materialIds: [removed.materialId], state: 'pending-next-step' })
    await f.controller.synchronize(f.session, 'execution', signal())
    expect(f.materials.size).toBe(55)
    expect(f.controller.registrationState(f.session)).toMatchObject({ state: 'ready', unregisteredMaterials: 0 })
    expect([...f.materials.values()].every(item => item.eventSeq === original.seq)).toBe(true)
    const input = JSON.stringify(f.session.deriveMessages())
    expect(input).not.toContain('body-0-retained')
    expect(input).toContain('body-54-retained')
    const restored = Session.create(f.session.id, f.session.snapshotEvents(), f.session.header)
    f.request.mockClear()
    await new NativeSurfaceController(f.host).synchronize(restored, 'execution', signal())
    const recovered = f.request.mock.calls.filter(([, operation]) => operation === 'materials-register').flatMap(([, , input]) => input.materials)
    expect(recovered).toHaveLength(54)
    expect(recovered.map(item => item.materialId)).not.toContain(removed.materialId)
    expect(JSON.stringify(restored.deriveMessages())).toBe(input)
  })
})
