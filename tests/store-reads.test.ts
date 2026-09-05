import { describe, expect, it } from 'vitest'
import { AnnotationStore } from '../src/host/store.ts'
import { selectedTextHash } from '../src/protocol/index.ts'

async function fixture() {
  const table = AnnotationStore.memoryTable()
  const store = new AnnotationStore(table, { profileId: 'web' })
  await store.addReference('session', {
    expectedRevision: 0, operationId: 'op', setId: 'set', referenceId: 'ref', createdAt: 1,
    source: { sourceType: 'dsh-message', selectedText: 'selected', locator: {
      profileId: 'web', sessionId: 'source', anchorId: 'anchor', role: 'user', occurrence: 0,
      selectedTextHash: selectedTextHash('selected'),
    } },
  })
  return { table, store, aggregate: table.get('web:session')! }
}

describe('narrow store reads', () => {
  it.each([0, 100, 1000])('does not visit unrelated history for pending reads with %i historical entries', async (count) => {
    const { store, aggregate } = await fixture()
    const historical = Array.from({ length: count }, () => ({ ...aggregate.pending!, state: 'sent' as const }))
    let visits = 0
    Object.defineProperty(aggregate, 'sentSets', { enumerable: true, get() { visits++; return historical } })
    for (let i = 0; i < 30; i++) {
      expect(store.readPendingState('session')).toEqual({ revision: 1, pendingCount: 1 })
      expect(store.readPending('session').pending?.setId).toBe('set')
    }
    expect(visits).toBe(0)
    store.close()
  })

  it('returns detached pending and history snapshots without cloning unrelated state', async () => {
    const { store, aggregate } = await fixture()
    const pending = store.readPending('session').pending!
    Object.assign(pending.items[0]!, { selectedText: 'changed' })
    expect(store.readPending('session').pending?.items[0]?.selectedText).toBe('selected')
    Object.assign(aggregate, { sentSets: [{ ...aggregate.pending!, state: 'sent' }] })
    const sent = store.readSentSet('session', 'set')!
    Object.assign(sent.items[0]!, { selectedText: 'changed' })
    expect(store.listSentForSession('session')[0]?.items[0]?.selectedText).toBe('selected')
    const all = store.read('session'); Object.assign(all, { sentSets: [] })
    expect(store.listSentForSession('session')).toHaveLength(1)
    store.close()
  })

  it('reads admissions, journals and durable task lanes independently of sent history', async () => {
    const { store, aggregate } = await fixture()
    Object.defineProperty(aggregate, 'sentSets', { enumerable: true, get() { throw new Error('unrelated history visited') } })
    expect(store.readAdmission('session', 'missing')).toBeUndefined()
    expect(store.readSubmissionJournal('session', 'missing')).toBeUndefined()
    expect(store.listPendingDiscardJobs('session')).toEqual([])
    expect(store.listCommittedDeleteJobs('session')).toEqual([])
    expect(store.listBacklinkJobs('session')).toEqual([])
    store.close()
  })

  it('keeps revision waiters and writes consistent with lightweight summaries', async () => {
    const { store } = await fixture()
    const waiter = store.waitRevision('session', 1)
    await store.updateComment('session', { expectedRevision: 1, referenceId: 'ref', comment: 'new' })
    const changed = await waiter
    expect(changed.revision).toBe(2)
    expect(store.readPendingState('session')).toEqual({ revision: 2, pendingCount: 1 })
    Object.assign(changed.pending!.items[0]!, { userComment: 'external' })
    expect(store.readPending('session').pending?.items[0]?.userComment).toBe('new')
    store.close()
    expect(() => store.readPendingState('session')).toThrow()
    expect(() => store.readPending('session')).toThrow()
  })
})
