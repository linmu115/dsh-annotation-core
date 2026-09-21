// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import {
  LAYOUT_ATTRIBUTES, affectsMessageText, clearReferenceTextIndex, markReferenceTextDirty,
  normalizeReferenceText, referenceTextIndex,
} from '../src/client/reference-text-index.ts'

function message(text: string): HTMLElement {
  const node = document.createElement('p')
  node.dataset.chatAnchorKey = 'anchor-1'
  node.textContent = text
  document.body.append(node)
  return node
}

afterEach(() => { clearReferenceTextIndex(); document.body.replaceChildren() })

describe('shared reference text index', () => {
  it('reuses the measured table across reads until a mutation marks it stale', () => {
    const node = message('引用 上下文')
    const first = referenceTextIndex(node)
    // Non-whitespace characters only, in document order.
    expect(first.content).toBe('引用上下文')
    expect(referenceTextIndex(node)).toBe(first)

    node.textContent = '引用 上下文 变了'
    // Still the old table: only the observer's dirty mark invalidates it.
    expect(referenceTextIndex(node)).toBe(first)

    markReferenceTextDirty()
    const second = referenceTextIndex(node)
    expect(second).not.toBe(first)
    expect(second.content).toBe('引用上下文变了')
  })

  it('drops the whole table on the explicit clear', () => {
    const node = message('正文')
    const first = referenceTextIndex(node)
    clearReferenceTextIndex()
    expect(referenceTextIndex(node)).not.toBe(first)
  })

  it('never retains a detached root, so removed messages cannot pin subtrees', () => {
    const node = message('正文')
    const detached = document.createElement('p')
    detached.textContent = '游离'
    expect(referenceTextIndex(node).content).toBe('正文')
    expect(referenceTextIndex(detached).content).toBe('游离')
    // Reading a detached root twice measures twice instead of caching it.
    expect(referenceTextIndex(detached)).not.toBe(referenceTextIndex(detached))
  })

  it('lists exactly the attributes a layout change can travel through', () => {
    expect([...LAYOUT_ATTRIBUTES].sort()).toEqual(['class', 'data-chat-anchor-key', 'data-streaming', 'hidden', 'style'])
  })

  it('projects a quote onto the indexed character stream', () => {
    expect(normalizeReferenceText('引用\n上下文')).toBe('引用上下文')
    expect(normalizeReferenceText('a\u200bb')).toBe('ab')
  })

  it('ignores content-free attribute records that live inside this plugin', () => {
    const host = document.createElement('div')
    host.dataset.dshAnnotationBadges = ''
    document.body.append(host)
    const record = (target: Node, attributeName: string) => ({ target, type: 'attributes', attributeName } as unknown as MutationRecord)
    expect(affectsMessageText([record(host, 'style')])).toBe(false)
    const node = message('正文')
    expect(affectsMessageText([record(node, 'style')])).toBe(true)
  })
})
