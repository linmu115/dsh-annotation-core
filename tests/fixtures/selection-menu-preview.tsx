import { createRoot } from 'react-dom/client'
import { SelectionToolbar } from '../../src/client/selection-toolbar.tsx'
import { SelectionActions } from '../../src/client/selection-actions.ts'
import type { SelectionController, SelectionState } from '../../src/client/selection-capture.ts'
const menuListeners = new Set<() => void>()
let menuState: SelectionState = { selection: null }
const selectionController = { getSnapshot: () => menuState, subscribe: (fn: () => void) => { menuListeners.add(fn); return () => { menuListeners.delete(fn) } }, clear: () => { menuState = { selection: null }; menuListeners.forEach(fn => fn()) }, dispose: () => {} } as SelectionController
const menuHost = document.createElement('div'); document.body.append(menuHost)
const menuButton = document.createElement('button'); menuButton.textContent = '预览选区纵向菜单'; document.querySelector('main')!.append(menuButton)
menuButton.onclick = () => { const rect = menuButton.getBoundingClientRect(); menuState = { selection: { text: '选中文本', anchorId: 'a', sessionId: 'source', role: 'assistant', occurrence: 0, range: document.createRange(), rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } } }; menuListeners.forEach(fn => fn()) }
const actions = new SelectionActions()
actions.register({ id: 'fixture', label: '跨会话引用', run: async () => {} })
createRoot(menuHost).render(<SelectionToolbar controller={selectionController} core={{ selectionActions: actions } as never} />)
