import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AnnotationStore, type SessionAggregate } from '../src/host/store.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import type { ReferenceItem, ReferenceSet } from '../src/domain/model.ts'
import { selectedTextHash } from '../src/protocol/index.ts'
import { referenceDirectoryChanged } from '../src/host/reference-directory.ts'
import { AnnotationCoreRemoteService } from '../src/remote/service.ts'
import { documentHash, type ReferenceSource } from '../src/protocol/index.ts'

function item(referenceId = 'reference-1'): Extract<ReferenceItem, { sourceType: 'dsh-message' }> {
  return { referenceId, number: 1, selectedText: 'selected', userComment: 'comment', backlinkState: 'not-required',
    sourceType: 'dsh-message', locator: { profileId: 'web', sessionId: 'source-native', anchorId: 'anchor', role: 'assistant',
      occurrence: 0, selectedTextHash: selectedTextHash('selected') } }
}
function set(items: readonly ReferenceItem[], state: ReferenceSet['state'] = 'pending', setId = 'set-1'): ReferenceSet {
  return { schemaVersion: 1, setId, profileId: 'web', sessionId: 'target', state, revision: 1, items, createdAt: 1 }
}
async function seed(store: AnnotationStore, patch: Partial<SessionAggregate>, nativeSessionId = 'target') {
  await store.table.put(`${store.options.profileId}:${nativeSessionId}`, { ...store.read(nativeSessionId), ...patch })
}
function add(store: AnnotationStore, nativeSessionId = 'target', referenceId = 'new-reference') {
  const source = item(referenceId)
  return store.addReference(nativeSessionId, { expectedRevision: store.readPendingState(nativeSessionId).revision,
    operationId: `add-${referenceId}`, setId: store.readPending(nativeSessionId).pending?.setId ?? 'set-1', referenceId,
    source: { sourceType: 'dsh-message', selectedText: source.selectedText, locator: source.locator }, createdAt: 1 })
}

describe('bounded host reference directory', () => {
  it('exports current set states and positive tombstones, without resurrecting replaced items', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await seed(store, { revision: 9, pending: set([item('pending'), item('deleted')]), sentSets: [set([item('sent')], 'sent', 'sent-set')],
      deletedReferences: { deleted: { referenceId: 'deleted', setId: 'set-1', scope: 'pending', sourceType: 'dsh-message', deletedAt: 8 },
        'orphan-tombstone': { referenceId: 'orphan-tombstone', setId: 'old-set', scope: 'sent', sourceType: 'obsidian-note', deletedAt: 7 } },
      restoredGraphReferences: { 'restored-grant': item('restored-grant') } })
    const page = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    expect(page.sourceRevision).toBe(9)
    expect(page.items.map(entry => [entry.referenceId, entry.state])).toEqual([
      ['deleted', 'deleted'], ['orphan-tombstone', 'deleted'], ['pending', 'pending'], ['sent', 'sent'],
    ])
    expect(page.items[1]).toEqual({ referenceId: 'orphan-tombstone', setId: 'old-set', sourceType: 'obsidian-note', state: 'deleted', selectedText: '', userComment: '', source: {} })
    expect(page.nextCursor).toBeNull()
  })

  it.each(['committing', 'failed'] as const)('preserves %s without relabeling it as sent', async state => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await seed(store, { pending: set([item()], state) })
    expect((await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).items[0]?.state).toBe(state)
  })

  it('caps text and comments, keeps the distinct upstream ID, and never exports snapshots or journals', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const dsh = item('local-item-id')
    if (dsh.sourceType !== 'dsh-message') throw new Error('fixture')
    const upstream: ReferenceItem = { ...dsh, selectedText: 'x'.repeat(4100), userComment: 'y'.repeat(2100), locator: { ...dsh.locator,
      upstream: { kind: 'fixed-upstream', referenceId: 'authority-upstream-id', sourceTitle: 'source title', sourceVersionId: 'version', cutoffEventId: 'event', targetSessionId: 'target' } } }
    const note: ReferenceItem = { referenceId: 'note', number: 2, sourceType: 'obsidian-note', selectedText: 'note excerpt', userComment: '', backlinkState: 'pending',
      locator: { vaultId: 'vault', notePath: 'folder/note.md', blockId: 'block', occurrence: 0, selectedTextHash: selectedTextHash('note excerpt') },
      snapshot: { markdown: 'PRIVATE-SNAPSHOT-MUST-NOT-EXPORT', capturedAt: 1, documentHash: 'sha256:' + '0'.repeat(64), freshness: 'captured' } }
    await seed(store, { pending: set([upstream, note]) })
    vi.spyOn(store, 'read').mockImplementation(() => { throw new Error('Whole aggregate clone forbidden') })
    const page = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    expect(page.items[0]).toMatchObject({ referenceId: 'local-item-id', selectedText: 'x'.repeat(4000), userComment: 'y'.repeat(2000), truncated: true,
      source: { nativeSessionId: 'source-native', upstreamReferenceId: 'authority-upstream-id', title: 'source title' } })
    expect(page.items[1]?.source).toEqual({ vaultId: 'vault', notePath: 'folder/note.md', anchorId: 'block' })
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE-SNAPSHOT|snapshot|submissionJournal|initialContext|contentDigest/)
  })

  it('paginates session headers and items in stable order with a hard 50 item maximum', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    for (let i = 54; i >= 0; i--) await seed(store, { revision: i, pending: set([item()]) }, `session-${String(i).padStart(2, '0')}`)
    const first = await store.referenceDirectory.listSessions()
    expect(first.items).toHaveLength(50)
    const second = await store.referenceDirectory.listSessions({ after: first.nextCursor! })
    expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(entry => entry.nativeSessionId)).size).toBe(55)
    await seed(store, { revision: 10, pending: set(Array.from({ length: 53 }, (_, i) => item(`ref-${String(i).padStart(2, '0')}`))) })
    const refs = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    const next = await store.referenceDirectory.listEntries({ nativeSessionId: 'target', after: refs.nextCursor! })
    expect(refs.items).toHaveLength(50); expect(next.items).toHaveLength(3); expect(next.sourceRevision).toBe(10)
    await expect(store.referenceDirectory.listSessions({ limit: 51 })).rejects.toThrow('50')
  })

  it('rejects changed page revisions and foreign cursors instead of skipping a changed prefix', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await seed(store, { revision: 1, pending: set([item('b'), item('c')]) })
    const page = await store.referenceDirectory.listEntries({ nativeSessionId: 'target', limit: 1 })
    await add(store, 'target', 'a')
    await expect(store.referenceDirectory.listEntries({ nativeSessionId: 'target', after: page.nextCursor! }))
      .rejects.toMatchObject({ name: 'AnnotationDirectoryChangedError' })
    await seed(store, { revision: 1 }, 'z')
    const sessions = await store.referenceDirectory.listSessions({ limit: 1 })
    await seed(store, { revision: 1 }, 'a')
    await expect(store.referenceDirectory.listSessions({ after: sessions.nextCursor! })).rejects.toMatchObject({ name: 'AnnotationDirectoryChangedError' })
    await expect(store.referenceDirectory.listEntries({ nativeSessionId: 'another', after: page.nextCursor! })).rejects.toThrow('游标')
  })

  it('notifies only after durable writes and isolates a failing observer from the committing caller', async () => {
    const table = AnnotationStore.memoryTable(), original = table.put.bind(table)
    let release!: () => void
    table.put = async (key, value) => { await new Promise<void>(resolve => { release = resolve }); await original(key, value) }
    const store = new AnnotationStore(table, { profileId: 'web' }), observed: unknown[] = []
    const off = store.referenceDirectory.subscribe(change => { observed.push(change); expect(store.readPendingState(change.nativeSessionId).revision).toBe(change.sourceRevision) })
    store.referenceDirectory.subscribe(() => { throw new Error('observer fails') })
    const pending = add(store)
    await Promise.resolve(); await Promise.resolve()
    expect(observed).toEqual([])
    release(); await pending
    expect(observed).toEqual([{ nativeSessionId: 'target', sourceRevision: 1 }])
    off()
    await store.deleteReferenceLink('target', { expectedRevision: 1, setId: 'set-1', referenceId: 'new-reference', deletedAt: 2 })
    expect(observed).toHaveLength(1)
    expect((await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).items[0]?.state).toBe('deleted')
  })

  it('does not notify a failed durable write and recovers current entries after reopen without an outbox', async () => {
    const table = AnnotationStore.memoryTable(), store = new AnnotationStore(table, { profileId: 'web' }), listener = vi.fn()
    const put = table.put.bind(table)
    table.put = async () => { throw new Error('disk unavailable') }
    store.referenceDirectory.subscribe(listener)
    await expect(add(store)).rejects.toThrow('disk unavailable'); expect(listener).not.toHaveBeenCalled()
    table.put = put; await add(store); store.close()
    const reopened = new AnnotationStore(table, { profileId: 'web' })
    expect((await reopened.referenceDirectory.listSessions()).items).toEqual([{ nativeSessionId: 'target', sourceRevision: 1 }])
    expect((await reopened.referenceDirectory.listEntries({ nativeSessionId: 'target' })).items).toHaveLength(1)
    expect((await new AnnotationStore(table, { profileId: 'other' }).referenceDirectory.listSessions()).items).toEqual([])
  })

  it('exposes the optional host capability and honors cancelled/disposed reads', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const registry = new HostSourceRegistry(new Context(), { referenceDirectory: store.referenceDirectory })
    expect(registry.referenceDirectory).toBe(store.referenceDirectory)
    const controller = new AbortController(); controller.abort()
    await expect(store.referenceDirectory.listSessions({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    store.close()
    await expect(store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).rejects.toThrow('disposed')
  })

  it('keeps a legacy directory page valid across journal-only writes and reopening', async () => {
    const table = AnnotationStore.memoryTable(), store = new AnnotationStore(table, { profileId: 'web' })
    await seed(store, { revision: 20, pending: set([item('a'), item('b')]) })
    const listener = vi.fn(); store.referenceDirectory.subscribe(listener)
    const first = await store.referenceDirectory.listEntries({ nativeSessionId: 'target', limit: 1 })
    const journal = { expectedRevision: 20, userMessageId: 'plain-user', clientSubmissionId: 'plain-submit',
      requestDigest: 'sha256:' + '0'.repeat(64), createdAt: 1 }
    await store.recordSubmissionJournal('target', journal)
    expect(store.readPendingState('target').revision).toBe(21)
    expect(store.read('target').directoryRevision).toBe(20)
    expect(listener).not.toHaveBeenCalled()
    const next = await store.referenceDirectory.listEntries({ nativeSessionId: 'target', after: first.nextCursor! })
    expect(next.sourceRevision).toBe(20); expect(next.items.map(value => value.referenceId)).toEqual(['b'])
    // Identical startup replay uses the same version and payload acknowledged before the internal write.
    store.close()
    const reopened = new AnnotationStore(table, { profileId: 'web' })
    expect((await reopened.referenceDirectory.listSessions()).items).toEqual([{ nativeSessionId: 'target', sourceRevision: 20 }])
    expect(await reopened.referenceDirectory.listEntries({ nativeSessionId: 'target', limit: 1 })).toEqual(first)
    await reopened.recordSubmissionJournal('target', journal)
    expect(reopened.readPendingState('target').revision).toBe(21)
    await reopened.updateComment('target', { expectedRevision: 21, referenceId: 'a', comment: 'visible change' })
    expect((await reopened.referenceDirectory.listEntries({ nativeSessionId: 'target' })).sourceRevision).toBe(22)
    await expect(reopened.referenceDirectory.listEntries({ nativeSessionId: 'target', after: first.nextCursor! }))
      .rejects.toMatchObject({ name: 'AnnotationDirectoryChangedError' })
  })

  it('does not announce backlink job, retry or reconciliation changes as new directory entries', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await add(store)
    const before = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    const listener = vi.fn(); store.referenceDirectory.subscribe(listener)
    await store.enqueueBacklink('target', { expectedRevision: 1, setId: 'set-1', referenceId: 'new-reference', createdAt: 2 })
    await store.recordBacklinkResult('target', { expectedRevision: 2, setId: 'set-1', referenceId: 'new-reference', error: 'retry later', updatedAt: 3 })
    await store.retryBacklink('target', { expectedRevision: 3, setId: 'set-1', referenceId: 'new-reference', updatedAt: 4 })
    await store.recordFlushReconciliation('target', { expectedRevision: 4, userMessageId: 'plain-user', userObserved: true,
      contextObserved: false, flushState: 'durable', updatedAt: 5 })
    expect(store.readPendingState('target').revision).toBe(5)
    expect(listener).not.toHaveBeenCalled()
    expect(await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).toEqual(before)
    await store.deleteReferenceLink('target', { expectedRevision: 5, setId: 'set-1', referenceId: 'new-reference', deletedAt: 6 })
    const deleted = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    expect(deleted.sourceRevision).toBe(6)
    expect(deleted.items[0]).toMatchObject({ state: 'deleted', selectedText: '', source: {} })
    expect(listener).toHaveBeenCalledOnce()
    await store.deleteReferenceLink('target', { expectedRevision: 6, setId: 'set-1', referenceId: 'new-reference', deletedAt: 7 })
    expect(await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).toEqual(deleted)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('does not revise unchanged bounded excerpts, but revises visible states', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await seed(store, { revision: 10, pending: set([{ ...item(), userComment: 'x'.repeat(2000) + 'first tail' }]) })
    const before = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    const listener = vi.fn(); store.referenceDirectory.subscribe(listener)
    await store.updateComment('target', { expectedRevision: 10, referenceId: 'reference-1', comment: 'x'.repeat(2000) + 'second tail' })
    expect(store.readPendingState('target').revision).toBe(11)
    expect(await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).toEqual(before)
    expect(listener).not.toHaveBeenCalled()
    await store.lockPendingForSubmission('target', { expectedRevision: 11, setId: 'set-1', referenceRevision: 2 })
    expect((await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).items[0]?.state).toBe('committing')
    expect(listener).toHaveBeenCalledWith({ nativeSessionId: 'target', sourceRevision: 12 })
  })

  it('skips internal-only collections and fingerprints bounded fields without reading snapshots', () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const source = item()
    const sensitiveItem = { ...source, get snapshot() { throw new Error('snapshot must not be read') } }
    const before = { ...store.read('target'), pending: set([sensitiveItem]) }
    expect(referenceDirectoryChanged(before, { ...before, revision: 1, submissionJournal: {} })).toBe(false)
    expect(referenceDirectoryChanged(before, { ...before, pending: { ...before.pending, revision: 2 } })).toBe(false)
    expect(referenceDirectoryChanged(before, { ...before, pending: { ...before.pending, state: 'failed' } })).toBe(true)
  })

  it.each(['dsh-message', 'obsidian-note'] as const)('exports a durable tombstone after the composer removes a %s draft', async sourceType => {
    const table = AnnotationStore.memoryTable(), store = new AnnotationStore(table, { profileId: 'web' })
    const selected = item('removed'), markdown = 'PRIVATE NOTE SNAPSHOT'
    const source: ReferenceSource = sourceType === 'dsh-message'
      ? { sourceType, selectedText: selected.selectedText, locator: selected.locator }
      : { sourceType, selectedText: selected.selectedText, locator: { vaultId: 'vault', notePath: 'note.md', blockId: 'block',
          occurrence: 0, selectedTextHash: selectedTextHash(selected.selectedText) },
        snapshot: { markdown, documentHash: documentHash(markdown), capturedAt: 1, freshness: 'captured' } }
    await store.addReference('target', { expectedRevision: 0, operationId: 'capture', setId: 'set-1', referenceId: 'removed', source, createdAt: 1 })
    await add(store, 'target', 'survivor')
    const before = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' }), listener = vi.fn()
    store.referenceDirectory.subscribe(listener)
    const service = new AnnotationCoreRemoteService(new Context(), store)
    await service.removeReference({ id: 'target' } as never, { expectedRevision: 2, referenceId: 'removed' })
    const page = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    expect(listener).toHaveBeenCalledWith({ nativeSessionId: 'target', sourceRevision: 3 })
    expect(page.items).toEqual([
      { referenceId: 'removed', setId: 'set-1', sourceType, state: 'deleted', selectedText: '', userComment: '', source: {} },
      before.items.find(value => value.referenceId === 'survivor'),
    ])
    expect(Object.keys(store.readDeletedReference('target', 'removed')!).sort())
      .toEqual(['deletedAt', 'disposition', 'referenceId', 'scope', 'setId', 'sourceType'])
    expect(store.readDeletedReference('target', 'removed')?.disposition).toBe('discard')
    const jobs = store.listPendingDiscardJobs('target')
    expect(jobs).toHaveLength(sourceType === 'obsidian-note' ? 1 : 0)
    if (jobs.length) await store.completePendingDiscard('target', { expectedRevision: 3, referenceId: 'removed' })
    expect(listener).toHaveBeenCalledOnce()
    store.close()
    const reopened = new AnnotationStore(table, { profileId: 'web' })
    expect(await reopened.referenceDirectory.listEntries({ nativeSessionId: 'target' })).toEqual(page)
    expect(JSON.stringify(page)).not.toContain(markdown)
  })

  it.each([true, false])('exports operation rollback after restart without changing source-notification policy (%s)', async notifySource => {
    const table = AnnotationStore.memoryTable(), store = new AnnotationStore(table, { profileId: 'web' })
    await add(store, 'target', 'removed'); await add(store, 'target', 'survivor')
    const listener = vi.fn(); store.referenceDirectory.subscribe(listener)
    const service = new AnnotationCoreRemoteService(new Context(), store)
    await service.discardPendingOperation({ id: 'target' } as never, { expectedRevision: 2, operationId: 'add-removed', notifySource })
    const page = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })
    expect(page.items.map(value => [value.referenceId, value.state])).toEqual([['removed', 'deleted'], ['survivor', 'pending']])
    expect(listener).toHaveBeenCalledOnce()
    await service.discardPendingOperation({ id: 'target' } as never, { expectedRevision: 3, operationId: 'add-removed', notifySource })
    expect(listener).toHaveBeenCalledOnce(); expect(store.readPendingState('target').revision).toBe(3)
    store.close()
    expect(await new AnnotationStore(table, { profileId: 'web' }).referenceDirectory.listEntries({ nativeSessionId: 'target' })).toEqual(page)
  })

  it('does not tombstone a draft retained by another committed producer operation', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await add(store)
    const selected = item('new-reference')
    await store.addReference('target', { expectedRevision: 1, operationId: 'second-producer', referenceId: 'new-reference', setId: 'set-1',
      source: { sourceType: 'dsh-message', selectedText: selected.selectedText, locator: selected.locator }, createdAt: 2 })
    const before = await store.referenceDirectory.listEntries({ nativeSessionId: 'target' }), listener = vi.fn()
    store.referenceDirectory.subscribe(listener)
    await store.discardPendingOperation('target', { expectedRevision: 2, operationId: 'add-new-reference' })
    expect(store.readDeletedReference('target', 'new-reference')).toBeUndefined()
    expect(await store.referenceDirectory.listEntries({ nativeSessionId: 'target' })).toEqual(before)
    expect(listener).not.toHaveBeenCalled()
  })
})
