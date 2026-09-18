import { Component, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import type { DshMessageCapture } from '../protocol/index.ts'
import type { AnnotationCoreClientService } from './service.tsx'
import { createSelectionController, type SelectionController, type SelectionSnapshot } from './selection-capture.ts'
import { selectionStyle } from './selection-style.ts'

export function messageCapture(selection: SelectionSnapshot): DshMessageCapture {
  return { selectedText: selection.text, sourceSessionId: selection.sessionId, anchorId: selection.anchorId,
    ...(selection.messageId ? { messageId: selection.messageId } : {}), role: selection.role, occurrence: selection.occurrence }
}

class SelectionErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override componentDidCatch(error: unknown) { console.error('[annotation-core] selection toolbar unavailable', error) }
  override render(): ReactNode { return this.state.failed ? null : this.props.children }
}
export function SelectionToolbar(props: { core: AnnotationCoreClientService; controller: SelectionController }) {
  return <SelectionErrorBoundary><SelectionToolbarInner {...props} /></SelectionErrorBoundary>
}
function SelectionToolbarInner({ core, controller }: { core: AnnotationCoreClientService; controller: SelectionController }) {
  const state = useSyncExternalStore(useCallback((notify: () => void) => controller.subscribe(notify), [controller]), () => controller.getSnapshot())
  const actions = useSyncExternalStore(core.selectionActions.subscribe, core.selectionActions.getSnapshot)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const active = useRef(false), alive = useRef(true), menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const snapshot = state.selection
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setError(null) }, [snapshot])
  useLayoutEffect(() => {
    if (!snapshot) return
    const place = () => {
      const box = menu.current?.getBoundingClientRect()
      if (!box) return
      const below = snapshot.rect.top + (snapshot.rect.height ?? 24) + 8
      setPosition({ left: Math.max(8, Math.min(snapshot.rect.left, window.innerWidth - box.width - 8)),
        top: Math.max(8, below + box.height < window.innerHeight - 8 ? below : snapshot.rect.top - box.height - 8) })
    }
    place()
    const observer = new ResizeObserver(place)
    if (menu.current) observer.observe(menu.current)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [snapshot, error])
  useEffect(() => {
    if (!snapshot) return
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !active.current) controller.clear() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !active.current) { controller.clear(); return }
      if (!menu.current?.contains(document.activeElement) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const buttons = [...menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      if (!buttons.length) return
      event.preventDefault()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [snapshot, controller])
  if (!snapshot) return null
  const capture = messageCapture(snapshot)
  const run = async (action: (input: DshMessageCapture) => Promise<unknown>) => {
    if (active.current) return
    active.current = true; setBusy(true); setError(null)
    try {
      await action(capture)
      if (controller.getSnapshot().selection === snapshot) { controller.clear(); window.getSelection()?.removeAllRanges() }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '引用未完成，请重试') }
    finally { active.current = false; if (alive.current) setBusy(false) }
  }
  return <><style>{selectionStyle}</style><div ref={menu} className="dsh-core-selection-toolbarWrap" style={position}>
    <div className="dsh-core-selection-toolbar" role="menu" aria-label="选文操作">
      <button type="button" role="menuitem" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void run(async input => {
        const source = await core.createDshMessageSource(input)
        await core.addReference(input.sourceSessionId, source)
      })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v11H9l-4 4Z" /></svg>添加到当前会话</button>
      {actions.filter(action => !action.available || action.available(capture)).map(action => <button key={action.id} type="button" role="menuitem" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void run(input => action.run(input))}>{action.iconPath && <svg viewBox="0 0 24 24" aria-hidden="true"><path d={action.iconPath} /></svg>}{typeof action.label === 'function' ? action.label() : action.label}</button>)}
    </div>{error && <div className="dsh-core-selection-error" role="alert">{error}</div>}
  </div></>
}

export function applyNativeSelection(ctx: Context, core: AnnotationCoreClientService): void {
  ctx.effect(() => {
    const sessions = ctx.sessions as unknown as { list: { getSnapshot(): { current?: string }; subscribe(notify: () => void): () => void } }
    const controller = createSelectionController(() => sessions.list.getSnapshot().current ?? '')
    let current = sessions.list.getSnapshot().current
    const stopSession = sessions.list.subscribe(() => { const next = sessions.list.getSnapshot().current; if (next !== current) { current = next; controller.clear() } })
    const host = document.createElement('div')
    host.dataset.dshCoreSelection = ''
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(<SelectionToolbar core={core} controller={controller} />)
    return () => { stopSession(); controller.dispose(); setTimeout(() => root.unmount()); host.remove() }
  }, 'annotation-core.native-selection')
}
