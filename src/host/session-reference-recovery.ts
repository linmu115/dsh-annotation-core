import type { ReferenceSet } from '../domain/model.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AnnotationStore } from './store.ts'
import { ReferenceSetSchema } from './store.ts'
import { canonicalSha256, parseSerializedAnnotationContext, selectedTextHash } from '../protocol/index.ts'

/** Message content and its verified snapshot, not a recycled native ID, prove ownership. */
export async function restoreSessionReferences(store: AnnotationStore, agent: Agent): Promise<void> {
  const events = agent.session.snapshotEvents()
  const users = new Map(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    .map(event => { const message = (event as Extract<typeof event, { type: 'user/message' }>).data; return [String(message.id), message] }))
  let aggregates: ReturnType<AnnotationStore['read']>[] | undefined
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'dsh-annotation') continue
    const source = event.data.source, user = users.get(source.targetUserMessageId)
    if (!user || store.readSentSet(agent.id, source.setId)) continue
    const parsed = parseSerializedAnnotationContext(event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
    if (canonicalSha256({ schemaVersion: 1, setId: source.setId, annotations: parsed.annotations.items, documents: parsed.documents.documents }) !== source.digest)
      throw new Error('Persisted reference snapshot digest does not match its source')
    aggregates ??= store.sessionIds().map(id => store.read(id))
    const originals = aggregates.flatMap(value => value.sentSets).filter(set => set.setId === source.setId && set.userMessageId === source.targetUserMessageId)
    const items = parsed.annotations.items.map(item => {
      const { documentKey, ...referenceItem } = item
      const document = parsed.documents.documents.find(value => value.key === documentKey)
      const previous = originals.flatMap(set => set.items).find(value => value.referenceId === item.referenceId)
      return { ...referenceItem, backlinkState: previous?.backlinkState ?? (item.sourceType === 'obsidian-note' ? 'pending' : 'not-required'), ...(item.sourceType !== 'obsidian-note' ? {} : {
        snapshot: { markdown: document?.markdown, documentHash: document?.documentHash, capturedAt: event.time, freshness: 'captured' },
      }) }
    })
    const set = ReferenceSetSchema.parse({ schemaVersion: 1, setId: source.setId, profileId: store.options.profileId,
      sessionId: agent.id, state: 'sent', revision: 0, items, createdAt: event.time, committedAt: event.time,
      userMessageId: user.id, userAnchorId: user.id, userTextHash: selectedTextHash(user.content.map(block => block.type === 'text' ? block.text : '').join('')) }) as ReferenceSet
    await store.restoreSentSnapshot(agent.id, set, aggregates.flatMap(value => Object.values(value.deletedReferences)))
  }
}
