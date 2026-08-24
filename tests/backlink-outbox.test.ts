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
