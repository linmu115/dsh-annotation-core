// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SelectionActions } from '../src/client/selection-actions.ts'
import { SelectionToolbar } from '../src/client/selection-toolbar.tsx'

it('owns within-session references without a sidebar, and removes contributed actions when their owner unloads', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), actions = new SelectionActions()
  const source = { sourceType: 'dsh-message' }, capture = { text: '原文'.repeat(3000), sessionId: 'native-source', messageId: 'reply', anchorId: 'anchor', occurrence: 2, role: 'assistant', rect: { left: 1, top: 2, width: 40, height: 20 } }
  const state = { selection: capture }, controller = { subscribe: () => () => {}, getSnapshot: () => state, clear: vi.fn() }
  const core = { selectionActions: actions, createDshMessageSource: vi.fn(async () => source), addReference: vi.fn(async () => ({ referenceId: "new-reference" })), openPendingComment: vi.fn(async () => {}) }
  try {
    await act(async () => root.render(<SelectionToolbar core={core as never} controller={controller as never} />))
    expect(host.querySelectorAll('button')).toHaveLength(1)
    await act(async () => host.querySelector('button')!.click())
    expect(core.createDshMessageSource).toHaveBeenCalledWith({ selectedText: capture.text, sourceSessionId: 'native-source', messageId: 'reply', anchorId: 'anchor', role: 'assistant', occurrence: 2 })
    expect(core.addReference).toHaveBeenCalledWith('native-source', source)
    expect(core.openPendingComment).toHaveBeenCalledWith('native-source', 'new-reference')
    const run = vi.fn(async () => {})
    let unregister = () => {}
    await act(async () => { unregister = actions.register({ id: 'thoughtdag.reference', label: '跨会话引用', run }) })
    expect(host.querySelectorAll('button')).toHaveLength(2)
    await act(async () => host.querySelectorAll('button')[1]!.click())
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ occurrence: 2, sourceSessionId: 'native-source' }))
    await act(async () => unregister())
    expect(host.querySelectorAll('button')).toHaveLength(1)
    expect(() => actions.register({ id: '', label: '', run })).toThrow()
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})

it('rejects duplicate owners and an old disposer cannot remove a later registration', () => {
  const actions = new SelectionActions(), action = { id: 'sidechat.ask', label: '侧聊', run: async () => {} }
  const first = actions.register(action)
  expect(() => actions.register(action)).toThrow()
  first()
  const second = { ...action, label: '新侧聊' }
  const remove = actions.register(second)
  first()
  expect(actions.getSnapshot()).toEqual([second])
  remove(); expect(actions.getSnapshot()).toEqual([])
})
