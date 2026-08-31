import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { CommittedDeleteOutbox } from '../src/host/committed-delete-outbox.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { AnnotationStore } from '../src/host/store.ts'
import { documentHash, selectedTextHash } from '../src/protocol/index.ts'

function dshSource(text: string) {
  return {
    sourceType: 'dsh-message' as const,
    selectedText: text,
    locator: {
      profileId: 'web', sessionId: 'source', anchorId: `anchor-${text}`, role: 'user' as const,
      occurrence: 0, selectedTextHash: selectedTextHash(text),
    },
  }
}

function obsidianSource() {
  const selectedText = '双向引用'
  const markdown = `${selectedText} ^dsh-note-owned\n`
  return {
    sourceType: 'obsidian-note' as const,
    selectedText,
    locator: {
      vaultId: 'vault', notePath: 'note.md', blockId: 'dsh-note-owned', occurrence: 0,
      selectedTextHash: selectedTextHash(selectedText),
    },
    snapshot: { markdown, documentHash: documentHash(markdown), capturedAt: 1, freshness: 'captured' as const },
  }
}

async function commit(store: AnnotationStore, references: Array<{ id: string; source: ReturnType<typeof dshSource> | ReturnType<typeof obsidianSource> }>) {
  let revision = 0
  for (const [index, reference] of references.entries()) {
    const added = await store.addReference('session', {
      expectedRevision: revision,
      operationId: `operation-${index}`,
      setId: 'set-1',
      referenceId: reference.id,
      source: reference.source,
      createdAt: index + 1,
    })
    revision = added.revision
  }
  const pending = store.readPending('session').pending!
  const locked = await store.lockPendingForSubmission('session', {
    expectedRevision: revision,
    setId: pending.setId,
    referenceRevision: pending.revision,
  })
  await store.completePendingCommit('session', {
    expectedRevision: locked.revision,
    setId: pending.setId,
    committedAt: 10,
    userMessageId: 'message-1',
    userAnchorId: 'message-1',
    userTextHash: `sha256:${'1'.repeat(64)}`,
  })
}

describe('committed bidirectional reference deletion', () => {
  it('keeps surviving sent numbers stable and makes repeated deletion idempotent', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await commit(store, [
      { id: 'reference-1', source: dshSource('first') },
      { id: 'reference-2', source: dshSource('second') },
    ])

    const first = await store.deleteReferenceLink('session', {
      expectedRevision: store.read('session').revision,
      setId: 'set-1', referenceId: 'reference-1', deletedAt: 20,
    })
    expect(first).toMatchObject({ deleted: true, scope: 'sent' })
    expect(store.readSentSet('session', 'set-1')?.items).toEqual([
      expect.objectContaining({ referenceId: 'reference-2', number: 2 }),
    ])
    await expect(store.deleteReferenceLink('session', {
      expectedRevision: 0,
      setId: 'set-1', referenceId: 'reference-1', deletedAt: 21,
    })).resolves.toMatchObject({ deleted: false, scope: 'sent' })
  })

  it('acknowledges an already-absent committed relation without changing state', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const before = store.read('session')

    await expect(store.deleteReferenceLink('session', {
      expectedRevision: 99,
      setId: 'set-already-gone', referenceId: 'reference-already-gone', deletedAt: 20,
    })).resolves.toEqual({ revision: before.revision, deleted: false, scope: 'sent' })
    expect(store.read('session')).toEqual(before)
  })

  it('keeps reference identity protection when an absent target points at another live set', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await commit(store, [{ id: 'reference-1', source: dshSource('first') }])

    await expect(store.deleteReferenceLink('session', {
      expectedRevision: store.read('session').revision,
      setId: 'set-wrong', referenceId: 'reference-1', deletedAt: 20,
    })).rejects.toThrow('Live reference identity does not match the requested set')
    expect(store.readSentSet('session', 'set-1')?.items).toHaveLength(1)
  })

  it('persists cross-app cleanup until the source adapter acknowledges it', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await commit(store, [{ id: 'reference-1', source: obsidianSource() }])
    await store.deleteReferenceLink('session', {
      expectedRevision: store.read('session').revision,
      setId: 'set-1', referenceId: 'reference-1', deletedAt: 20,
    })
    expect(store.readSentSet('session', 'set-1')).toBeUndefined()
    expect(store.listCommittedDeleteJobs('session')).toHaveLength(1)

    const sources = new HostSourceRegistry(new Context())
    const deleteCommitted = vi.fn(async () => undefined)
    sources.registerSourceAdapter('obsidian-note', { prepare: async (item) => item, deleteCommitted })
    const outbox = new CommittedDeleteOutbox(store, sources, { retryDelayMs: 60_000 })
    await outbox.runPending('session')

    expect(deleteCommitted).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session', setId: 'set-1', referenceId: 'reference-1', deletedAt: 20,
    }))
    expect(store.listCommittedDeleteJobs('session')).toEqual([])
    outbox.dispose()
  })

  it('keeps the DSH relation deleted while failed source cleanup retries in the background', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await commit(store, [{ id: 'reference-1', source: obsidianSource() }])
    await store.deleteReferenceLink('session', {
      expectedRevision: store.read('session').revision,
      setId: 'set-1', referenceId: 'reference-1', deletedAt: 20,
    })

    const sources = new HostSourceRegistry(new Context())
    const deleteCommitted = vi.fn(async () => { throw new Error('Obsidian is temporarily offline') })
    sources.registerSourceAdapter('obsidian-note', { prepare: async (item) => item, deleteCommitted })
    const outbox = new CommittedDeleteOutbox(store, sources, { retryDelayMs: 60_000, now: () => 30 })
    await outbox.runPending('session')

    expect(store.readSentSet('session', 'set-1')).toBeUndefined()
    expect(store.listCommittedDeleteJobs('session')).toEqual([
      expect.objectContaining({ state: 'pending', attempts: 1, lastError: 'Obsidian is temporarily offline' }),
    ])
    outbox.dispose()
  })
})
