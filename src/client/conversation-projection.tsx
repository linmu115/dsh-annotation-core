interface ConversationLocation { readonly kind: string; readonly [key: string]: unknown }
interface SessionEventLike { readonly type: string; readonly seq: number; readonly data: unknown }
interface ConversationMatch { readonly event: SessionEventLike; readonly location: ConversationLocation }
interface ConversationNodeContext<State> {
  readonly key: string
  readonly id: string
  readonly state?: State
}
interface ConversationNodeDefinition<State> {
  readonly kind: string
  readonly target: 'chat'
  match(event: SessionEventLike): { readonly id: string; readonly role: 'start' } | null
  start(context: ConversationNodeContext<State>, match: ConversationMatch): State
  update(context: ConversationNodeContext<State>): State
  publication(): 'immediate'
  buildViewNode(context: ConversationNodeContext<State>): ChatConversationViewNode | null
}
interface ChatConversationViewNode {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly target: 'chat'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly visibility: 'visible'
  readonly data: AnnotationConversationData
}

export interface AnnotationConversationData {
  readonly contextMessageId: string
  readonly setId: string
  readonly targetUserMessageId: string
  readonly count: number
  readonly genericContextKey: string
}

export interface AnnotationConversationState extends AnnotationConversationData {
  readonly seq: number
  readonly sourceLocation: ConversationLocation
}

const SESSION_LOCATION: ConversationLocation = Object.freeze({ kind: 'session' })

function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}

interface AnnotationSource {
  readonly kind: 'dsh-annotation'
  readonly schemaVersion: 1
  readonly setId: string
  readonly targetUserMessageId: string
  readonly count: number
}

function annotationEvent(event: SessionEventLike): { readonly id: string; readonly seq: number; readonly source: AnnotationSource } | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data as { readonly id?: unknown; readonly source?: unknown }
  const source = data.source as Partial<AnnotationSource> | undefined
  if (
    typeof data.id !== 'string' || source?.kind !== 'dsh-annotation' || source.schemaVersion !== 1 ||
    typeof source.setId !== 'string' || typeof source.targetUserMessageId !== 'string' ||
    typeof source.count !== 'number' || !Number.isInteger(source.count) || source.count < 1
  ) return undefined
  return { id: data.id, seq: event.seq, source: source as AnnotationSource }
}

export const annotationConversationDefinition: ConversationNodeDefinition<AnnotationConversationState> = {
  kind: 'dsh-annotation',
  target: 'chat',
  match(event) {
    const found = annotationEvent(event)
    return found === undefined ? null : { id: found.id, role: 'start' }
  },
  start(_context, match) {
    const found = annotationEvent(match.event)
    if (found === undefined) throw new TypeError('Annotation conversation start did not contain an annotation event')
    return Object.freeze({
      contextMessageId: found.id,
      setId: found.source.setId,
      targetUserMessageId: found.source.targetUserMessageId,
      count: found.source.count,
      genericContextKey: conversationContextKey('input-message', found.id),
      seq: found.seq,
      sourceLocation: match.location,
    })
  },
  update(context) {
    if (context.state === undefined) throw new TypeError('Annotation conversation state is missing')
    return context.state
  },
  publication: () => 'immediate',
  buildViewNode(context): ChatConversationViewNode | null {
    const state = context.state
    if (state === undefined) return null
    return Object.freeze({
      key: context.key,
      kind: 'dsh-annotation',
      id: state.contextMessageId,
      target: 'chat',
      anchorSeq: state.seq,
      // DSH 0.1.2-alpha.1 folds every custom Turn-local Node into the answer's
      // process window, even when its declared visibility is `visible`. Keep
      // the durable annotation at the same ordering anchor but project it at
      // Session scope so it remains independent of Turn-process disclosure.
      location: SESSION_LOCATION,
      visibility: 'visible',
      data: {
        contextMessageId: state.contextMessageId,
        setId: state.setId,
        targetUserMessageId: state.targetUserMessageId,
        count: state.count,
        genericContextKey: state.genericContextKey,
      } satisfies AnnotationConversationData,
    })
  },
}

interface SuppressionRecord { count: number; originalHidden: boolean }
const suppressions = new WeakMap<HTMLElement, SuppressionRecord>()

function findExact(root: ParentNode, key: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
    .filter((element) => element.dataset.chatAnchorKey === key)
}

/** Hide only the generic context row that represents the same durable annotation event. */
export function suppressGenericAnnotationRow(key: string, root: Document | HTMLElement = document): () => void {
  const owned = new Set<HTMLElement>()
  const apply = () => {
    for (const element of findExact(root, key)) {
      if (owned.has(element)) continue
      const record = suppressions.get(element)
      if (record === undefined) {
        suppressions.set(element, { count: 1, originalHidden: element.hidden })
        element.hidden = true
      } else {
        record.count += 1
      }
      owned.add(element)
    }
  }
  apply()
  const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(apply)
  observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-anchor-key'] })
  return () => {
    observer?.disconnect()
    for (const element of owned) {
      const record = suppressions.get(element)
      if (record === undefined) continue
      record.count -= 1
      if (record.count === 0) {
        element.hidden = record.originalHidden
        suppressions.delete(element)
      }
    }
    owned.clear()
  }
}
