// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { referenceRange, ReferenceHighlightStore } from '../src/client/reference-highlights.tsx'
describe('durable reference ranges', () => {
  it('matches repeated text across inline elements without touching message DOM', () => {
    const root = document.createElement('div'); root.innerHTML = 'before <b>选中</b>文字 and <i>选中</i>文字 after'
    const original = root.innerHTML
    const first = referenceRange(root, '选中文字', 0), second = referenceRange(root, '选中文字', 1)
    expect(first?.toString()).toBe('选中文字'); expect(second?.toString()).toBe('选中文字')
    expect(first?.startContainer).not.toBe(second?.startContainer)
    expect(referenceRange(root, '选中文字', 2)).toBeNull()
    expect(root.innerHTML).toBe(original)
    root.innerHTML = '<p>第一行</p><p>第二行 <b>重点</b></p>'
    expect(referenceRange(root, '第一行\n第二行 重点', 0)?.toString()).toBe('第一行第二行 重点')
  })
  it('does not guess a replacement range after source text changes', () => {
    const root = document.createElement('div'); root.textContent = 'modified source'
    expect(referenceRange(root, 'old source', 0)).toBeNull()
    const store = new ReferenceHighlightStore(); let updates = 0
    const unsubscribe = store.subscribe(() => updates++)
    store.update('composer', null); expect(updates).toBe(1)
    unsubscribe(); store.update('composer', null); expect(updates).toBe(1)
  })
})
