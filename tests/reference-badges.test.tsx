// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { avoidStickerDots, ReferenceBadges, stickerDotRects } from '../src/client/reference-badges.tsx'
import { ReferenceHighlightStore } from '../src/client/reference-highlights.tsx'
import { affectsMessageText } from '../src/client/reference-text-index.ts'
import type { ReferenceItem, ReferenceSet } from '../src/domain/model.ts'
import { selectedTextHash } from '../src/protocol/index.ts'

const roots: ReturnType<typeof createRoot>[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * jsdom has no layout engine: every rect here is synthetic. jsdom's `Range` also
 * lacks the layout API entirely, so a real `getClientRects` is installed on the
 * prototype and fed from `rangeRects` — the component still creates its own
 * ranges and walks its own text.
 */
let rangeRects: DOMRect[] = []
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')

beforeEach(() => {
  document.body.replaceChildren()
  rangeRects = []
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true, writable: true,
    value: () => rangeRects as unknown as DOMRectList,
  })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
  if (originalRangeRects === undefined) delete (Range.prototype as unknown as Record<string, unknown>).getClientRects
  else Object.defineProperty(Range.prototype, 'getClientRects', originalRangeRects)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height)
}

function dshItem(index: number, text: string, anchorId: string, sessionId = 'session-1'): ReferenceItem {
  return {
    referenceId: `reference-${index}`, number: index, sourceType: 'dsh-message', selectedText: text,
    userComment: '', backlinkState: 'not-required',
    locator: { profileId: 'web', sessionId, anchorId, role: 'assistant', occurrence: 0, selectedTextHash: selectedTextHash(text) },
  }
}

function set(state: ReferenceSet['state'], setId: string, items: readonly ReferenceItem[]): ReferenceSet {
  return { schemaVersion: 1, setId, profileId: 'web', sessionId: 'session-1', state, revision: 1, createdAt: 1, items }
}

function message(anchorId: string, text: string, box = rect(0, 10, 200, 40)): HTMLElement {
  const node = document.createElement('p')
  node.dataset.chatAnchorKey = anchorId
  node.textContent = text
  document.body.append(node)
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(box)
  return node
}

function renderBadges(store: ReferenceHighlightStore, openReference = vi.fn()) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(<ReferenceBadges
    store={store}
    currentSession={() => 'session-1'}
    subscribeSession={() => () => {}}
    resolveAnchor={item => item.sourceType === 'dsh-message' ? item.locator.anchorId : ''}
    openReference={openReference}
  />))
  return { openReference, host }
}

const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
const badges = () => [...document.querySelectorAll<HTMLButtonElement>('[data-dsh-annotation-badge]')]

describe('inline reference badges', () => {
  it('renders one badge per deduplicated pending and prefetched sent reference', async () => {
    const store = new ReferenceHighlightStore()
    message('anchor-1', 'first passage')
    message('anchor-2', 'second passage')
    message('anchor-3', 'elsewhere')
    rangeRects = [rect(0, 10, 120, 20)]
    const first = dshItem(1, 'first passage', 'anchor-1')
    const duplicate = { ...dshItem(1, 'first passage', 'anchor-1'), referenceId: 'reference-9', number: 9 }
    const second = dshItem(2, 'second passage', 'anchor-2')
    const foreign = dshItem(3, 'elsewhere', 'anchor-3', 'session-2')
    renderBadges(store)
    store.update('pending', set('pending', 'set-pending', [first, second, foreign]))
    await flush()
    expect(badges().map(button => button.dataset.dshAnnotationBadge)).toEqual(['reference-1', 'reference-2'])

    // A sent set quoting the same passage must not add a second badge.
    store.update('sent:session-1:set-sent', set('sent', 'set-sent', [duplicate]))
    await flush()
    expect(badges()).toHaveLength(2)

    store.update('pending', null)
    store.update('sent:session-1:set-sent', null)
    await flush()
    expect(badges()).toHaveLength(0)
  })

  it('skips a reference whose anchor cannot be resolved instead of guessing a position', async () => {
    const store = new ReferenceHighlightStore()
    message('anchor-1', 'known passage')
    rangeRects = [rect(0, 10, 120, 20)]
    renderBadges(store)
    store.update('pending', set('pending', 'set-pending', [dshItem(1, 'known passage', 'missing-anchor')]))
    await flush()
    expect(badges()).toHaveLength(0)
    expect(document.querySelector('[data-chat-anchor-key="anchor-1"]')?.textContent).toBe('known passage')
  })

  it('opens the dialog with the set and reference id but no anchor, and keeps the selection', async () => {
    const store = new ReferenceHighlightStore()
    message('anchor-1', 'first passage')
    rangeRects = [rect(0, 10, 120, 20)]
    const item = dshItem(1, 'first passage', 'anchor-1')
    const pending = set('pending', 'set-pending', [item])
    const { openReference } = renderBadges(store)
    store.update('pending', pending)
    await flush()

    const button = badges()[0]!
    const pointerDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    await act(async () => { button.dispatchEvent(pointerDown) })
    expect(pointerDown.defaultPrevented).toBe(true)
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => { button.dispatchEvent(mouseDown) })
    expect(mouseDown.defaultPrevented).toBe(true)
    await act(async () => { button.click() })

    expect(openReference).toHaveBeenCalledTimes(1)
    // Default placement: the dialog docks to the composer card, so no anchor travels.
    expect(openReference).toHaveBeenCalledWith(pending, 'reference-1')
    expect(openReference.mock.calls[0]).toHaveLength(2)
  })

  it('renders the badge after the last rect of the referenced range', async () => {
    const store = new ReferenceHighlightStore()
    message('anchor-1', 'first passage')
    rangeRects = [rect(0, 10, 120, 20), rect(0, 32, 80, 20)]
    renderBadges(store)
    store.update('pending', set('pending', 'set-pending', [dshItem(1, 'first passage', 'anchor-1')]))
    await flush()
    const badge = badges()[0]!
    expect(badge.style.left).toBe('87px')
    expect(badge.style.top).toBe('42px')
  })

  it('repaints when message DOM changes and ignores mutations inside its own host', async () => {
    const store = new ReferenceHighlightStore()
    const node = message('anchor-1', 'first passage')
    rangeRects = [rect(0, 10, 120, 20)]
    const { host } = renderBadges(store)
    store.update('pending', set('pending', 'set-pending', [dshItem(1, 'first passage', 'anchor-1')]))
    await flush()
    expect(badges()[0]!.style.left).toBe('127px')

    act(() => { host.querySelector('[data-dsh-annotation-badges]')!.append(document.createElement('i')) })
    await flush()
    expect(badges()[0]!.style.left).toBe('127px')

    rangeRects = [rect(0, 10, 150, 20)]
    act(() => { node.textContent = 'first passage grown' })
    await flush()
    expect(badges()[0]!.style.left).toBe('157px')
  })

  it('does not paint a badge for a message that is far outside the viewport margin', async () => {
    const store = new ReferenceHighlightStore()
    message('anchor-1', 'first passage', rect(0, -4000, 200, 40))
    rangeRects = [rect(0, 10, 120, 20)]
    const rangeSpy = vi.spyOn(document, 'createRange')
    renderBadges(store)
    store.update('pending', set('pending', 'set-pending', [dshItem(1, 'first passage', 'anchor-1')]))
    await flush()
    expect(badges()).toHaveLength(0)
    expect(rangeSpy).not.toHaveBeenCalled()
  })
})

describe('heuristic avoidance of sticker dots', () => {
  it('steps down the 24px ladder when a sticker dot holds the same slot', () => {
    expect(avoidStickerDots({ x: 100, y: 42 }, [rect(96, 38, 19, 19)])).toEqual({ x: 100, y: 66 })
    // A dot far enough away on either axis is not in the collision band.
    expect(avoidStickerDots({ x: 130, y: 42 }, [rect(96, 38, 19, 19)])).toEqual({ x: 130, y: 42 })
    expect(avoidStickerDots({ x: 100, y: 90 }, [rect(96, 38, 19, 19)])).toEqual({ x: 100, y: 90 })
  })

  it('reads the dots the sticker board actually rendered and keeps a free slot', async () => {
    const store = new ReferenceHighlightStore()
    const dot = document.createElement('span')
    dot.className = 'dsh-sticker-board-dot'
    document.body.append(dot)
    vi.spyOn(dot, 'getBoundingClientRect').mockReturnValue(rect(90, 10, 19, 19))
    message('anchor-1', 'first passage')
    rangeRects = [rect(0, 10, 83, 20)]
    expect(stickerDotRects().map(box => box.left)).toEqual([90])
    renderBadges(store)
    store.update('pending', set('pending', 'set-pending', [dshItem(1, 'first passage', 'anchor-1')]))
    await flush()
    // Default slot is x = 83 + 7 = 90, y = 20 — inside the dot's band, so the
    // badge steps down one 24px rung to reach a free slot.
    expect(badges()[0]!.style.left).toBe('90px')
    expect(badges()[0]!.style.top).toBe('44px')
  })
})

describe('shared text-index invalidation filter', () => {
  it('ignores records that stayed inside the annotation hosts or touched other attributes', () => {
    const badgeHost = document.createElement('div'); badgeHost.dataset.dshAnnotationBadges = ''
    const dialogHost = document.createElement('div'); dialogHost.dataset.dshAnnotationDialogHost = ''
    const messageNode = document.createElement('p'); messageNode.dataset.chatAnchorKey = 'anchor-1'
    messageNode.textContent = 'text'
    document.body.append(badgeHost, dialogHost, messageNode)
    const record = (target: Node, type: MutationRecord['type'], attributeName: string | null = null) =>
      ({ target, type, attributeName } as unknown as MutationRecord)
    expect(affectsMessageText([record(badgeHost, 'childList')])).toBe(false)
    expect(affectsMessageText([record(dialogHost, 'characterData')])).toBe(false)
    // Layout-bearing attributes move the passage, so they must repaint even
    // though the characters are unchanged.
    expect(affectsMessageText([record(messageNode, 'attributes', 'class')])).toBe(true)
    expect(affectsMessageText([record(messageNode, 'attributes', 'style')])).toBe(true)
    expect(affectsMessageText([record(messageNode, 'attributes', 'hidden')])).toBe(true)
    expect(affectsMessageText([record(messageNode, 'attributes', 'data-streaming')])).toBe(true)
    // An attribute nobody reads stays ignored.
    expect(affectsMessageText([record(messageNode, 'attributes', 'title')])).toBe(false)
    expect(affectsMessageText([record(messageNode, 'attributes', 'data-chat-anchor-key')])).toBe(true)
    expect(affectsMessageText([record(messageNode, 'characterData')])).toBe(true)
    expect(affectsMessageText([record(messageNode.firstChild!, 'characterData')])).toBe(true)
  })

  it('follows a layout-only attribute change without waiting for a scroll', async () => {
    const store = new ReferenceHighlightStore()
    const node = message('anchor-1', 'first passage')
    rangeRects = [rect(0, 10, 120, 20)]
    renderBadges(store)
    store.update('pending', set('pending', 'set-pending', [dshItem(1, 'first passage', 'anchor-1')]))
    await flush()
    expect(badges()[0]!.style.left).toBe('127px')

    rangeRects = [rect(0, 10, 150, 20)]
    act(() => { node.setAttribute('class', 'is-expanded') })
    await flush()
    expect(badges()[0]!.style.left).toBe('157px')
  })
})
