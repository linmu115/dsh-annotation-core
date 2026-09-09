import type { Context } from '@deepseek-ai/cordis'
import { readExecutionState, type Agent, type DeliveryRecord } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-executor-tool-bridge'
import type { ReferenceSet } from '../domain/model.ts'
import { ReferenceSetSchema, type AnnotationStore } from './store.ts'
import { canonicalSha256, parseSerializedAnnotationContext } from '../protocol/index.ts'
import type { HostSourceRegistry } from './source-registry.ts'

/** Read submitted snapshots and the calling execution's exact prepared batch. */
export function availableReferenceSets(store: AnnotationStore, agent: Agent): readonly ReferenceSet[] {
  const sessionId = agent.session.id
  const sets = new Map(store.listSentForSession(sessionId).map(set => [set.setId, set]))
  for (const event of agent.session.snapshotEvents().slice(0, agent.session.inheritedEventCount)) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'dsh-annotation') continue
    const source = event.data.source
    if (sets.has(source.setId)) continue
    const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
    const parsed = parseSerializedAnnotationContext(text)
    if (canonicalSha256({ schemaVersion: 1, setId: source.setId, annotations: parsed.annotations.items, documents: parsed.documents.documents }) !== source.digest)
      throw new Error('Inherited reference snapshot digest does not match its source')
    const items = parsed.annotations.items.map(item => {
      const document = parsed.documents.documents.find(value => value.key === item.documentKey)
      return { ...item, backlinkState: 'not-required', ...(item.sourceType !== 'obsidian-note' ? {} : {
        snapshot: { markdown: document?.markdown, documentHash: document?.documentHash, capturedAt: event.time, freshness: 'captured' },
      }) }
    })
    sets.set(source.setId, ReferenceSetSchema.parse({ schemaVersion: 1, setId: source.setId,
      profileId: store.read(sessionId).profileId, sessionId: agent.session.header.parentSession ?? sessionId,
      state: 'sent', revision: 0, items, createdAt: event.time, userMessageId: source.targetUserMessageId }) as ReferenceSet)
  }
  const active = readExecutionState(agent.session).active
  if (active != null) {
    const deliveries = new Map<string, DeliveryRecord>()
    for (const event of agent.session.snapshotEvents().slice(agent.session.inheritedEventCount)) {
      if (event.type !== 'agent/execution-record' || event.data.record.kind !== 'delivery') continue
      const delivery = event.data.record.delivery
      if (delivery.executionId === active.executionId && delivery.generation === active.generation) deliveries.set(delivery.id, delivery)
    }
    for (const delivery of deliveries.values()) {
      if (delivery.phase === 'rejected') continue
      for (const id of delivery.inputMessageIds) {
        const journal = store.readSubmissionJournal(sessionId, id)
        if (journal?.preparedSet === undefined || journal.contextMessageId === undefined ||
          !delivery.inputMessageIds.some(messageId => messageId === journal.contextMessageId)) continue
        if (!sets.has(journal.preparedSet.setId)) sets.set(journal.preparedSet.setId, journal.preparedSet)
      }
    }
  }
  return [...sets.values()].map(set => ({ ...set, items: set.items.filter(item =>
    store.readDeletedReference(sessionId, item.referenceId)?.setId !== set.setId) }))
}

/** Register read-only tools in the normal DSH policy and result pipeline. */
export function registerReferenceTools(ctx: Context, store: AnnotationStore, sources: HostSourceRegistry): void {
  ctx.inject(['tools'], toolCtx => {
    const list = defineTool({
      name: 'dsh_reference_list',
      description: 'List references submitted in this conversation. Unsent drafts are excluded.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute(_args, exec) {
        if (exec.agent === undefined) throw new Error('A conversation is required')
        return JSON.stringify(availableReferenceSets(store, exec.agent).flatMap(set => set.items.map(item => ({
          setId: set.setId, referenceId: item.referenceId, sourceType: item.sourceType,
          selectedText: item.selectedText, backlinkState: item.backlinkState,
        }))))
      },
    })
    const read = defineTool({
      name: 'dsh_reference_read',
      description: 'Read a listed reference snapshot, or refresh it from its original source without changing the submitted snapshot.',
      parameters: {
        setId: { type: 'string', required: true },
        referenceId: { type: 'string', required: true },
        mode: { type: 'string', enum: ['snapshot', 'refresh'], required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('A conversation is required')
        const set = availableReferenceSets(store, exec.agent).find(set => set.setId === args.setId)
        const item = set?.items.find(reference => reference.referenceId === args.referenceId)
        if (item === undefined) throw new Error('Reference is unavailable in this conversation')
        if (args.mode === 'refresh' && set?.sessionId !== exec.agent.id) throw new Error('Inherited references expose their saved snapshot only')
        const value = args.mode === 'refresh' ? await sources.prepare(item, exec.signal) : item
        exec.signal.throwIfAborted()
        if (store.readDeletedReference(exec.agent.session.id, item.referenceId)?.setId === args.setId)
          throw new Error('Reference was deleted while reading')
        return JSON.stringify({ setId: args.setId, mode: args.mode, item: value })
      },
    })
    toolCtx.tools.register(list)
    toolCtx.tools.register(read)
    toolCtx.inject(['executorToolBridge'], bridgeCtx => {
      for (const toolName of ['dsh_reference_list', 'dsh_reference_read']) {
        bridgeCtx.executorToolBridge.register(bridgeCtx, { key: toolName, toolName, version: '1', effect: 'read' })
      }
    })
  })
}
