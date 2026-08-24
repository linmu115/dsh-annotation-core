import { conversationContextKey } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode,
  ConversationLocation,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNodeDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'

type _ChatNodeDataMapRegistration = ChatNodeDataMap

export interface AnnotationConversationData {
  readonly contextMessageId: string
  readonly setId: string
  readonly targetUserMessageId: string
  readonly count: number
  readonly genericContextKey: string
}

export interface AnnotationConversationState extends AnnotationConversationData {
  readonly seq: number
  readonly location: ConversationLocation
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'dsh-annotation': AnnotationConversationData
  }
}

interface AnnotationSource {
  readonly kind: 'dsh-annotation'
  readonly schemaVersion: 1
  readonly setId: string
  readonly targetUserMessageId: string
  readonly count: number
}

function annotationEvent(event: SessionEvent): { readonly id: string; readonly seq: number; readonly source: AnnotationSource } | undefined {
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
      location: match.location,
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
      location: state.location,
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

/** rc.2 compatibility hook: hide only the generic row with the exact exported context key. */
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
