// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnnotationCoreClientService } from '../src/client/service.tsx'
import { AnnotationStore } from '../src/host/store.ts'
import { selectedTextHash, type DshMessageCapture, type DshMessageReferenceSource } from '../src/protocol/index.ts'

const capture: DshMessageCapture = {
  sourceSessionId: 'source', messageId: 'completed-reply', anchorId: 'reply', role: 'assistant', occurrence: 0, selectedText: 'quoted',
}
const source: DshMessageReferenceSource = {
  sourceType: 'dsh-message', selectedText: 'quoted', locator: {
    profileId: 'web', sessionId: 'source', anchorId: 'reply', role: 'assistant', occurrence: 0,
    selectedTextHash: selectedTextHash('quoted'), upstream: {
      kind: 'fixed-upstream', referenceId: 'relation', sourceTitle: 'Source', sourceVersionId: 'fixed-version',
      cutoffEventId: 'completed-reply', targetSessionId: 'target',
    },
  },
}
const stores: AnnotationStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()); vi.restoreAllMocks(); vi.useRealTimers() })
function fixture() {
  const ctx = new Context(), store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
  stores.push(store)
  let current = 'source', core: AnnotationCoreClientService
  const sessions = { refresh: vi.fn(async () => {}), open: vi.fn((id: string) => {
    current = id; core.registerNativeComposer(id)
  }), list: { getSnapshot: () => ({ current }) } }
  ctx.provide('sessions', sessions as never)
  core = new AnnotationCoreClientService(ctx, { profileId: 'web' })
  const remote = {
    captureUpstream: vi.fn(async () => ({ ok: true, value: source })),
    readPending: vi.fn(async () => ({ ok: true, value: store.readPending('target') })),
    addReference: vi.fn(async (input: Parameters<AnnotationStore['addReference']>[1]) => ({ ok: true, value: await store.addReference('target', input) })),
    resolveReferenceLink: vi.fn(async (referenceId: string) => ({ ok: true, value: store.resolveReferenceLink('target', referenceId) })),
    submitAnnotated: vi.fn(), submitPlainClaim: vi.fn(),
  }
  vi.spyOn(core as any, 'remote').mockImplementation((id: unknown) => {
    expect(id).toBe('target'); return remote
  })
  return { core, remote, store, sessions, switchAway: () => { current = 'other' } }
}

describe('graph reference actions', () => {
  it('adds through the same durable operation and safely retries a lost acknowledgement', async () => {
    const f = fixture()
    f.remote.addReference.mockImplementationOnce(async input => {
      await f.store.addReference('target', input)
      throw new Error('lost acknowledgement')
    })
    await expect(f.core.addCrossSessionReference('target', capture, { operationId: 'graph-op' })).rejects.toThrow('lost acknowledgement')
    const result = await f.core.addCrossSessionReference('target', capture, { operationId: 'graph-op' })
    expect(result).toMatchObject({ referenceId: 'relation', created: false })
    expect(f.store.readPending('target').pending?.items).toHaveLength(1)
    expect(f.remote.captureUpstream).toHaveBeenNthCalledWith(2, { capture, operationId: 'graph-op' })
    expect(await f.core.resolveReferenceLink('target', result.referenceId)).toEqual({
      setId: result.setId, referenceId: 'relation', state: 'pending',
    })
    expect(f.core.features).toContain('graph-reference-actions-v1')
    expect(f.remote.submitAnnotated).not.toHaveBeenCalled()
    expect(f.remote.submitPlainClaim).not.toHaveBeenCalled()
  })

  it('coalesces repeated actions while in flight and rejects another source under the same operation', async () => {
    const f = fixture()
    let ready!: () => void
    f.sessions.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve }))
    const first = f.core.addCrossSessionReference('target', capture, { operationId: 'same' })
    expect(f.core.addCrossSessionReference('target', { ...capture }, { operationId: 'same' })).toBe(first)
    await expect(f.core.addCrossSessionReference('target', { ...capture, selectedText: 'changed' }, { operationId: 'same' }))
      .rejects.toThrow('不能更换来源')
    ready(); await first
    expect(f.remote.addReference).toHaveBeenCalledTimes(1)
  })

  it('waits for the real target composer before capturing any context', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.sessions.open.mockImplementation(() => {})
    f.sessions.list.getSnapshot = () => ({ current: 'target' })
    const task = f.core.addCrossSessionReference('target', capture)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.remote.captureUpstream).not.toHaveBeenCalled()
    f.core.registerNativeComposer('target')
    await vi.advanceTimersByTimeAsync(50)
    await task
    expect(f.remote.addReference).toHaveBeenCalledTimes(1)
  })

  it.each(['capture', 'pending'])('does not append when the target changes during the awaited %s request', async stage => {
    const f = fixture()
    if (stage === 'capture') f.remote.captureUpstream.mockImplementationOnce(async () => {
      f.switchAway(); return { ok: true, value: source }
    })
    else f.remote.readPending.mockImplementationOnce(async () => {
      f.switchAway(); return { ok: true, value: f.store.readPending('target') }
    })
    await expect(f.core.addCrossSessionReference('target', capture)).rejects.toThrow('目标页面已切换')
    expect(f.remote.addReference).not.toHaveBeenCalled()
    expect(f.store.readPending('target').pending).toBeUndefined()
  })

  it('rejects same-session and non-assistant references before navigating', async () => {
    const f = fixture()
    await expect(f.core.addCrossSessionReference('source', capture)).rejects.toThrow('另一个会话')
    await expect(f.core.addCrossSessionReference('target', { ...capture, role: 'user' })).rejects.toThrow('已完成')
    expect(f.sessions.refresh).not.toHaveBeenCalled()
  })
})
