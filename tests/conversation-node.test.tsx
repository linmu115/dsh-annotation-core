// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  conversationContextKey: (kind: string, id: string) => `${kind}:${id}`,
}))

import { AnnotationConversationNode } from '../src/client/conversation-node.tsx'
import { annotationConversationDefinition, suppressGenericAnnotationRow } from '../src/rc2/conversation-projection.tsx'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()) })

function event(id = 'context-1', target = 'user-1') {
  return {
    seq: 7,
    type: 'user/message',
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text: '<dsh-annotations />' }],
      source: { kind: 'dsh-annotation', schemaVersion: 1, setId: 'set-1', targetUserMessageId: target, count: 2, digest: 'sha256:' + 'a'.repeat(64) },
    },
  }
}

describe('annotation conversation projection', () => {
  it('projects one stable right-aligned pill from the durable source event', async () => {
    const matched = annotationConversationDefinition.match(event() as never)
    expect(matched).toEqual({ id: 'context-1', role: 'start' })
    const match = { event: event(), role: 'start', location: { kind: 'session' }, view: undefined } as never
    const state = annotationConversationDefinition.start({ key: 'k', kind: 'dsh-annotation', id: 'context-1', matches: [match], start: match, state: undefined, current: new Map() }, match, { previous: () => undefined })
    const node = annotationConversationDefinition.buildViewNode?.({ key: 'k', kind: 'dsh-annotation', id: 'context-1', matches: [match], start: match, state, current: new Map() })
    expect(node).toMatchObject({ key: 'k', kind: 'dsh-annotation', id: 'context-1', target: 'chat', anchorSeq: 7, visibility: 'visible' })

    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(<AnnotationConversationNode count={2} open={() => undefined} />))
    expect(host.textContent).toBe('2 条注释')
    expect(host.querySelector('button')?.className).toContain('sentPill')
  })

  it('hides and restores only the exact generic context row', () => {
    const exact = document.createElement('div'); exact.dataset.chatAnchorKey = 'exact'
    const ordinary = document.createElement('div'); ordinary.dataset.chatAnchorKey = 'ordinary'
    const wrong = document.createElement('div'); wrong.dataset.chatAnchorKey = 'wrong-message'
    document.body.append(exact, ordinary, wrong)
    const dispose = suppressGenericAnnotationRow('exact', document)
    expect(exact.hidden).toBe(true)
    expect(ordinary.hidden).toBe(false)
    expect(wrong.hidden).toBe(false)
    dispose()
    expect(exact.hidden).toBe(false)
  })

  it('supports immutable details actions without renumbering sent references', async () => {
    const open = vi.fn()
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host); roots.push(root)
    await act(async () => root.render(<AnnotationConversationNode count={1} open={open} />))
    await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
    expect(open).toHaveBeenCalledTimes(1)
  })
})
