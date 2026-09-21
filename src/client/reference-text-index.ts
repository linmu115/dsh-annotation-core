/**
 * Shared, bounded text index for durable reference locators.
 *
 * Locators carry a quote + occurrence, never a character offset, so every paint
 * has to walk the message root and rebuild the non-whitespace character table.
 * Two surfaces now need the same table (CSS Highlight ranges and the inline
 * badge overlay), so the walk lives here and is cached per anchor root.
 *
 * The cache is deliberately process-local and short-lived: both surfaces call
 * `clearReferenceTextIndex()` at the start of a paint that a message-DOM batch
 * (or a store/scroll/resize change) scheduled, so a table is never served across
 * a layout change. Kept-out mutations are filtered by `affectsMessageText`, which
 * is what stops this plugin's own rendering from invalidating the tables. Keys are
 * element identities, so a dropped or re-rendered message simply stops being read.
 */

export interface ReferenceTextIndex {
  /** Non-whitespace characters of the root, in document order. */
  readonly chars: readonly { node: Text; offset: number; char: string }[]
  /** The same characters joined; `chars` and `content` always agree in length. */
  readonly content: string
}

const textIndices = new Map<HTMLElement, ReferenceTextIndex>()

const INSIGNIFICANT = /[\s\u200b-\u200d\u2060\ufeff]/u

/** Surfaces this plugin renders. Mutations inside them never change message text. */
const SELF_HOST_SELECTORS = ['[data-dsh-annotation-badges]', '[data-dsh-annotation-dialog-host]'] as const

/**
 * Attributes that can move message text without changing it: the sticker board
 * watches the same set, and a layout shift changes where a badge belongs even
 * though the characters are identical.
 */
export const LAYOUT_ATTRIBUTES: readonly string[] = ['data-chat-anchor-key', 'class', 'style', 'hidden', 'data-streaming']

/**
 * Set when a message-DOM batch may have invalidated the cached tables. The map
 * is dropped lazily by the next read instead of on every paint, so a scroll or a
 * resize reuses the tables measured for the previous frame.
 */
let dirty = true

/** Mark the tables stale; call from the mutation observer, never per paint. */
export function markReferenceTextDirty(): void { dirty = true }

/** Drop cached tables right now. Only needed when observation starts over. */
export function clearReferenceTextIndex(): void { textIndices.clear(); dirty = false }

/**
 * True when a DOM mutation batch may have changed message text or moved it: at
 * least one record landed outside this plugin's own UI, and it either carried
 * content or touched one of {@link LAYOUT_ATTRIBUTES}. Callers use it both to
 * schedule a repaint and to mark the tables stale, which is what keeps this
 * plugin's own rendering (badge host, dialog host) from invalidating them.
 */
export function affectsMessageText(records: readonly MutationRecord[]): boolean {
  return records.some(record => {
    const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target as Element : record.target.parentElement
    if (element !== null && SELF_HOST_SELECTORS.some(selector => element.closest(selector) !== null)) return false
    return record.type !== 'attributes' || (record.attributeName !== null && LAYOUT_ATTRIBUTES.includes(record.attributeName))
  })
}

export function referenceTextIndex(root: HTMLElement): ReferenceTextIndex {
  // Lazy invalidation: whoever reads first after a mutation pays for the clear.
  if (dirty) { textIndices.clear(); dirty = false }
  const cached = textIndices.get(root)
  if (cached !== undefined) return cached
  const doc = root.ownerDocument
  // Detached roots (jsdom hosts, removed nodes) never see a meaningful update and
  // would otherwise pin whole subtrees, so they are measured but not retained.
  const cacheable = doc.body.contains(root)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const chars: { node: Text; offset: number; char: string }[] = []
  let content = ''
  for (let value = walker.nextNode(); value; value = walker.nextNode()) {
    const node = value as Text
    for (let offset = 0; offset < node.length; offset++) {
      const char = node.data[offset]!
      if (INSIGNIFICANT.test(char)) continue
      chars.push({ node, offset, char })
      content += char
    }
  }
  const index: ReferenceTextIndex = { chars, content }
  if (cacheable) textIndices.set(root, index)
  return index
}

/** Non-whitespace projection of a quote, matching the indexed character stream. */
export function normalizeReferenceText(text: string): string {
  return text.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, '')
}
