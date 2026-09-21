import { expect, it } from 'vitest'
import { LocalSessionExtensionData, type SessionExtensionObject, type SessionExtensionSync } from '../src/host/session-extension-data'

const record = (revision = 1): SessionExtensionObject => ({ sessionId: 'session', namespace: 'thoughtdag', objectId: 'graph', revision, deleted: false, content: { title: 'Existing graph', nodes: ['original'] } })
function fixture() {
  const rows = new Map<string, SessionExtensionObject>(), remote = new Map<string, SessionExtensionObject>()
  let online = true, failAck = false, enabled = true
  const sync: SessionExtensionSync = { protocolVersion: 1, namespaces: ['thoughtdag'],
    async read() { if (!online) throw new Error('offline'); return [...remote.values()] },
    async commit(value) { if (!online) throw new Error('offline'); remote.set(value.objectId, structuredClone(value)); if (failAck) throw new Error('lost ack') },
  }
  const data = new LocalSessionExtensionData({ get: key => rows.get(key), entries: () => rows.entries(),
    async put(key, value) { rows.set(key, structuredClone(value)) }, async update(key, fn) { rows.set(key, fn(rows.get(key)!)) },
  }, async () => { if (!online) throw new Error('write paused') }, () => enabled ? sync : undefined)
  return { rows, remote, data, online(value: boolean) { online = value }, failAck(value: boolean) { failAck = value }, enabled(value: boolean) { enabled = value } }
}
it('restores canonical graph data before opening a session without creating an empty replacement', async () => {
  const f = fixture(); f.remote.set('graph', record(7))
  await f.data.ready('thoughtdag', 'session')
  expect(f.data.get('session', 'thoughtdag', 'graph')).toEqual(record(7))
  expect(f.remote.get('graph')?.revision).toBe(7)
})
it('reconciles a lost remote acknowledgement before retry; no duplicate edit is applied', async () => {
  const f = fixture(); f.remote.set('graph', record()); await f.data.ready('thoughtdag', 'session')
  f.failAck(true)
  const { revision: _, ...value } = record(2)
  await expect(f.data.write({ ...value, expectedRevision: 1 })).rejects.toThrow('lost ack')
  expect(f.data.get('session', 'thoughtdag', 'graph')?.revision).toBe(1)
  f.failAck(false); await f.data.ready('thoughtdag', 'session')
  expect(f.data.get('session', 'thoughtdag', 'graph')?.revision).toBe(2)
  await expect(f.data.write({ ...value, expectedRevision: 1 })).rejects.toThrow('conflict')
})
it('blocks registered writes while offline and preserves local data after disconnecting an optional replica', async () => {
  const f = fixture(); f.remote.set('graph', record()); await f.data.ready('thoughtdag', 'session')
  f.online(false)
  const { revision: _, ...value } = record()
  await expect(f.data.write({ ...value, expectedRevision: 1 })).rejects.toThrow('write paused')
  f.enabled(false); await f.data.ready('thoughtdag', 'session')
  expect(f.data.list('thoughtdag')).toEqual([record()])
  f.online(true); await f.data.write({ ...value, expectedRevision: 1 })
  expect(f.data.list('thoughtdag')[0]?.revision).toBe(2)
})
it('refuses divergent equal revisions and does not replace local data with an older remote copy', async () => {
  const f = fixture(); f.remote.set('graph', record(3)); await f.data.ready('thoughtdag', 'session')
  f.remote.set('graph', { ...record(3), content: { changed: true } })
  await expect(f.data.ready('thoughtdag', 'session')).rejects.toThrow('disagree')
  f.remote.set('graph', record(2))
  await expect(f.data.ready('thoughtdag', 'session')).rejects.toThrow('disagree')
  expect(f.data.list('thoughtdag')).toEqual([record(3)])
})
