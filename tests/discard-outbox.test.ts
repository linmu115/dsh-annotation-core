import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { PendingDiscardOutbox } from '../src/host/pending-discard-outbox.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { AnnotationStore, SessionAggregateSchema } from '../src/host/store.ts'
import { documentHash, selectedTextHash } from '../src/protocol/index.ts'
import { AnnotationCoreRemoteService } from '../src/remote/service.ts'

function obsidianSource() {
  const selectedText = '引用内容'
  const markdown = `# 笔记\n\n${selectedText} ^dsh-note-owned\n`
  return {
    sourceType: 'obsidian-note' as const,
    selectedText,
    locator: {
      vaultId: 'vault-1',
      notePath: '笔记.md',
      blockId: 'dsh-note-owned',
      occurrence: 0,
      selectedTextHash: selectedTextHash(selectedText),
    },
    snapshot: {
      markdown,
      documentHash: documentHash(markdown),
      capturedAt: 1,
      freshness: 'captured' as const,
    },
  }
}

async function storeWithPending() {
  const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
  await store.addReference('session', {
    expectedRevision: 0,
    operationId: 'operation-1',
    setId: 'set-1',
    referenceId: 'reference-1',
    source: obsidianSource(),
    createdAt: 1,
  })
  return store
}

describe('pending reference discard outbox', () => {
  it('loads existing v1 aggregate rows with an empty discard queue', () => {
    const parsed = SessionAggregateSchema.parse({
      schemaVersion: 1,
      profileId: 'web',
      sessionId: 'session',
      revision: 0,
      sentSets: [],
      operations: {},
      admissions: {},
      submissionJournal: {},
      flushReconciliations: {},
      backlinkJobs: {},
    })
    expect(parsed.pendingDiscardJobs).toEqual({})
  })

  it('removes the DSH pending item immediately and persists source cleanup work atomically', async () => {
    const store = await storeWithPending()

    const removed = await store.removeReference('session', {
      expectedRevision: 1,
      referenceId: 'reference-1',
      now: 2,
    })

    expect(removed).toMatchObject({ pendingCount: 0 })
    expect(store.readPending('session').pending).toBeUndefined()
    expect(store.listPendingDiscardJobs('session')).toEqual([
      expect.objectContaining({
        referenceId: 'reference-1',
        state: 'pending',
        attempts: 0,
        item: expect.objectContaining({ sourceType: 'obsidian-note' }),
      }),
    ])
  })

  it('deletes the durable cleanup job only after the source acknowledges discard', async () => {
    const store = await storeWithPending()
    await store.removeReference('session', { expectedRevision: 1, referenceId: 'reference-1', now: 2 })
    const sources = new HostSourceRegistry(new Context())
    const discardPending = vi.fn(async () => undefined)
    sources.registerSourceAdapter('obsidian-note', { prepare: async (item) => item, discardPending })

    const outbox = new PendingDiscardOutbox(store, sources, { now: () => 3, retryDelayMs: 60_000 })
    await outbox.runPending('session')

    expect(discardPending).toHaveBeenCalledOnce()
    expect(discardPending).toHaveBeenCalledWith(expect.objectContaining({ referenceId: 'reference-1' }))
    expect(store.listPendingDiscardJobs('session')).toEqual([])
    outbox.dispose()
  })

  it('keeps failed cleanup durable while DSH remains deleted, then succeeds on retry', async () => {
    const store = await storeWithPending()
    await store.removeReference('session', { expectedRevision: 1, referenceId: 'reference-1', now: 2 })
    const sources = new HostSourceRegistry(new Context())
    let offline = true
    sources.registerSourceAdapter('obsidian-note', {
      prepare: async (item) => item,
      discardPending: async () => {
        if (offline) throw new Error('Obsidian offline')
      },
    })
    const outbox = new PendingDiscardOutbox(store, sources, { now: () => 3, retryDelayMs: 60_000 })

    await outbox.runPending('session')
    expect(store.readPending('session').pending).toBeUndefined()
    expect(store.listPendingDiscardJobs('session')[0]).toMatchObject({
      state: 'pending',
      attempts: 1,
      lastError: 'Obsidian offline',
    })

    offline = false
    await outbox.runPending('session')
    expect(store.listPendingDiscardJobs('session')).toEqual([])
    outbox.dispose()
  })

  it('queues the same cleanup when a producer operation is discarded', async () => {
    const store = await storeWithPending()

    await store.discardPendingOperation('session', {
      expectedRevision: 1,
      operationId: 'operation-1',
      now: 2,
    })

    expect(store.readPending('session').pending).toBeUndefined()
    expect(store.listPendingDiscardJobs('session')).toEqual([
      expect.objectContaining({ referenceId: 'reference-1', state: 'pending' }),
    ])
  })

  it('returns the Remote deletion before a slow Obsidian cleanup completes', async () => {
    const store = await storeWithPending()
    const sources = new HostSourceRegistry(new Context())
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve })
    sources.registerSourceAdapter('obsidian-note', {
      prepare: async (item) => item,
      discardPending: async () => cleanup,
    })
    const outbox = new PendingDiscardOutbox(store, sources, { retryDelayMs: 60_000 })
    const service = new AnnotationCoreRemoteService(new Context(), store, undefined, undefined, outbox)

    await service.removeReference({ id: 'session' } as never, {
      expectedRevision: 1,
      referenceId: 'reference-1',
    })

    expect(store.readPending('session').pending).toBeUndefined()
    expect(store.listPendingDiscardJobs('session')).toHaveLength(1)
    releaseCleanup()
    await vi.waitFor(() => { expect(store.listPendingDiscardJobs('session')).toEqual([]) })
    outbox.dispose()
  })
})
