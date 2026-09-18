import { useEffect } from 'react'
import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'

export class ReferenceHighlightStore {
  readonly sets = new Map<string, ReferenceSet>()
  private listeners = new Set<() => void>()
  update(key: string, set: ReferenceSet | null) {
    if (set) this.sets.set(key, set); else this.sets.delete(key)
    for (const listener of this.listeners) listener()
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}

/** Rebuild ranges from durable locators, never wrap or rewrite message DOM. */
export function referenceRange(root: HTMLElement, text: string, occurrence: number): Range | null {
  if (!text || occurrence < 0) return null
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const chars: { node: Text; offset: number; char: string }[] = []
  for (let value = walker.nextNode(); value; value = walker.nextNode()) {
    const node = value as Text
    for (let offset = 0; offset < node.length; offset++) {
      const char = node.data[offset]!
      if (!/[\s\u200b-\u200d\u2060\ufeff]/u.test(char)) chars.push({ node, offset, char })
    }
  }
  const quote = text.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, '')
  if (!quote) return null
  const content = chars.map(item => item.char).join('')
  let start = -1, cursor = 0
  for (let i = 0; i <= occurrence; i++) { start = content.indexOf(quote, cursor); if (start < 0) return null; cursor = start + quote.length }
  const first = chars[start], last = chars[cursor - 1]
  if (!first || !last) return null
  const range = root.ownerDocument.createRange()
  range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1)
  return range
}

type HighlightPlatform = { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...ranges: Range[]) => unknown }
export function ReferenceHighlights({ store, currentSession, subscribeSession, resolveAnchor }: {
  store: ReferenceHighlightStore; currentSession(): string | undefined; subscribeSession(listener: () => void): () => void;
  resolveAnchor(item: ReferenceItem): string;
}) {
  useEffect(() => {
    const platform = globalThis as unknown as HighlightPlatform
    if (!platform.CSS?.highlights || !platform.Highlight) return
    const registry = platform.CSS.highlights, Highlight = platform.Highlight
    let frame = 0, observing = false
    const paint = () => {
      frame = 0
      let hasSources = false
      const ranges: Range[] = [], seen = new Set<string>(), sessionId = currentSession()
      for (const set of store.sets.values()) for (const item of set.items) {
        if (item.sourceType !== 'dsh-message' || item.locator.sessionId !== sessionId) continue
        hasSources = true
        const key = JSON.stringify([item.locator.anchorId, item.selectedText, item.locator.occurrence])
        if (seen.has(key)) continue
        seen.add(key)
        const anchor = resolveAnchor(item)
        const root = document.querySelector<HTMLElement>(`[data-chat-anchor-key="${CSS.escape(anchor)}"]`)
        const range = root && referenceRange(root, item.selectedText, item.locator.occurrence)
        if (range) ranges.push(range)
      }
      registry.set('dsh-core-references', new Highlight(...ranges))
      if (hasSources && !observing) { observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-chat-anchor-key'] }); observing = true }
      if (!hasSources && observing) { observer.disconnect(); observing = false }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    const unsubscribe = store.subscribe(schedule), unsubscribeSession = subscribeSession(schedule)
    const observer = new MutationObserver(schedule)
    schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); unsubscribe(); unsubscribeSession(); registry.delete('dsh-core-references') }
  }, [store, currentSession, subscribeSession, resolveAnchor])
  return null
}
