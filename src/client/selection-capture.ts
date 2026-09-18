/** rc.2 DOM selection capture. The DOM attributes are compatibility hooks. */

export const ASSISTANT_KIND = 'assistant-step'
export const USER_KINDS = new Set(['user', 'steering'])
const MESSAGE_KINDS = new Set([ASSISTANT_KIND, ...USER_KINDS])
const EXCLUDED_ROOTS = '[data-dsh-better-sidebar], [data-dsh-sidechat], [data-dsh-core-selection], [inert]'

export type MessageRole = 'user' | 'assistant'

export interface SelectionSnapshot {
  /** Full selected text. Core performs context-budget admission; producer never truncates. */
  readonly text: string
  readonly anchorId: string
  readonly messageId?: string
  readonly occurrence: number
  readonly role: MessageRole
  readonly rect: { readonly left: number; readonly top: number; readonly width: number; readonly height?: number }
  readonly range: Range
  readonly sessionId: string
}

export interface SelectionState { readonly selection: SelectionSnapshot | null }

export function roleForMessageKind(kind: string): MessageRole | undefined {
  if (kind === ASSISTANT_KIND) return 'assistant'
  if (USER_KINDS.has(kind)) return 'user'
  return undefined
}

export function isEligibleSelection(input: {
  readonly blank: boolean
  readonly sameMessage: boolean
  readonly kind: string
  readonly streaming: boolean
  readonly excluded: boolean
  readonly hasSession: boolean
  readonly hasAnchor: boolean
}): boolean {
  return !input.blank
    && input.sameMessage
    && MESSAGE_KINDS.has(input.kind)
    && !input.streaming
    && !input.excluded
    && input.hasSession
    && input.hasAnchor
}

function messageOf(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element | null
  return element?.closest<HTMLElement>('[data-chat-flow-kind]') ?? null
}

function isStreaming(message: HTMLElement): boolean {
  return message.hasAttribute('data-streaming') || message.querySelector('[data-streaming]') !== null
}

export function occurrenceOf(anchor: HTMLElement, range: Range, text: string): number {
  try {
    const prefix = document.createRange()
    prefix.selectNodeContents(anchor)
    prefix.setEnd(range.startContainer, range.startOffset)
    const before = prefix.toString()
    let occurrence = 0
    let offset = before.indexOf(text)
    while (offset >= 0) {
      occurrence += 1
      offset = before.indexOf(text, offset + Math.max(1, text.length))
    }
    return occurrence
  } catch {
    return 0
  }
}

function messageIdOf(message: HTMLElement, anchor: HTMLElement): string | undefined {
  const values = [
    message.dataset.messageId,
    message.dataset.chatMessageId,
    anchor.dataset.messageId,
    anchor.dataset.chatMessageId,
  ]
  return values.find(value => typeof value === 'string' && value.length > 0)
}

export function captureSelection(currentSessionId: string): SelectionSnapshot | null {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = messageOf(range.startContainer)
  const end = messageOf(range.endContainer)
  const anchor = start?.closest<HTMLElement>('[data-chat-anchor-key]') ?? null
  const text = selection.toString()
  const kind = start?.dataset.chatFlowKind ?? ''
  const anchorId = anchor?.dataset.chatAnchorKey
  const eligible = isEligibleSelection({
    blank: text.trim() === '',
    sameMessage: start !== null && start === end,
    kind,
    streaming: start !== null && isStreaming(start),
    excluded: (anchor ?? start)?.closest(EXCLUDED_ROOTS) !== null,
    hasSession: currentSessionId !== '',
    hasAnchor: typeof anchorId === 'string' && anchorId.length > 0,
  })
  const role = roleForMessageKind(kind)
  if (!eligible || start === null || anchor === null || anchorId === undefined || role === undefined) return null
  const rect = range.getBoundingClientRect()
  const messageId = messageIdOf(start, anchor)
  return {
    text,
    anchorId,
    ...(messageId === undefined ? {} : { messageId }),
    occurrence: occurrenceOf(anchor, range, text),
    role,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    range: range.cloneRange(),
    sessionId: currentSessionId,
  }
}

export interface SelectionController {
  getSnapshot(): SelectionState
  subscribe(listener: () => void): () => void
  clear(): void
  dispose(): void
}

const DEBOUNCE_MS = 200

export function createSelectionController(getSessionId: () => string): SelectionController {
  let selection: SelectionSnapshot | null = null
  let state: SelectionState = { selection: null }
  let timer: number | undefined
  const listeners = new Set<() => void>()
  const notify = (): void => {
    state = { selection }
    for (const listener of [...listeners]) listener()
  }
  const recompute = (): void => {
    let next: SelectionSnapshot | null = null
    try { next = captureSelection(getSessionId()) } catch { next = null }
    const changed = (selection === null) !== (next === null)
      || (selection !== null && next !== null && (
        selection.text !== next.text
        || selection.anchorId !== next.anchorId
        || selection.sessionId !== next.sessionId
        || selection.rect.left !== next.rect.left
        || selection.rect.top !== next.rect.top
        || selection.rect.width !== next.rect.width
      ))
    if (!changed) return
    selection = next
    notify()
  }
  const delayed = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(recompute, DEBOUNCE_MS)
  }
  document.addEventListener('selectionchange', delayed)
  document.addEventListener('mouseup', recompute)
  document.addEventListener('keyup', delayed)
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    clear() { selection = null; notify() },
    dispose() {
      document.removeEventListener('selectionchange', delayed)
      document.removeEventListener('mouseup', recompute)
      document.removeEventListener('keyup', delayed)
      if (timer !== undefined) window.clearTimeout(timer)
    },
  }
}
