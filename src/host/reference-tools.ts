import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { acceptanceRegistry } from './input-acceptance.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ReferenceSet } from '../domain/model.ts'
import { ReferenceSetSchema, type AnnotationStore } from './store.ts'
import { canonicalJson, canonicalSha256, parseSerializedAnnotationContext } from '../protocol/index.ts'
import type { HostSourceRegistry } from './source-registry.ts'
import { upstreamOf } from './upstream.ts'
import { UpstreamToolBudgets, type NativeUpstreamUsage } from './upstream-budget.ts'
import { registerUpstreamTools } from './upstream-tools.ts'

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
  const inputIds = acceptanceRegistry(agent.ctx)?.activeInputIds(agent) ?? []
  for (const id of inputIds) {
    const journal = store.readSubmissionJournal(sessionId, id)
    if (journal?.preparedSet === undefined || journal.contextMessageId === undefined || !inputIds.includes(journal.contextMessageId)) continue
    if (!sets.has(journal.preparedSet.setId)) sets.set(journal.preparedSet.setId, journal.preparedSet)
  }
  return [...sets.values()].map(set => ({ ...set, items: set.items.filter(item =>
    store.readDeletedReference(sessionId, item.referenceId)?.setId !== set.setId) }))
}

/** Count already admitted material once for this user turn, including envelope escaping. */
export function currentInitialUpstreamBytes(store: AnnotationStore, agent: Agent): number {
  const sets = new Map<string, ReferenceSet>()
  // A managed provider can start before the annotation event reaches the journal.
  const inputIds = acceptanceRegistry(agent.ctx)?.activeInputIds(agent) ?? []
  for (const id of inputIds) {
    const journal = store.readSubmissionJournal(agent.session.id,id)
    if (journal?.preparedSet && journal.contextMessageId && inputIds.includes(journal.contextMessageId))
      sets.set(journal.preparedSet.setId,journal.preparedSet)
  }
  const events = agent.session.snapshotEvents()
  const start = events.findLastIndex(event => event.type === 'turn/start')
  for (const event of events.slice(start < 0 ? events.length : start)) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'dsh-annotation') continue
    const journal = store.readSubmissionJournal(agent.session.id,event.data.source.targetUserMessageId)
    if (journal?.preparedSet) sets.set(journal.preparedSet.setId,journal.preparedSet)
  }
  return [...sets.values()].flatMap(set => set.items).reduce((bytes,item) => bytes +
    (item.sourceType === 'dsh-message' && item.initialContext ? Buffer.byteLength(canonicalJson(item.initialContext)) : 0),0)
}

/** Register read-only tools in the normal DSH policy and result pipeline. */
export function registerReferenceTools(ctx: Context, store: AnnotationStore, sources: HostSourceRegistry): void {
  const upstreamBudgets = new UpstreamToolBudgets(sessionId => {
    const runtime = ctx.get('dshRuntimeSupport' as never) as unknown as {
      readonly apiVersion: number
      contextUsageFor?(sessionId: string): NativeUpstreamUsage | undefined
    } | undefined
    return runtime?.apiVersion === 1 ? runtime.contextUsageFor?.(sessionId) : undefined
  }, agent => currentInitialUpstreamBytes(store,agent))
  registerUpstreamTools(ctx, store, upstreamBudgets)
  ctx.inject(['tools'], toolCtx => {
    const list = defineTool({
      name: 'dsh_reference_list',
      description: 'List references submitted in this conversation. Unsent drafts are excluded.',
      parameters: { after: { type: 'string', description: 'Opaque nextCursor returned by the preceding list page.' } },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('A conversation is required')
        const all = availableReferenceSets(store, exec.agent).flatMap(set => set.items.map(item => ({
          setId: set.setId, referenceId: item.referenceId, sourceType: item.sourceType,
          selectedText: item.selectedText.slice(0, 180), backlinkState: item.backlinkState,
          ...(upstreamOf(item) ? { context: 'fixed-upstream', readTool: 'dsh_upstream_read', searchTool: 'dsh_upstream_search' } : {}),
        })))
        const start = args.after ? all.findIndex(item => `${item.setId}:${item.referenceId}` === args.after) + 1 : 0
        if (args.after && start === 0) throw new Error('Reference list cursor is no longer available')
        const allowance = all.some(item => 'context' in item) ? upstreamBudgets.reserve(exec.agent) : undefined
        let output: string | undefined
        try {
          const items: typeof all = []
          let i = start
          while (i < all.length && items.length < 20) {
            const candidate = [...items, all[i]!]
            if (Buffer.byteLength(JSON.stringify(candidate)) + 700 > (allowance?.bytes ?? 8000)) break
            items.push(all[i++]!)
          }
          const last = items.at(-1)
          output = JSON.stringify({ items, hasMore: i < all.length,
            nextCursor: i < all.length && last ? `${last.setId}:${last.referenceId}` : null })
          return output
        } finally { allowance?.settle(output) }
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
        const upstream = upstreamOf(item)
        if (upstream) {
          if (args.mode === 'refresh') throw new Error('固定上游不能刷新成最新会话；请使用 dsh_upstream_read 或 dsh_upstream_search')
          const allowance = upstreamBudgets.reserve(exec.agent)
          let output: string | undefined
          try {
            output = JSON.stringify({ setId: set!.setId, referenceId: item.referenceId,
              selectedText: item.selectedText.slice(0, 400), previewOnly: true, upstream,
              readTool: 'dsh_upstream_read', searchTool: 'dsh_upstream_search' })
            return output
          } finally { allowance.settle(output) }
        }
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

  })
}
