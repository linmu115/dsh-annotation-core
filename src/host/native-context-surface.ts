import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { freezeMessage, type ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { canonicalJson, canonicalSha256, parseSerializedAnnotationContext } from '../protocol/index.ts'
import type { NativeContextHost, NativeMaterial, NativeReleasePlan } from './native-context-contract.ts'

type Data = Record<string, any>
interface SurfacePart { material: NativeMaterial; key: string }
interface ReleaseEvidence { operationIds: string[]; materialIds: string[]; originalEventSeq: number }
const plugin = 'dsh-annotation-core'
const marker = (id: string) => `[Released context ${id}; source position is retained. Read again only when needed.]`
class NativeMaterialUnavailable extends Error {}
/** Only failure to query the optional Host may degrade an otherwise unrelated chat. */
export class NativeContextHostUnavailable extends Error {}

/** Only tool-owned, persisted metadata is used; arbitrary strings and user-authored JSON are never classifiers. */
export function nativeMaterialMeta(kind: 'read' | 'search' | 'requests', args: unknown, output: unknown) {
  if (typeof output !== 'string') return undefined
  let value: Data
  try { value = JSON.parse(output) } catch { return undefined }
  const input = args as Data
  const referenceId = typeof value.referenceId === 'string' ? value.referenceId : typeof input?.referenceId === 'string' ? input.referenceId : undefined
  const referenceIds = referenceId ? [referenceId] : []
  const ranges = (Array.isArray(value.items) ? value.items : []).flatMap((item: Data) => {
    const text = typeof item.text === 'string' ? item.text : typeof item.excerpt === 'string' ? item.excerpt : ''
    const eventId = typeof item.eventId === 'string' ? item.eventId : typeof item.requestId === 'string' ? item.requestId : undefined
    if (!referenceId || !eventId) return []
    const start = Number.isSafeInteger(kind === 'requests' ? item.textOffset : item.offset) ? (kind === 'requests' ? item.textOffset : item.offset) : 0
    return [{ referenceId, eventId, start, end: start + (kind === 'requests' ? Array.from(text).length : text.length) }]
  }).slice(0, 256)
  return { nativeContext: { protocolVersion: 1, plugin, kind, referenceIds, ranges } }
}

function bytes(value: unknown) { return Buffer.byteLength(typeof value === 'string' ? value : canonicalJson(value)) }
function material(session: Session, event: SessionEvent, key: string, kind: NativeMaterial['kind'], referenceIds: string[], content: unknown,
  ranges: NativeMaterial['ranges']): SurfacePart {
  return { key, material: { materialId: `ncm:${canonicalSha256([session.id, event.seq, key]).slice(7)}`, eventSeq: event.seq,
    kind, referenceIds, ranges, bytes: bytes(content), contentHash: canonicalSha256(content), sourceEventSeqs: [event.seq] } }
}
function annotationParts(session: Session, event: SessionEvent): SurfacePart[] {
  if (event.type !== 'user/message' || event.data.source.kind !== 'dsh-annotation') return []
  const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
  const parsed = parseSerializedAnnotationContext(text)
  if (canonicalSha256({ schemaVersion: 1, setId: event.data.source.setId, annotations: parsed.annotations.items,
    documents: parsed.documents.documents }) !== event.data.source.digest) throw new Error('Annotation material digest mismatch')
  const authorityIds = new Map(parsed.annotations.items.map(item => [item.referenceId,
    item.sourceType === 'dsh-message' && 'upstream' in item.locator && item.locator.upstream ? item.locator.upstream.referenceId : item.referenceId]))
  const parts = parsed.annotations.items.flatMap(item => {
    const { initialContext } = item
    const referenceId = authorityIds.get(item.referenceId)!
    return [material(session, event, `reference:${item.referenceId}`, 'initial', [referenceId], item.selectedText, []),
      ...(initialContext?.items.map((range, index) => material(session, event, `reference:${item.referenceId}:item:${index}`, 'initial', [referenceId], range,
        [{ referenceId, eventId: range.eventId, start: range.offset, end: range.offset + range.text.length }])) ?? [])]
  })
  for (const document of parsed.documents.documents) parts.push(material(session, event, `document:${document.key}`, 'initial',
    [...new Set(document.referenceIds.map(id => authorityIds.get(id) ?? id))], document.markdown, []))
  return parts
}
function partsFor(session: Session, event: SessionEvent): SurfacePart[] {
  if (event.type === 'user/message') return annotationParts(session, event)
  if (event.type !== 'tool/result' || event.data.message.content[0].isError) return []
  const meta = (event.data as Data).presentationMeta?.nativeContext ?? (event.data as Data).meta?.nativeContext
  if (meta?.protocolVersion !== 1 || meta.plugin !== plugin || !['read', 'search', 'requests'].includes(meta.kind)
    || !Array.isArray(meta.referenceIds) || !Array.isArray(meta.ranges)) return []
  const content = event.data.message.content[0].content
  if (content.length !== 1 || content[0]?.type !== 'text') return []
  let value: Data
  try { value = JSON.parse(content[0].text) } catch { return [] }
  if (!Array.isArray(value.items)) return [material(session, event, 'tool-result', meta.kind, meta.referenceIds, content, meta.ranges)]
  return value.items.map((item: Data, index: number) => {
    const eventId = typeof item.eventId === 'string' ? item.eventId : typeof item.requestId === 'string' ? item.requestId : undefined
    const start = Number.isSafeInteger(meta.kind === 'requests' ? item.textOffset : item.offset) ? (meta.kind === 'requests' ? item.textOffset : item.offset) : 0
    const text = typeof item.text === 'string' ? item.text : typeof item.excerpt === 'string' ? item.excerpt : ''
    const ranges = eventId ? meta.referenceIds.map((referenceId: string) => ({ referenceId, eventId, start, end: start + (meta.kind === 'requests' ? Array.from(text).length : text.length) })) : []
    return material(session, event, `tool:item:${index}`, meta.kind, meta.referenceIds, item, ranges)
  })
}
function evidence(event: SessionEvent): ReleaseEvidence | undefined {
  if (typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace') return undefined
  let value: Data | undefined
  if (event.type === 'tool/result') {
    const content = event.data.message.content[0].content
    if (content.length !== 1 || content[0]?.type !== 'text') return undefined
    try { value = JSON.parse(content[0].text)?.nativeContextRelease } catch { return undefined }
  } else if (event.type === 'user/message' && event.data.source.kind === 'dsh-native-context-release') value = event.data.source
  return value?.protocolVersion === 1 && value.plugin === plugin && Array.isArray(value.materialIds)
    && Array.isArray(value.operationIds) && Number.isSafeInteger(value.originalEventSeq) ? value as ReleaseEvidence : undefined
}
function currentNode(session: Session, root: number) {
  for (const seq of session.surface.nodes) {
    if (seq === root) return session.eventAt(seq)
    const event = session.eventAt(seq)!
    if (evidence(event)?.originalEventSeq === root) return event
  }
  return undefined
}
function retainedParts(session: Session): SurfacePart[] {
  return session.surface.nodes.flatMap(seq => {
    const event = session.eventAt(seq)!, proof = evidence(event)
    const original = proof ? session.eventAt(SessionSeq(proof.originalEventSeq)) : event
    if (!original || (proof && original.seq >= event.seq)) throw new Error('Material registration lacks its original native event')
    return partsFor(session, original).filter(part => !proof?.materialIds.includes(part.material.materialId))
  })
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-native-context-release': { kind: 'dsh-native-context-release'; protocolVersion: 1; plugin: string;
      operationIds: string[]; materialIds: string[]; originalEventSeq: number; setId: string; targetUserMessageId: string }
  }
}

/** No original history is rewritten. Each edit is a one-node native surface replacement. */
function replaceParts(session: Session, original: SessionEvent, current: SessionEvent, parts: SurfacePart[], operationId: string) {
  const previous = evidence(current)
  const materialIds = [...new Set([...(previous?.materialIds ?? []), ...parts.map(part => part.material.materialId)])]
  const operationIds = [...new Set([...(previous?.operationIds ?? []), operationId])].slice(-128)
  const proof = { protocolVersion: 1 as const, plugin, operationIds, materialIds, originalEventSeq: original.seq }
  const options = { surfaceOp: { op: 'replace' as const, startSeq: current.seq, endSeq: current.seq },
    sourceEventSeqs: [...new Set([current.seq, original.seq])] }
  if (original.type === 'tool/result' && current.type === 'tool/result') {
    const result = current.data.message.content[0]
    const originalContent = original.data.message.content[0].content
    if (originalContent.length !== 1 || originalContent[0]?.type !== 'text') throw new Error('Unsupported tool material envelope')
    const value = JSON.parse(originalContent[0].text) as Data
    const allParts = partsFor(session, original)
    const releasedKeys = new Map(allParts.filter(part => materialIds.includes(part.material.materialId)).map(part => [part.key, part.material.materialId]))
    const revised = Array.isArray(value.items) ? { ...value, items: value.items.map((item: Data, index: number) => {
      const id = releasedKeys.get(`tool:item:${index}`)
      if (!id) return item
      // Preserve request/event identities and response paging; replace only this entry's content.
      const retained = Object.fromEntries(Object.entries(item).filter(([key]) => ['eventId', 'requestId', 'logicalSessionId', 'sourceVersionId',
        'role', 'offset', 'textOffset', 'complete', 'ordinal', 'createdAt', 'turnId', 'turnBoundaryEventId', 'relation', 'state', 'associationState'].includes(key)))
      return { ...retained, text: marker(id), released: true }
    }) } : { message: 'Source positions retained; read again only when needed.' }
    const message = freezeMessage<ToolResultMessage>({ ...current.data.message, content: [{ ...result,
      content: [{ type: 'text' as const, text: canonicalJson({ ...revised, nativeContextRelease: proof }) }] }] })
    // DSH requires every tool-result field except content (including meta) to remain byte-for-byte equivalent.
    return session.append('tool/result', { ...current.data, message }, options)
  }
  if (original.type !== 'user/message' || current.type !== 'user/message' || original.data.source.kind !== 'dsh-annotation')
    throw new Error('Material surface has an unsupported replacement shape')
  const parsed = parseSerializedAnnotationContext(original.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
  const allParts = annotationParts(session, original)
  const releasedKeys = new Map(allParts.filter(part => materialIds.includes(part.material.materialId)).map(part => [part.key, part.material.materialId]))
  const annotations = parsed.annotations.items.map(item => {
    const id = releasedKeys.get(`reference:${item.referenceId}`)
    const initialContext = item.initialContext ? { ...item.initialContext, items: item.initialContext.items.map((part, index) => {
      const partId = releasedKeys.get(`reference:${item.referenceId}:item:${index}`)
      return partId ? { ...part, text: marker(partId), released: true } : part
    }) } : undefined
    return { ...item, ...(id ? { selectedText: marker(id) } : {}), ...(initialContext ? { initialContext } : {}) }
  })
  const documents = parsed.documents.documents.map(document => {
    const id = releasedKeys.get(`document:${document.key}`)
    return id ? { ...document, markdown: marker(id) } : document
  })
  const setId = original.data.source.setId.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)
  const text = `<dsh-annotations version="1" set-id="${setId}">\n${canonicalJson({ items: annotations })}\n</dsh-annotations>\n<dsh-reference-documents>\n${canonicalJson({ documents })}\n</dsh-reference-documents>`
  return session.append('user/message', { ...current.data,
    content: [{ type: 'text', text }], source: { kind: 'dsh-native-context-release', ...proof,
      setId: original.data.source.setId, targetUserMessageId: original.data.source.targetUserMessageId } }, options)
}

/** Durable Engine intent + native replacement evidence permit safe retry after either side restarts. */
export class NativeSurfaceController {
  private readonly registered = new WeakMap<Session, Set<string>>()
  private readonly issues = new WeakMap<Session, { unregisteredMaterials: number; state: 'ready' | 'registration-pending'; reason?: string }>()
  constructor(private readonly host: NativeContextHost) {}
  registrationState(session: Session) { return this.issues.get(session) ?? { unregisteredMaterials: 0, state: 'ready' as const } }
  hasRetainedMaterials(session: Session) { return retainedParts(session).length > 0 }
  private async registerMaterials(session: Session, executionId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    let known = this.registered.get(session)
    if (!known) { known = new Set(); this.registered.set(session, known) }
    // Partial replacements retain the original IDs of unregistered siblings.
    const pending = retainedParts(session).map(part => part.material).filter(item => !known.has(item.materialId))
    try {
      for (let start = 0; start < pending.length; start += 50) {
        const batch = pending.slice(start, start + 50)
        await this.host.request(session.id, 'materials-register', { executionId, materials: batch }, signal)
        for (const item of batch) known.add(item.materialId)
      }
      this.issues.set(session, { unregisteredMaterials: 0, state: 'ready' })
    } catch (error) {
      signal.throwIfAborted()
      this.issues.set(session, { unregisteredMaterials: pending.filter(item => !known!.has(item.materialId)).length,
        state: 'registration-pending', reason: error instanceof Error ? error.message.slice(0, 180) : 'Material registration is pending' })
    }
  }
  async synchronize(session: Session, executionId: string, signal: AbortSignal, applyPending = true): Promise<void> {
    signal.throwIfAborted()
    if (!applyPending) return this.registerMaterials(session, executionId, signal)
    // Already accepted releases can free capacity even when new material registration is full.
    let plans: { items: NativeReleasePlan[]; materials: NativeMaterial[] }
    try { plans = await this.host.request(session.id, 'release-plans', { executionId }, signal) }
    catch (error) {
      signal.throwIfAborted()
      throw new NativeContextHostUnavailable('Native context Host could not verify pending operations', { cause: error })
    }
    for (const plan of plans.items) {
      if (plan.state !== 'pending-next-step') continue
      const desired = plan.materialIds.map(id => plans.materials.find(item => item.materialId === id))
      if (desired.some(item => !item)) throw new Error('Pending release has missing material records')
      const sourceEventSeqs: number[] = [], surfaceEventSeqs: number[] = []
      let releasedBytes = 0
      const roots = [...new Set(desired.map(item => item!.eventSeq))]
      try {
      for (const root of roots) {
        signal.throwIfAborted()
        const original = session.eventAt(SessionSeq(root)), current = currentNode(session, root)
        if (!original || !current) throw new NativeMaterialUnavailable('Pending release source is unavailable or another compaction replaced its native surface')
        const parts = partsFor(session, original).filter(part => plan.materialIds.includes(part.material.materialId))
        if (!parts.length) throw new NativeMaterialUnavailable('Pending release cannot be verified from trusted native material metadata')
        for (const part of parts) {
          const claimed = desired.find(item => item!.materialId === part.material.materialId)!
          if (claimed!.contentHash !== part.material.contentHash) throw new NativeMaterialUnavailable('Pending material content digest mismatch')
        }
        const already = evidence(current)
        const remaining = parts.filter(part => !already?.materialIds.includes(part.material.materialId))
        const before = bytes(current.data)
        const needsProof = !already?.operationIds.includes(plan.operationId)
        const replacement = remaining.length || needsProof ? replaceParts(session, original, current, remaining, plan.operationId) : current
        if (!session.surface.nodes.includes(replacement.seq) || (remaining.length && session.surface.nodes.includes(current.seq)))
          throw new Error('Native surface replacement did not take effect')
        if (!parts.every(part => evidence(replacement)?.materialIds.includes(part.material.materialId)))
          throw new Error('Native surface replacement lacks material evidence')
        sourceEventSeqs.push(root); surfaceEventSeqs.push(replacement.seq)
        releasedBytes += Math.max(0, before - bytes(replacement.data))
      }
      } catch (error) {
        if (!(error instanceof NativeMaterialUnavailable)) throw error
        await this.host.request(session.id, 'release-receipt', { executionId, operationId: plan.operationId, state: 'failed',
          surfaceEventSeqs, sourceEventSeqs, releasedBytes, reason: error.message }, signal)
        continue
      }
      // Host flushes the native projection before acknowledging this receipt. Failure leaves the durable plan pending.
      await this.host.request(session.id, 'release-receipt', { executionId, operationId: plan.operationId, state: 'applied',
        surfaceEventSeqs, sourceEventSeqs, releasedBytes }, signal)
    }
    await this.registerMaterials(session, executionId, signal)
  }
}
