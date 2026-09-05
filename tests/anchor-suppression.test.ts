// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { suppressGenericAnnotationRow } from '../src/client/conversation-projection.tsx'

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.restoreAllMocks(); document.body.replaceChildren() })
function subscribe(key: string, root: Document | HTMLElement = document) {
  const dispose = suppressGenericAnnotationRow(key, root); disposers.push(dispose); return dispose
}
function row(key: string) { const row = document.createElement('div'); row.dataset.chatAnchorKey = key; return row }
async function delivery() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('shared annotation anchor index', () => {
  it.each([50, 200, 500])('uses one observer and no root rescans for %i subscriptions', async (count) => {
    const root = document.createElement('main'); document.body.append(root)
    root.append(...Array.from({ length: count }, (_, i) => row(String(i))))
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const query = vi.spyOn(root, 'querySelectorAll')
    const release = Array.from({ length: count }, (_, i) => subscribe(String(i), root))
    expect(observe).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    expect([...root.children].every(element => (element as HTMLElement).hidden)).toBe(true)
    const next = row('0'); root.append(next)
    const subtreeQuery = vi.spyOn(next, 'querySelectorAll')
    await delivery()
    expect(next.hidden).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
    expect(subtreeQuery).toHaveBeenCalledTimes(1)
    // Changing one anchor needs no query, even with 500 unrelated anchors.
    next.dataset.chatAnchorKey = 'unrelated'; await delivery()
    expect(next.hidden).toBe(false)
    expect(subtreeQuery).toHaveBeenCalledTimes(1)
    for (const dispose of release) dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('reference-counts duplicate consumers with idempotent cleanup and restores prior hidden state', () => {
    const visible = row('same'), hidden = row('same'); hidden.hidden = true
    document.body.append(visible, hidden)
    const first = subscribe('same'), second = subscribe('same')
    first(); first(); expect(visible.hidden).toBe(true)
    second(); expect(visible.hidden).toBe(false); expect(hidden.hidden).toBe(true)
    const remount = subscribe('same'); expect(visible.hidden).toBe(true)
    remount(); expect(visible.hidden).toBe(false)
  })

  it('handles replacement, rekey, removal and immediate remount before mutation delivery', async () => {
    const root = document.createElement('main'); document.body.append(root)
    const old = row('a'); root.append(old)
    const release = subscribe('a', root)
    const next = row('a'); old.replaceWith(next)
    const second = subscribe('a', root)
    expect(old.hidden).toBe(false); expect(next.hidden).toBe(true)
    release(); await delivery(); expect(next.hidden).toBe(true)
    next.dataset.chatAnchorKey = 'b'; await delivery(); expect(next.hidden).toBe(false)
    const third = subscribe('b', root); expect(next.hidden).toBe(true)
    next.remove(); next.removeAttribute('data-chat-anchor-key'); await delivery()
    expect(next.hidden).toBe(false)
    second(); third()
  })

  it('shares global ownership across overlapping roots and releases detached descendants', async () => {
    const root = document.createElement('main'), wrapper = document.createElement('section'), child = row('a')
    wrapper.append(child); root.append(wrapper); document.body.append(root)
    const outer = subscribe('a'), inner = subscribe('a', root)
    outer(); expect(child.hidden).toBe(true)
    wrapper.remove(); child.removeAttribute('data-chat-anchor-key'); await delivery()
    expect(child.hidden).toBe(false)
    inner()
  })

  it('coalesces repeated attribute changes and restores when disposed before queued work', async () => {
    const child = row('a'); document.body.append(child)
    const release = subscribe('a')
    child.dataset.chatAnchorKey = 'b'; child.dataset.chatAnchorKey = 'a'
    await delivery(); expect(child.hidden).toBe(true)
    const added = row('a'); document.body.append(added)
    await Promise.resolve(); release(); await delivery()
    expect(child.hidden).toBe(false); expect(added.hidden).toBe(false)
  })
})
