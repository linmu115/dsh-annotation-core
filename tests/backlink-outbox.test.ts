import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { BacklinkOutbox } from '../src/host/backlink-outbox.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { AnnotationStore } from '../src/host/store.ts'
import { documentHash, selectedTextHash } from '../src/protocol/index.ts'

const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

async function sentStore() {
  const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
  const selected = 'selected'
  await store.addReference('session', {
    expectedRevision: 0, operationId: 'operation', setId: 'set', referenceId: 'reference', createdAt: 1,
    source: {
      sourceType: 'obsidian-note', selectedText: selected,
      locator: { vaultId: 'vault', notePath: 'note.md', blockId: 'block', occurrence: 0, selectedTextHash: selectedTextHash(selected) },
      snapshot: { markdown: '# note', documentHash: documentHash('# note'), capturedAt: 1, freshness: 'captured' },
    },
  })
  const begun = await store.beginAnnotatedAdmission('session', {
    expectedRevision: 1, clientSubmissionId: 'submission', requestDigest: digest,
    setId: 'set', referenceRevision: 1, createdAt: 2,
  })
  await store.recordEnqueuedSubmission('session', {
    expectedRevision: begun.revision,
    clientSubmissionId: 'submission', requestDigest: digest,
    userMessageId: 'user', contextMessageId: 'context', contextDigest: digest,
    userTextHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    preparedSet: begun.set!, createdAt: 3,
  })
  await store.finalizeDurableSubmission('session', {
    expectedRevision: 3, clientSubmissionId: 'submission', userMessageId: 'user',
    userObserved: true, contextObserved: true, committedAt: 4,
  })
  return store
}

describe('durable backlink outbox', () => {
  it('drains a late backlink receipt before storage closes and refuses new retry work', async () => {
    const store = await sentStore()
    const registry = new HostSourceRegistry(new Context())
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const writer = vi.fn(async () => {
      entered.resolve(); await release.promise
      return { referenceId: 'reference', commitDigest: digest, notePath: 'note.md', blockId: 'block', revision: '1', writtenAt: 5 }
    })
    registry.registerSourceAdapter('obsidian-note', { prepare: async item => item, commitBacklink: writer })
    const outbox = new BacklinkOutbox(store, registry)
    const operation = outbox.runPending('session')
    await entered.promise
    let drained = false
    const stopping = outbox.dispose().then(() => { drained = true })
    await outbox.runPending('session')
    await expect(outbox.retry('session', 'set', 'reference')).rejects.toThrow(/stopping/)
    expect(drained).toBe(false)
    release.resolve()
    await Promise.all([stopping, operation, outbox.dispose()])
    expect(store.listBacklinkJobs('session')[0]?.state).toBe('written')
    store.close()
    await outbox.runPending('session')
    expect(writer).toHaveBeenCalledOnce()
  })

  it('queues cleanup for a late write and prevents an earlier delete receipt from removing it', async () => {
    const store = await sentStore()
    const registry = new HostSourceRegistry(new Context())
    const waiting = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    registry.registerSourceAdapter('obsidian-note', { prepare: async item => item, commitBacklink: async () => {
      entered.resolve()
      await waiting.promise
      return { referenceId: 'reference', commitDigest: digest, notePath: 'note.md', blockId: 'block', revision: '1', writtenAt: 5 }
    } })
    const operation = new BacklinkOutbox(store, registry).runPending('session')
    await entered.promise
    await store.deleteReferenceLink('session', { expectedRevision: store.read('session').revision,
      setId: 'set', referenceId: 'reference', deletedAt: 5 })
    waiting.resolve()
    await operation
    await store.completeCommittedDelete('session', { expectedRevision: store.read('session').revision,
      setId: 'set', referenceId: 'reference', expectedGeneration: 0 })
    expect(store.readSentSet('session', 'set')).toBeUndefined()
    expect(store.listBacklinkJobs('session')).toHaveLength(0)
    expect(store.listCommittedDeleteJobs('session')).toHaveLength(1)
  })
  it('persists receipt and attempts without changing the already-sent model transaction', async () => {
    const store = await sentStore()
    const registry = new HostSourceRegistry(new Context())
    const commitBacklink = vi.fn(async () => ({
      referenceId: 'reference', commitDigest: digest, notePath: 'note.md', blockId: 'block', revision: '1', writtenAt: 5,
    }))
    registry.registerSourceAdapter('obsidian-note', { prepare: async (item) => item, commitBacklink })
    const outbox = new BacklinkOutbox(store, registry, () => 5)
    await outbox.runPending('session')
    expect(commitBacklink).toHaveBeenCalledTimes(1)
    expect(commitBacklink).toHaveBeenCalledWith(expect.objectContaining({
      userTextHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    }))
    expect(store.listBacklinkJobs('session')[0]).toMatchObject({ state: 'written', attempts: 1, receipt: { revision: '1' } })
    expect(store.readSentSet('session', 'set')?.state).toBe('sent')
    expect(store.readAdmission('session', 'submission')?.state).toBe('durable')
  })

  it('keeps failure outside the model transaction and supports explicit retry', async () => {
    const store = await sentStore()
    const registry = new HostSourceRegistry(new Context())
    let fail = true
    registry.registerSourceAdapter('obsidian-note', {
      prepare: async (item) => item,
      commitBacklink: async () => {
        if (fail) throw new Error('Obsidian offline')
        return { referenceId: 'reference', commitDigest: digest, notePath: 'note.md', blockId: 'block', revision: '2', writtenAt: 6 }
      },
    })
    const outbox = new BacklinkOutbox(store, registry, () => 6)
    await outbox.runPending('session')
    expect(store.listBacklinkJobs('session')[0]).toMatchObject({ state: 'failed', attempts: 1, lastError: 'Obsidian offline' })
    expect(store.readSentSet('session', 'set')?.state).toBe('sent')
    fail = false
    const retried = await outbox.retry('session', 'set', 'reference')
    expect(retried).toMatchObject({ state: 'written', attempts: 2, receipt: { revision: '2' } })
  })
})
