import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'
import type { ReferenceSessionStore } from './composer-binding.tsx'
import { ReferenceIcon } from './reference-icons.tsx'

export interface ReferenceRailProps {
  readonly layout: 'default' | 'narrow'
  readonly store: ReferenceSessionStore
  readonly open: (set: ReferenceSet, referenceId?: string, anchor?: DOMRect) => void
  readonly remove: (referenceId: string) => Promise<void>
  readonly jump?: ((item: ReferenceItem) => Promise<void>) | undefined
}

function sourceLabel(set: ReferenceSet, referenceId: string): string {
  const item = set.items.find((candidate) => candidate.referenceId === referenceId)
  if (item?.sourceType === 'obsidian-note') {
    const status = item.snapshot.freshness === 'captured' ? '已捕获' : item.snapshot.freshness === 'refreshed' ? '已刷新' : '离线快照'
    return `Obsidian · ${item.locator.notePath} · ${status}`
  }
  if (item?.sourceType === 'dsh-message' && item.locator.upstream)
    return `上游引用 · ${item.locator.upstream.sourceTitle} · 至所选回复结束`
  return 'DSH 会话'
}

export function ReferenceRail({ layout, store, open, remove, jump }: ReferenceRailProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const set = snapshot.pending
  const [expanded, expand] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const suppressFocus = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keep = () => { clearTimeout(timer.current); expand(true) }
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => {
    if (!panel.current?.contains(document.activeElement) && document.activeElement !== trigger.current) expand(false)
  }, 180) }
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!expanded) return
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), box = panel.current?.getBoundingClientRect()
      if (!anchor || !box) return
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)),
        top: Math.max(8, anchor.top >= box.height + 16 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8)) })
    }
    place()
    const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [expanded, set?.items.length])
  useEffect(() => {
    if (!expanded) return
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) expand(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { expand(false); suppressFocus.current = true; trigger.current?.focus(); suppressFocus.current = false } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [expanded])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  if (set === null || set.items.length === 0) {
    return snapshot.status === 'blocked' ? <div className="dshAnnotationBlocked" role="status">引用暂不可用，请稍后重试</div> : null
  }
  return <div className={`dshAnnotationRail ${layout}`} aria-label="待发送引用">
    <button ref={trigger} className="dshAnnotationCount" type="button" data-annotation-chip aria-expanded={expanded} aria-haspopup="dialog"
      onMouseEnter={keep} onMouseLeave={leave} onFocus={() => { if (!suppressFocus.current) keep() }} onBlur={leave} onClick={keep}>
      <ReferenceIcon name="quote" /><span>{set.items.length} 条</span>
    </button>
    {expanded && createPortal(<div ref={panel} className="dshAnnotationPopover" style={position} role="dialog" aria-label="待发送引用列表"
      onMouseEnter={keep} onMouseLeave={leave} onFocus={keep} onBlur={leave}>
      {set.items.map(item => <article className="dshAnnotationListItem" key={item.referenceId}>
        <div className="dshAnnotationListHeading"><span className="dshAnnotationSource">{item.number}. {sourceLabel(set, item.referenceId)}</span>
          <div className="dshAnnotationRowActions">
            <button type="button" className="dshAnnotationIconButton" aria-label={`编辑引用 ${item.number}`} title="编辑评论" disabled={busy} onClick={() => { expand(false); open(set, item.referenceId, trigger.current?.getBoundingClientRect()) }}><ReferenceIcon name="edit" /></button>
            {jump && <button type="button" className="dshAnnotationIconButton" aria-label={`跳转到引用 ${item.number}`} title="跳转到引用位置" disabled={busy} onClick={() => void run(() => jump(item))}><ReferenceIcon name="jump" /></button>}
            <button type="button" className="dshAnnotationIconButton" aria-label={`删除引用 ${item.number}`} title="删除引用" disabled={busy} onClick={() => void run(() => remove(item.referenceId))}><ReferenceIcon name="trash" /></button>
          </div>
        </div>
        <blockquote>{item.selectedText}</blockquote>
        {item.userComment && <p className="dshAnnotationListComment">{item.userComment}</p>}
      </article>)}
      {error && <div role="alert" className="dshAnnotationBlocked">{error}</div>}
    </div>, document.body)}
  </div>
}
