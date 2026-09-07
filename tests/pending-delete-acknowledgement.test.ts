import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { PendingDiscardOutbox } from '../src/host/pending-discard-outbox.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { AnnotationStore, SessionAggregateSchema } from '../src/host/store.ts'
import { documentHash, selectedTextHash } from '../src/protocol/index.ts'

async function pendingStore() {
  const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
  const markdown = 'quoted text ^block-1\n'
  await store.addReference('session-1', {
    expectedRevision: 0, operationId: 'capture-1', referenceId: 'reference-1', setId: 'set-1', createdAt: 1,
    source: {
      sourceType: 'obsidian-note', selectedText: 'quoted text',
      locator: { vaultId: 'vault-1', notePath: 'note.md', blockId: 'block-1', occurrence: 0, selectedTextHash: selectedTextHash('quoted text') },
      snapshot: { markdown, documentHash: documentHash(markdown), capturedAt: 1, freshness: 'captured' },
    },
  })
  return store
}

async function deletePending(store: AnnotationStore) {
  await store.deleteReferenceLink('session-1', {
    expectedRevision: store.read('session-1').revision, setId: 'set-1', referenceId: 'reference-1', deletedAt: 20,
  })
}

// This boundary models the source's durable delete request: ordinary cancellation
// is rejected, and only a commit for the exact relation can clear it.
function sourceWithDeleteRequest() {
  const requests = new Set(['web:session-1:set-1:reference-1'])
  let online = true
  const sources = new HostSourceRegistry(new Context())
  sources.registerSourceAdapter('obsidian-note', {
    prepare: async (item) => item,
    discardPending: async () => { throw new Error('409 IDEMPOTENCY_CONFLICT: relation deletion requires acknowledgement') },
    deleteCommitted: async (binding) => {
      if (!online) throw new Error('Obsidian offline')
      const key = `${binding.profileId}:${binding.sessionId}:${binding.setId}:${binding.referenceId}`
      if (key !== 'web:session-1:set-1:reference-1' || binding.item.referenceId !== binding.referenceId || binding.deletedAt !== 20) {
        throw new Error('409 IDEMPOTENCY_CONFLICT: deletion identity mismatch')
      }
      requests.delete(key)
    },
  })
  return { requests, sources, setOnline(value: boolean) { online = value } }
}

describe('pending relation deletion acknowledgement', () => {
  it('acknowledges the durable pending tombstone instead of cancelling the source capture', async () => {
    const store = await pendingStore()
    await deletePending(store)
    const source = sourceWithDeleteRequest()
    const outbox = new PendingDiscardOutbox(store, source.sources)
    try {
      await outbox.runPending('session-1')
      expect(store.listPendingDiscardJobs('session-1')).toEqual([])
      expect(source.requests.size).toBe(0)
      expect(store.readPending('session-1').pending).toBeUndefined()
    } finally { outbox.dispose() }
  })

  it('recovers a legacy job with thousands of failed discards after serialized restart', async () => {
    const original = await pendingStore()
    await deletePending(original)
    const legacy = JSON.parse(JSON.stringify(original.read('session-1')))
    legacy.pendingDiscardJobs['reference-1'].attempts = 3001
    legacy.pendingDiscardJobs['reference-1'].lastError = '409 IDEMPOTENCY_CONFLICT'
    const table = AnnotationStore.memoryTable()
    await table.put('web:session-1', SessionAggregateSchema.parse(legacy))
    const restarted = new AnnotationStore(table, { profileId: 'web' })
    const source = sourceWithDeleteRequest()
    const outbox = new PendingDiscardOutbox(restarted, source.sources)
    try {
      await outbox.runPending('session-1')
      expect(restarted.listPendingDiscardJobs('session-1')).toEqual([])
      expect(source.requests.size).toBe(0)
      expect(restarted.read('session-1').deletedReferences['reference-1']).toMatchObject({ setId: 'set-1', scope: 'pending', deletedAt: 20 })
    } finally { outbox.dispose() }
  })

  it('retains an offline acknowledgement and drains it after restart with duplicate consumers', async () => {
    const store = await pendingStore()
    await deletePending(store)
    const source = sourceWithDeleteRequest()
    source.setOnline(false)
    const initial = new PendingDiscardOutbox(store, source.sources, { now: () => 30 })
    try {
      await initial.runPending('session-1')
      expect(store.listPendingDiscardJobs('session-1')).toEqual([expect.objectContaining({ attempts: 1, lastError: 'Obsidian offline' })])
      expect(source.requests.size).toBe(1)
    } finally { initial.dispose() }
    source.setOnline(true)
    const restarted = new AnnotationStore(store.table, { profileId: 'web' })
    const first = new PendingDiscardOutbox(restarted, source.sources)
    const second = new PendingDiscardOutbox(restarted, source.sources)
    try {
      await Promise.all([first.runPending('session-1'), first.runPending('session-1'), second.runPending('session-1')])
      expect(restarted.listPendingDiscardJobs('session-1')).toEqual([])
      expect(source.requests.size).toBe(0)
      await restarted.deleteReferenceLink('session-1', { expectedRevision: 0, setId: 'set-1', referenceId: 'reference-1', deletedAt: 40 })
      expect(restarted.listPendingDiscardJobs('session-1')).toEqual([])
    } finally { first.dispose(); second.dispose() }
  })

  it('keeps ordinary pending cancellation on the discard path', async () => {
    const store = await pendingStore()
    await store.removeReference('session-1', { expectedRevision: 1, referenceId: 'reference-1' })
    const captures = new Set(['reference-1'])
    const sources = new HostSourceRegistry(new Context())
    sources.registerSourceAdapter('obsidian-note', {
      prepare: async (item) => item,
      discardPending: async (item) => { captures.delete(item.referenceId) },
      deleteCommitted: async () => { throw new Error('Cancellation has no relation deletion identity') },
    })
    const outbox = new PendingDiscardOutbox(store, sources)
    try {
      await outbox.runPending('session-1')
      expect(captures.size).toBe(0)
      expect(store.listPendingDiscardJobs('session-1')).toEqual([])
    } finally { outbox.dispose() }
  })

  it('does not treat a mismatched source relation as successful acknowledgement', async () => {
    const store = await pendingStore()
    await deletePending(store)
    const row = store.read('session-1')
    await store.table.put('web:session-1', {
      ...row, deletedReferences: { 'reference-1': { ...row.deletedReferences['reference-1']!, setId: 'wrong-set' } },
    })
    const source = sourceWithDeleteRequest()
    const outbox = new PendingDiscardOutbox(store, source.sources)
    try {
      await outbox.runPending('session-1')
      expect(source.requests.size).toBe(1)
      expect(store.listPendingDiscardJobs('session-1')).toEqual([expect.objectContaining({ attempts: 1, lastError: '409 IDEMPOTENCY_CONFLICT: deletion identity mismatch' })])
    } finally { outbox.dispose() }
  })

  it.each([
    { scope: 'sent' as const },
    { sourceType: 'dsh-message' as const },
    { referenceId: 'different-reference' },
  ])('retains cleanup when the stored tombstone does not identify the pending job: %j', async (mismatch) => {
    const store = await pendingStore()
    await deletePending(store)
    const row = store.read('session-1')
    await store.table.put('web:session-1', {
      ...row, deletedReferences: { 'reference-1': { ...row.deletedReferences['reference-1']!, ...mismatch } },
    })
    const captures = new Set(['reference-1'])
    const sources = new HostSourceRegistry(new Context())
    sources.registerSourceAdapter('obsidian-note', {
      prepare: async (item) => item,
      discardPending: async () => { captures.delete('reference-1') },
      deleteCommitted: async () => { captures.delete('reference-1') },
    })
    const outbox = new PendingDiscardOutbox(store, sources)
    try {
      await outbox.runPending('session-1')
      expect(captures.size).toBe(1)
      expect(store.listPendingDiscardJobs('session-1')).toEqual([expect.objectContaining({ attempts: 1 })])
    } finally { outbox.dispose() }
  })
})
