import { ReferenceIcon } from './reference-icons.tsx'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import type { ReferenceSet } from '../domain/model.ts'
import type { ClientSourceRegistry } from './source-registry.ts'

export interface AnnotationDialogSnapshot {
  readonly open: boolean
  readonly set?: ReferenceSet
  readonly focusReferenceId?: string
  readonly anchor?: DOMRect
  readonly editable: boolean
}

const CLOSED: AnnotationDialogSnapshot = Object.freeze({ open: false, editable: false })

export class AnnotationDialogController {
  private snapshot: AnnotationDialogSnapshot = CLOSED
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): AnnotationDialogSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }

  open(set: ReferenceSet, focusReferenceId?: string, anchor?: DOMRect): void {
    this.snapshot = Object.freeze({
      open: true,
      ...(anchor === undefined ? {} : { anchor }),
      set,
      editable: set.state === 'pending',
      ...(focusReferenceId === undefined ? {} : { focusReferenceId }),
    })
    this.emit()
  }

  replace(set: ReferenceSet): void {
    if (!this.snapshot.open || this.snapshot.set?.setId !== set.setId) return
    this.snapshot = Object.freeze({ ...this.snapshot, set, editable: set.state === 'pending' })
    this.emit()
  }

  close(): void { this.snapshot = CLOSED; this.emit() }
}

export interface ReferenceDialogProps {
  readonly controller: AnnotationDialogController
  readonly sources: ClientSourceRegistry
  readonly updateComment: (referenceId: string, comment: string) => Promise<void>
  readonly remove: (referenceId: string) => Promise<void>
  readonly deleteLink: (setId: string, referenceId: string) => Promise<void>
  readonly reuse: (referenceId: string) => Promise<void>
  readonly retryBacklink: (setId: string, referenceId: string) => Promise<void>
}

export function ReferenceDialog({ controller, sources, updateComment, remove, deleteLink, reuse, retryBacklink }: ReferenceDialogProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const layerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{left: number; top: number} | undefined>(undefined)
  const closeRef = useRef<HTMLButtonElement>(null)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [activeReferenceId, setActiveReferenceId] = useState<string>()
  const referenceIds = snapshot.set?.items.map((item) => item.referenceId).join('\u0000') ?? ''
  useEffect(() => {
    if (!snapshot.open || snapshot.set === undefined) return
    const preferred = snapshot.focusReferenceId !== undefined && snapshot.set.items.some((item) => item.referenceId === snapshot.focusReferenceId)
      ? snapshot.focusReferenceId
      : snapshot.set.items[0]?.referenceId
    setActiveReferenceId(preferred)
    setError('')
  }, [snapshot.open, snapshot.set?.setId, snapshot.focusReferenceId, referenceIds])
  useEffect(() => {
    if (!snapshot.open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || saving) return
      event.preventDefault()
      controller.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [controller, snapshot.open, saving])
  useEffect(() => {
    if (!snapshot.open) return
    const outside = (event: PointerEvent) => {
      if (!saving && !layerRef.current?.contains(event.target as Node)) controller.close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [controller, snapshot.open, saving])
  useEffect(() => {
    const item = snapshot.set?.items.find(item => item.referenceId === activeReferenceId)
    if (!snapshot.open || !snapshot.editable || item?.sourceType !== 'dsh-message' || item.locator.sessionId !== snapshot.set?.sessionId) return
    let cancelled = false
    const source = sources.forItem(item)
    if (source) void source.openSource(item).then(() => {
      if (!cancelled) commentRef.current?.focus({ preventScroll: true })
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [snapshot.open, snapshot.set?.setId, snapshot.editable, activeReferenceId, sources])
  useLayoutEffect(() => {
    if (!snapshot.open) { setPosition(undefined); return }
    const place = () => {
      const cards = [...document.querySelectorAll('[data-composer-card]')].map(card => card.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0)
      const anchor = snapshot.anchor ?? (cards.length === 1 ? cards[0] : undefined)
      const box = layerRef.current?.getBoundingClientRect()
      if (!box || !anchor) { setPosition(undefined); return }
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)),
        top: Math.max(8, anchor.top >= box.height + 16 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8)) })
    }
    place()
    const observer = new ResizeObserver(place)
    if (layerRef.current) observer.observe(layerRef.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [snapshot.open, snapshot.anchor, activeReferenceId])
  if (!snapshot.open || snapshot.set === undefined) return null
  const set = snapshot.set
  const activeItem = set.items.find((item) => item.referenceId === activeReferenceId)
    ?? set.items.find((item) => item.referenceId === snapshot.focusReferenceId)
    ?? set.items[0]
  if (activeItem === undefined) return null
  const source = sources.forItem(activeItem)
  const run = async (action: () => Promise<void>, close = false) => {
    if (saving) return
    setSaving(true); setError('')
    try { await action(); if (close) controller.close() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  const save = () => run(() => updateComment(activeItem.referenceId, commentRef.current?.value ?? activeItem.userComment), true)
  const dialog = <div ref={layerRef} className="dshAnnotationFloatingLayer" style={position ? { ...position, right: 'auto', bottom: 'auto', width: 'min(326px, calc(100vw - 16px))' } : undefined}>
    <section className="dshAnnotationDialog" data-annotation-floating-window role="dialog" aria-modal="false" aria-label={`${set.items.length} 条注释`}>
      <button className="dshAnnotationDialogClose" ref={closeRef} disabled={saving} type="button" onClick={() => controller.close()} aria-label="关闭注释详情"><ReferenceIcon name="close" /></button>
      {set.items.length > 1 && <nav className="dshAnnotationDialogTabs" aria-label="选择注释">
        {set.items.map((item) => <button
          className="dshAnnotationDialogTab"
          type="button"
          disabled={saving} aria-label={`查看注释 ${item.number}`}
          aria-pressed={item.referenceId === activeItem.referenceId}
          onClick={() => { setActiveReferenceId(item.referenceId); setError('') }}
          key={item.referenceId}
        >{item.sourceType === 'obsidian-note' ? item.locator.notePath.split('/').pop() : item.sourceType === 'extension' ? item.locator.providerId : item.locator.upstream?.sourceTitle ?? item.selectedText.slice(0, 18)}</button>)}
      </nav>}
      <div className="dshAnnotationDialogBody">
        <article
          className="dshAnnotationDetail"
          data-annotation-reference={activeItem.referenceId}
          data-focused={snapshot.focusReferenceId === activeItem.referenceId || undefined}
          key={activeItem.referenceId}
        >
          <blockquote className="dshAnnotationSelected">{activeItem.selectedText}</blockquote>
          <label className="dshAnnotationCommentField">
            <span className="dshAnnotationCommentLabel"><strong>注释</strong></span>
            {snapshot.editable
              ? <textarea
                  ref={commentRef}
                  className="dshAnnotationComment"
                  defaultValue={activeItem.userComment}
                  placeholder="添加注释…"
                  autoFocus
                  disabled={saving}
                  onKeyDown={event => {
                    event.stopPropagation()
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void save() }
                    if (event.key === 'Escape') { event.preventDefault(); if (!saving) controller.close() }
                  }}
                />
              : <div className="dshAnnotationCommentReadOnly">{activeItem.userComment || '暂无注释'}</div>}
          </label>
          {error && <div role="alert" className="dshAnnotationBlocked">{error}</div>}
          <div className="dshAnnotationActions">
            {source !== undefined && <button className="dshAnnotationIconButton" type="button" disabled={saving} title="跳转到引用位置" aria-label="跳转到引用位置" onClick={() => void run(() => source.openSource(activeItem))}><ReferenceIcon name="jump" /></button>}
            {snapshot.editable
              ? <>
                <button className="dshAnnotationIconButton" type="button" disabled={saving} aria-label="删除引用" title="删除引用" onClick={() => void run(() => remove(activeItem.referenceId))}><ReferenceIcon name="trash" /></button>

                <button className="dshAnnotationIconButton dshAnnotationSave" type="button" disabled={saving} aria-label="保存注释" title="保存注释 · Enter" onClick={() => void save()}><ReferenceIcon name="check" /></button>
              </>
              : <>
                  <button className="dshAnnotationIconButton" type="button" disabled={saving} aria-label="重新添加到当前提问" title="重新添加到当前提问" onClick={() => void run(() => reuse(activeItem.referenceId))}><ReferenceIcon name="plus" /></button>
                  <button className="dshAnnotationIconButton" aria-label="解除双向引用" title="解除双向引用" type="button" onClick={() => {
                    if (!globalThis.confirm('删除这条双向引用？DSH 中已发送的历史消息不会被改写，但双方的引用关系和 Obsidian 生成块都会删除。')) return
                    void deleteLink(set.setId, activeItem.referenceId)
                  }}><ReferenceIcon name="unlink" /></button>
                </>}
            {!snapshot.editable && activeItem.backlinkState === 'failed' && <button className="dshAnnotationIconButton" type="button" disabled={saving} aria-label="重试回链" title="重试回链" onClick={() => void run(() => retryBacklink(set.setId, activeItem.referenceId))}><ReferenceIcon name="retry" /></button>}
          </div>
        </article>
      </div>
    </section>
  </div>
  return createPortal(dialog, document.body)
}
