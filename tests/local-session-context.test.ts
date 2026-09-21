import { expect, it } from 'vitest'
import { LocalSessionContext, localSessionSource, type LocalSessionSource } from '../src/host/local-session-context.ts'
import { LocalSessionExtensionData, type SessionExtensionObject } from '../src/host/session-extension-data.ts'
import { sessionContextRouter } from '../src/host/session-context-router.ts'
import type { UpstreamHost } from '../src/host/upstream.ts'
import type { Context } from '@deepseek-ai/cordis'

function fixture() {
  const rows = new Map<string, SessionExtensionObject>()
  const data = new LocalSessionExtensionData({ get: key => rows.get(key), entries: () => rows.entries(), put: async (key, value) => { rows.set(key, structuredClone(value)) }, update: async (key, change) => { rows.set(key, structuredClone(change(rows.get(key)!))) } })
  const snapshots = new Map(['a', 'b', 'c'].map(id => [id, { title: id, entries: [{ eventId: `${id}-q`, role: 'user', text: 'Question' }, { eventId: `${id}-a`, role: 'assistant', text: 'Selected answer' }] }]))
  const source: LocalSessionSource = { list: async () => [...snapshots.keys()].map(id => ({ id, title: id })), read: async id => { const value = snapshots.get(id); if (!value) throw new Error('Missing source'); return structuredClone(value) } }
  const context = new LocalSessionContext(data, source)
  const capture = (from = 'a', to = 'b', op = 'capture') => ({ operationId: op, sourceNativeSessionId: from, targetNativeSessionId: to, anchorId: `${from}-a`, selectedText: 'Selected' })
  return { rows, data, snapshots, source, context, capture }
}

it('keeps the captured version and excludes later turns, including after reopening the service', async () => {
  const f = fixture(), saved = await f.context.capture(f.capture())
  f.snapshots.get('a')!.entries.push({ eventId: 'later', role: 'assistant', text: 'Private later turn' })
  const reopened = new LocalSessionContext(f.data, f.source)
  expect((await reopened.capture(f.capture())).sourceVersionId).toBe(saved.sourceVersionId)
  const page = await reopened.read({ targetNativeSessionId: 'b', referenceId: saved.referenceId, executionId: 'turn-1', view: 'selected-turn', maxBytes: 4096, totalBytes: 8192 })
  expect(page.items.map(item => item.text)).toEqual(['Question', 'Selected answer'])
  expect(JSON.stringify(page)).not.toContain('Private later turn')
  await expect(reopened.capture({ ...f.capture(), selectedText: 'changed' })).rejects.toThrow('操作身份')
})

it('discloses the selected turn first and continues into earlier authorized turns', async () => {
  const f = fixture()
  f.snapshots.get('a')!.entries.unshift({ eventId: 'earlier-q', role: 'user', text: 'Earlier question' }, { eventId: 'earlier-a', role: 'assistant', text: 'Earlier answer' })
  const saved = await f.context.capture(f.capture())
  const input = { targetNativeSessionId: 'b', referenceId: saved.referenceId, executionId: 'history', maxBytes: 4096, totalBytes: 16384 }
  const first = await f.context.read({ ...input, view: 'selected-turn' })
  expect(first.items.map(item => item.text)).toEqual(['Question', 'Selected answer'])
  expect(first.selectedTurn.complete).toBe(true)
  expect(first.hasMore).toBe(true)
  const earlier = await f.context.read({ ...input, cursor: first.nextCursor! })
  expect(earlier.items.map(item => item.text)).toEqual(['Earlier question', 'Earlier answer'])
  await expect(f.context.read({ ...input, userRequestId: 'not-authorized' })).rejects.toThrow('已授权')
  const preview = await f.context.preview('a')
  expect(preview.capture.anchorId).toBe('a-a')
  expect(preview.items[0]?.text).toBe('Question')
})

it('validates target ownership, explicit revocation and source availability', async () => {
  const f = fixture(), saved = await f.context.capture(f.capture())
  await expect(f.context.inspect('c', saved.referenceId)).rejects.toThrow()
  await f.context.bind('b', saved.referenceId, 'message-1')
  await expect(f.context.bind('b', saved.referenceId, 'message-2')).rejects.toThrow('另一次')
  await f.context.bind('b', saved.referenceId, null)
  expect(await f.context.status('b', saved.referenceId)).toEqual({ referenceId: saved.referenceId, state: 'revoked' })
  await expect(f.context.inspect('b', saved.referenceId)).rejects.toThrow('不可用')
  expect(f.data.list('annotation-upstream')).toHaveLength(1)
})

it('serializes concurrent grants so opposite edges cannot create a cycle', async () => {
  const f = fixture()
  const results = await Promise.allSettled([f.context.capture(f.capture('a', 'b')), f.context.capture(f.capture('b', 'a'))])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(f.data.list('annotation-upstream')).toHaveLength(1)
})

it('paginates long Unicode answers without losing text or crossing targets and enforces a turn budget', async () => {
  const f = fixture(), answer = 'Selected ' + '中文内容😀'.repeat(2500)
  f.snapshots.get('a')!.entries[1]!.text = answer
  const saved = await f.context.capture(f.capture())
  let cursor: string | undefined, output = ''
  do {
    const page = await f.context.read({ targetNativeSessionId: 'b', referenceId: saved.referenceId, executionId: 'long', maxBytes: 2048, totalBytes: 100000, ...(cursor ? { cursor } : { view: 'selected-turn' }) })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048)
    output += page.items.filter(item => item.role === 'assistant').map(item => item.text).join('')
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  expect(output).toBe(answer)
  await f.context.endExecution('b', 'long')
  await expect(f.context.read({ targetNativeSessionId: 'b', referenceId: saved.referenceId, executionId: 'long', maxBytes: 2048, totalBytes: 100000 })).rejects.toThrow('已经结束')
})

it('uses the public host log shape and ignores interrupted assistant messages', async () => {
  const source = localSessionSource({ sessions: { get: () => undefined }, get: () => ({ readSession: async () => ({ session: { id: 'a' }, events: [
    { type: 'user/message', data: { id: 'q', role: 'user', content: [{ type: 'text', text: 'Question' }] } },
    { type: 'assistant/message', data: { message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'Answer' }] } } },
    { type: 'assistant/message', data: { interrupted: true, message: { id: 'bad', role: 'assistant', content: [{ type: 'text', text: 'Incomplete' }] } } },
  ] }) }) } as unknown as Context)
  expect((await source.read('a')).entries.map(item => item.text)).toEqual(['Question', 'Answer'])
})

it('rejects stale concurrent session-extension writes and keeps data after a consumer stops', async () => {
  const f = fixture()
  const input = { sessionId: 'a', namespace: 'thoughtdag', objectId: 'graph', expectedRevision: 0, deleted: false, content: { nodes: [] } }
  const result = await Promise.allSettled([f.data.write(input), f.data.write(input)])
  expect(result.map(item => item.status)).toEqual(['fulfilled', 'rejected'])
  expect(f.data.get('a', 'thoughtdag', 'graph')?.revision).toBe(1)
})

it('does not fall back to local writes after a managed provider disappears', async () => {
  const f = fixture(); let provider: UpstreamHost | undefined
  const router = sessionContextRouter(f.context, () => provider)
  expect((await router.directory()).items).toHaveLength(3)
  provider = new Proxy(f.context, { get: (target, key) => key === 'directory' ? async () => ({ items: [], nextCursor: null }) : Reflect.get(target, key) })
  expect((await router.directory()).items).toHaveLength(0)
  provider = undefined
  expect(() => router.directory()).toThrow('正式解除注册')
})
