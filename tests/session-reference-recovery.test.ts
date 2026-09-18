import { collectReferenceDocuments } from '../src/domain/budget.ts'
import { availableReferenceSets } from '../src/host/reference-tools.ts'
import { expect, it } from 'vitest'
import { AnnotationStore } from '../src/host/store.ts'
import { restoreSessionReferences } from '../src/host/session-reference-recovery.ts'
import { documentHash, selectedTextHash, serializePreparedReferenceSet } from '../src/protocol/index.ts'
import type { ReferenceSet } from '../src/domain/model.ts'

function fixture() {
  const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
  const set: ReferenceSet = { schemaVersion: 1, setId: 'set', profileId: 'web', sessionId: 'old-native', state: 'sent',
    revision: 1, createdAt: 1, userMessageId: 'message', items: [{ referenceId: 'ref', number: 1,
      sourceType: 'dsh-message', selectedText: 'quoted', userComment: 'my comment', backlinkState: 'not-required',
      locator: { profileId: 'web', sessionId: 'source', anchorId: 'anchor', role: 'assistant', occurrence: 0, selectedTextHash: selectedTextHash('quoted') } }] }
  const serialized = serializePreparedReferenceSet(set, [])
  const events: any[] = [
    { type: 'user/message', seq: 0, time: 2, data: { id: 'message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ask' }] } },
    { type: 'user/message', seq: 1, time: 3, data: { id: 'context', role: 'user', source: { kind: 'dsh-annotation', setId: 'set',
      targetUserMessageId: 'message', digest: serialized.digest }, content: [{ type: 'text', text: serialized.text }] } },
  ]
  const agent = { id: 'new-native', session: { inheritedEventCount: 0, snapshotEvents: () => events } } as any
  return { store, set, events, agent }
}
it('restores a restarted derived session with zero inherited events, without generating an admission or backlink', async () => {
  const f = fixture()
  await f.store.table.put('web:old-native', { ...f.store.read('old-native'), sentSets: [f.set] })
  await restoreSessionReferences(f.store, f.agent)
  const saved = f.store.read('new-native')
  expect(saved.sentSets[0]).toMatchObject({ sessionId: 'new-native', userMessageId: 'message', items: [{ selectedText: 'quoted', userComment: 'my comment' }] })
  expect(saved.admissions).toEqual({}); expect(saved.backlinkJobs).toEqual({})
  await restoreSessionReferences(f.store, f.agent)
  expect(f.store.read('new-native').revision).toBe(saved.revision)
  expect((await f.store.referenceDirectory.listEntries({ nativeSessionId: 'new-native' })).items[0]).toHaveProperty('targetMessageId', 'message')
})
it('never restores without the matching user message or with a changed digest', async () => {
  const f = fixture(); f.events.shift()
  await restoreSessionReferences(f.store, f.agent); expect(f.store.listSentForSession('new-native')).toEqual([])
  const g = fixture(); g.events[1].data.source.digest = 'tampered'
  await expect(restoreSessionReferences(g.store, g.agent)).rejects.toThrow('digest')
})
it('preserves positive deletion records from the original saved set', async () => {
  const f = fixture()
  await f.store.table.put('web:old-native', { ...f.store.read('old-native'), sentSets: [f.set], deletedReferences: {
    ref: { referenceId: 'ref', setId: 'set', scope: 'sent', sourceType: 'dsh-message', deletedAt: 4 },
  } })
  await restoreSessionReferences(f.store, f.agent)
  expect(f.store.listSentForSession('new-native')[0]?.items).toEqual([])
  expect(f.store.resolveReferenceLink('new-native', 'ref')?.state).toBe('deleted')
})

it('restores Obsidian document snapshots without leaking serialized document keys into stored items', async () => {
  const f = fixture()
  const markdown = '# source\nquoted'
  const set: ReferenceSet = { ...f.set, items: [{ referenceId: 'ref', number: 1, sourceType: 'obsidian-note',
    selectedText: 'quoted', userComment: 'my comment', backlinkState: 'written',
    locator: { vaultId: 'vault', notePath: 'note.md', blockId: 'block', occurrence: 0, selectedTextHash: selectedTextHash('quoted') },
    snapshot: { markdown, documentHash: documentHash(markdown), capturedAt: 1, freshness: 'captured' } }] }
  const serialized = serializePreparedReferenceSet(set, collectReferenceDocuments(set))
  f.events[1].data.source.digest = serialized.digest
  f.events[1].data.content[0].text = serialized.text
  f.agent.ctx = { get: () => undefined }; f.agent.session.id = f.agent.id; f.agent.session.header = {}
  expect(availableReferenceSets(f.store, f.agent)[0]?.items[0]).toMatchObject({ snapshot: { markdown } })
  await f.store.table.put('web:old-native', { ...f.store.read('old-native'), sentSets: [set] })
  await restoreSessionReferences(f.store, f.agent)
  expect(f.store.read('new-native').sentSets[0]?.items[0]).toMatchObject({ backlinkState: 'written', snapshot: { markdown }, userComment: 'my comment' })
  expect(f.store.read('new-native').sentSets[0]?.items[0]).not.toHaveProperty('documentKey')
})
