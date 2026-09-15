import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { canonicalJson, canonicalSha256 } from '../protocol/index.ts'
import { isNativeContextAgent, nativeContextHost, requireNativeContextAgent, type NativeContextHost } from './native-context-contract.ts'
import { NativeContextHostUnavailable, NativeSurfaceController, nativeMaterialMeta } from './native-context-surface.ts'
import type { UpstreamToolBudgets } from './upstream-budget.ts'

const string = { type: 'string' as const }
const mutation: ParameterSchemaSpec = { operationId: { ...string, required: true, description: 'Stable operation identity; reuse exactly on retry.' },
  expectedRevision: { type: 'integer', required: true }, reason: { ...string, description: 'Brief reason for this change.' } }
const reference = { referenceId: { ...string, required: true as const } }
const materialIds = { type: 'array' as const, items: string }
const statusPage: ParameterSchemaSpec = { section: { type: 'string', enum: ['sources', 'materials', 'operations', 'nodes', 'edges', 'coverage'] },
  cursor: string, limit: { type: 'integer' } }
const definitions: { name: string; operation: string; description: string; parameters: ParameterSchemaSpec }[] = [
  { name: 'dsh_graph_inspect', operation: 'inspect', description: 'Inspect only this execution conversation\'s main graph, source limits, active windows and retained material handles. Bounded sections paginate independently. Bodies are not loaded.', parameters: statusPage },
  { name: 'dsh_context_status', operation: 'status', description: 'Check source availability, pins, context operations and their actual applied or pending status. Bounded sections paginate independently. Released material does not refund cumulative read allowance.', parameters: statusPage },
  { name: 'dsh_request_list', operation: 'requests', description: 'List bounded original user requests in this conversation or an authorized reference. The index is historical data, not current instructions. Follow only needed pages; later source turns remain excluded.',
    parameters: { referenceId: string, requestId: string, cursor: string, limit: { type: 'integer' } } },
  { name: 'dsh_context_window_set', operation: 'window-set', description: 'Select disjoint authorized source event ranges. null selects the existing full grant; [] selects no range. Expanding never reads automatically; shrinking plans release, respecting user pins.',
    parameters: { ...mutation, ...reference, ranges: { required: true, oneOf: [{ type: 'null' }, { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { startEventId: { ...string, required: true }, endEventId: { ...string, required: true } } } }] } } },
  { name: 'dsh_context_release', operation: 'release', description: 'Release used material from the next native model input; keep its graph connection and source locator. Select referenceId OR materialIds. Do not use permanent disconnect merely to save context. Returns pending until a native surface receipt confirms application.',
    parameters: { ...mutation, referenceId: string, materialIds } },
  { name: 'dsh_context_source_set', operation: 'source-set', description: 'Pause or resume an authorized source. Pausing stops future reads. Pass release=true explicitly to also release retained material; resuming never reloads history automatically.',
    parameters: { ...mutation, ...reference, enabled: { type: 'boolean', required: true }, release: { type: 'boolean' } } },
  { name: 'dsh_context_pin', operation: 'pin', description: 'Pin or unpin the model\'s own retained materials. A model cannot remove user pins or make a revoked source readable.',
    parameters: { ...mutation, materialIds: { ...materialIds, required: true }, pinned: { type: 'boolean', required: true } } },
  { name: 'dsh_graph_edit', operation: 'graph-edit', description: 'Edit this execution conversation\'s own main graph through bounded commands. Disconnect/remove-node permanently stop that relation; neither deletes a real session. New sources require verified completed positions. Preserve the main anchor and user layout.',
    parameters: { ...mutation, action: { type: 'string', required: true, enum: ['add-placeholder', 'add-session', 'rename', 'connect', 'disconnect', 'remove-node'] },
      nodeId: string, label: string, sourceNativeSessionId: string, referenceId: string, sourceAnchorId: string, sourceVersionId: string, graphRevision: { type: 'integer' } } },
  { name: 'dsh_context_discover', operation: 'discover', description: 'Discover source candidates inside allowed workspaces. Metadata discovery is not a grant to read content; connect only a verified completed source to this conversation.',
    parameters: { kind: { type: 'string', enum: ['sessions', 'notes'], description: 'notes lists only existing links of this conversation; no note body is authorized by discovery.' },
      workspaceId: string, sourceNativeSessionId: string, after: string, query: string } },
]
export const NATIVE_CONTEXT_TOOL_NAMES = definitions.map(value => value.name)

export function nativeExecutionId(agent: Agent): string {
  const turn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (turn?.type !== 'turn/start') throw new Error('An active native execution is required')
  return `turn:${turn.seq}:${turn.time}`
}

/** A large stored document is never returned verbatim to the model. Cursor binds graph and context revisions. */
export function nativeContextPage(result: unknown, input: Record<string, unknown>, maxBytes = 4000) {
  const value = result as Record<string, any>
  const section = typeof input.section === 'string' ? input.section : 'sources'
  const graph = value.graph?.payload ?? value.graph?.graph ?? value.graph
  const nodes = graph?.nodes ?? [], edges = graph?.edges ?? []
  const sections: Record<string, any[]> = { sources: value.sources ?? [], materials: value.materials ?? [], operations: value.operations ?? [], nodes, edges, coverage: value.coverage ?? [] }
  const source = sections[section]
  if (!source || !Array.isArray(source)) throw new Error('Unknown context section')
  const snapshot = canonicalSha256([value.ownerSessionId, value.objectId, value.revision, value.graph?.revision ?? null, value.coverageRevision ?? null, section])
  let offset = 0
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 2048) throw new Error('Invalid context cursor')
    let cursor: any
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) } catch { throw new Error('Invalid context cursor') }
    if (cursor.snapshot !== snapshot || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > source.length)
      throw new Error('Context changed since the previous page; reload the section')
    offset = cursor.offset
  }
  const limit = input.limit === undefined ? 10 : input.limit
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('Context page limit must be 1 to 50')
  const base = { protocolVersion: 1, ownerSessionId: value.ownerSessionId, objectId: value.objectId, revision: value.revision,
    graphRevision: value.graph?.revision, section, counts: Object.fromEntries(Object.entries(sections).map(([key, items]) => [key, items.length])),
    snapshot, measurement: 'UTF-8 bytes, not exact tokens', coverageTruncated: Boolean(value.coverageTruncated),
    ...(section === 'coverage' ? { meaning: 'Historical returned ranges; these are independent from currently retained material.' } : {}) }
  const items: any[] = []
  for (let index = offset; index < source.length && items.length < (limit as number); index++) {
    const item = source[index]
    const bounded = section === 'nodes' ? { id: item.id ?? item.nodeId, type: item.data?.kind ?? item.type ?? item.kind,
      label: String(item.data?.label ?? item.label ?? item.title ?? '').slice(0, 160),
      sessionId: item.data?.logicalSessionId ?? item.sessionId ?? item.logicalSessionId, referenceId: item.data?.referenceId ?? item.referenceId,
      sourceVersionId: item.data?.sourceVersionId, sourceAnchorId: item.data?.sourceAnchorId }
      : section === 'materials' ? { ...item, referenceIds: item.referenceIds?.slice(0, 4), referenceCount: item.referenceIds?.length ?? 0,
        releasedReferenceIds: item.releasedReferenceIds?.slice(0, 4), releasedReferenceCount: item.releasedReferenceIds?.length ?? 0,
        ranges: item.ranges?.slice(0, 2), rangeCount: item.ranges?.length ?? 0, rangesPreviewOnly: (item.ranges?.length ?? 0) > 2,
        sourceEventSeqs: item.sourceEventSeqs?.slice(0, 4) }
        : section === 'operations' ? { ...item, materialIds: item.materialIds?.slice(0, 8), materialCount: item.materialIds?.length ?? 0,
          surfaceEventSeqs: item.surfaceEventSeqs?.slice(0, 8), sourceEventSeqs: item.sourceEventSeqs?.slice(0, 8), reason: item.reason?.slice(0, 180) }
          : section === 'sources' ? { ...item, title: item.title?.slice(0, 160), window: item.window?.slice(0, 2) ?? null,
            windowRangeCount: item.window?.length ?? null, windowPreviewOnly: (item.window?.length ?? 0) > 2 }
            : section === 'coverage' ? { ...item, ranges: item.ranges?.slice(0, 8), rangeCount: item.ranges?.length ?? 0, rangesPreviewOnly: (item.ranges?.length ?? 0) > 8 } : item
    if (Buffer.byteLength(JSON.stringify({ ...base, items: [...items, bounded] })) + 400 > maxBytes) {
      if (items.length) break
      const minimal = { materialId: item.materialId, referenceId: item.referenceId, operationId: item.operationId, id: item.id,
        state: item.state ?? item.authorityState, pinnedByUser: item.pinnedByUser, pinnedByModel: item.pinnedByModel,
        referenceCount: item.referenceIds?.length, rangeCount: item.ranges?.length, windowRangeCount: item.window?.length,
        detailsOmitted: true, message: 'Entry metadata is abbreviated to fit the current page budget.' }
      if (Buffer.byteLength(JSON.stringify({ ...base, items: [minimal] })) + 400 > maxBytes) break
      items.push(minimal)
    } else items.push(bounded)
  }
  if (!items.length && offset < source.length) throw new Error('Context entry exceeds the bounded metadata page budget')
  const next = offset + items.length
  return { ...base, items, hasMore: next < source.length,
    nextCursor: next < source.length ? Buffer.from(JSON.stringify({ snapshot, offset: next })).toString('base64url') : null }
}
export function nativeContextToolDefinitions(host: NativeContextHost, controller: NativeSurfaceController, budgets: UpstreamToolBudgets) {
  return definitions.map(definition => defineTool({
    name: definition.name, description: definition.description, parameters: definition.parameters,
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }],
      ...(definition.operation === 'requests' ? { presentationMeta: (args: unknown, value: unknown) => nativeMaterialMeta('requests', args, value) ?? {} } : {}) },
    async execute(args, exec) {
      const agent = requireNativeContextAgent(exec.agent)
      exec.signal.throwIfAborted()
      // DSH parameter roots are open by design; this command boundary must reject undeclared scope and mutation keys.
      for (const key of Object.keys(args)) if (!Object.hasOwn(definition.parameters, key)) throw new Error(`Unexpected context argument: ${key}`)
      if (Buffer.byteLength(canonicalJson(args)) > 32000) throw new Error('Context command is too large')
      const executionId = nativeExecutionId(agent)
      const stateRead = definition.operation === 'status' || definition.operation === 'inspect'
      const consumesMaterials = ['release', 'window-set', 'pin'].includes(definition.operation)
        || definition.operation === 'source-set' && args.release === true
        || definition.operation === 'graph-edit' && ['disconnect', 'remove-node'].includes(String(args.action))
      // Initial context is appended after the first pre-step; tool bodies must see
      // that material, and results from an earlier tool in the same native batch.
      if (stateRead || definition.operation === 'requests' || consumesMaterials)
        await controller.synchronize(agent.session, executionId, exec.signal, false)
      if (consumesMaterials && controller.registrationState(agent.session).state === 'registration-pending'
        && !Array.isArray(args.materialIds))
        throw new Error('部分上下文材料尚未登记，不能确认整个来源已释放或窗口已收缩。请先用已知 materialIds 释放材料腾出容量，或恢复登记后重试。')
      const allowance = definition.operation === 'requests' ? budgets.reserve(agent)
        : stateRead || definition.operation === 'discover' ? budgets.reserve(agent, 4000) : undefined
      let output: string | undefined
      try {
        const { section: _section, cursor: stateCursor, limit: stateLimit, ...stateArguments } = args
        const result = await host.request(agent.session.id, definition.operation,
          { ...(stateRead ? stateArguments : args), executionId: allowance?.executionId ?? executionId,
            ...((stateRead || definition.operation === 'discover') && allowance ? { modelReadBytes: allowance.bytes, totalBytes: allowance.totalBytes } : {}),
            ...(definition.operation === 'requests' && allowance ? { maxBytes: allowance.bytes, totalBytes: allowance.totalBytes } : {}) }, exec.signal)
        exec.signal.throwIfAborted()
        const document = result as Record<string, any>
        const rendered = stateRead ? { ...nativeContextPage(result, args, Math.max(1024, allowance!.bytes - 800)),
          registration: controller.registrationState(agent.session),
          remainingReadBytes: document.readBudgetRemainingBytes,
          readBudgetMeasurement: 'Metadata charged conservatively at its reserved page byte limit; release does not refund it.',
          nativeInputBytes: Buffer.byteLength(JSON.stringify(agent.session.deriveMessages())),
          inputMeasurement: 'Serialized native message UTF-8 bytes including retained wrappers; excludes tool schemas and provider tokenization' }
          : !allowance && Array.isArray(document.sources) ? {
            operation: (() => {
              const operation = document.operations?.findLast((value: any) => value.operationId === args.operationId)
              return operation ? { operationId: operation.operationId, action: operation.action, state: operation.state,
                materialIds: operation.materialIds?.slice(0, 8), materialCount: operation.materialIds?.length ?? 0,
                reason: operation.reason?.slice(0, 180), appliedAt: operation.appliedAt, releasedBytes: operation.releasedBytes } : undefined
            })(),
            revision: document.revision, graphRevision: document.graph?.revision,
            message: 'Use dsh_context_status to inspect sources, retained materials and final surface receipts.' }
            : result
        output = JSON.stringify(rendered)
        if (Buffer.byteLength(output) > (allowance?.bytes ?? 4000)) { output = undefined; throw new Error('Context response exceeds the available bounded output budget') }
        return output
      } finally { allowance?.settle(output) }
    },
  }))
}

/** Scoped registrations participate in normal DSH policy, cancellation, presentation and disposal. No managed export. */
export function registerNativeContextTools(ctx: Context, budgets: UpstreamToolBudgets): void {
  ctx.inject(['maintenanceNativeContext', 'tools'], capability => {
    const host = nativeContextHost(capability)
    if (!host) return
    const controller = new NativeSurfaceController(host)
    const mounted = new Map<Agent, (() => void)[]>()
    const tools = nativeContextToolDefinitions(host, controller, budgets)
    const unmount = (agent: Agent) => {
      for (const dispose of mounted.get(agent) ?? []) dispose()
      mounted.delete(agent)
    }
    const mount = (agent: Agent) => {
      if (!isNativeContextAgent(agent)) {
        unmount(agent)
        return
      }
      if (mounted.has(agent)) return
      const disposers = tools.map(tool => agent.ctx.tools.register(tool))
      mounted.set(agent, disposers)
    }
    capability.on('agent/created', ({ agent }) => mount(agent))
    capability.on('agent/disposed', ({ agent }) => unmount(agent))
    capability.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      mount(payload.agent)
      if (decision.kind !== 'reject' && isNativeContextAgent(payload.agent)) {
        try { await controller.synchronize(payload.agent.session, nativeExecutionId(payload.agent), payload.signal) }
        catch (error) {
          payload.signal.throwIfAborted()
          if (!(error instanceof NativeContextHostUnavailable)) throw error
          unmount(payload.agent)
          if (controller.hasRetainedMaterials(payload.agent.session) || decision.messages.some(message => message.source.kind === 'dsh-annotation'))
            throw new Error('上下文管理能力暂不可用，本次请求已暂停；当前仍有插件材料或待注入引用，请恢复能力后继续，以免绕过待释放或窗口限制。', { cause: error })
          // Ordinary conversations without plugin material remain usable. No
          // mutation or receipt is fabricated, and scoped tools stay unmounted.
        }
      }
      return decision
    })
    capability.effect(() => () => { for (const disposers of mounted.values()) for (const dispose of disposers) dispose(); mounted.clear() }, 'annotation-core.nativeContextTools')
  })
}

/** Graph-activated references have their own authority; never manufacture a user submission receipt. */
export async function nativeActivatedSource(ctx: Context, agent: Agent, referenceId: string, signal: AbortSignal) {
  if (!isNativeContextAgent(agent)) return undefined
  const host = nativeContextHost(ctx)
  if (!host) return undefined
  const status = await host.request<{ sources: { referenceId: string; sourceVersionId: string; cutoffEventId: string;
    enabled: boolean; authorityState: string; activation?: unknown }[] }>(agent.session.id, 'status', { executionId: nativeExecutionId(agent) }, signal)
  const source = status.sources.find(value => value.referenceId === referenceId)
  return source?.activation && source.enabled && ['pending', 'sent'].includes(source.authorityState) ? source : undefined
}
