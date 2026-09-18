import { ReferenceIcon } from './reference-icons.tsx'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'
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

function sourceDescription(item: ReferenceItem): string {
  if(item.sourceType==='dsh-message'&&item.locator.upstream)return `${item.locator.upstream.sourceTitle} · 包含截至该回复完整结束的上游 · AI 按需读取`
  if (item.sourceType === 'dsh-message') return `${item.locator.role === 'user' ? '用户' : '助手'}消息 · ${item.locator.sessionId}`
  const freshness = item.snapshot.freshness === 'captured' ? '已捕获' : item.snapshot.freshness === 'refreshed' ? '已刷新' : '离线快照'
  return `${item.locator.notePath} · ${freshness}`
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
  useLayoutEffect(() => {
    if (!snapshot.open || !snapshot.anchor) { setPosition(undefined); return }
    const anchor = snapshot.anchor
    const place = () => {
      const box = layerRef.current?.getBoundingClientRect()
      if (!box) return
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)),
        top: Math.max(8, anchor.top >= box.height + 16 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8)) })
    }
    place()
    const observer = new ResizeObserver(place)
    if (layerRef.current) observer.observe(layerRef.current)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
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
  const dialog = <div ref={layerRef} className="dshAnnotationFloatingLayer" style={position ? { ...position, right: 'auto', bottom: 'auto', width: 'min(460px, calc(100vw - 16px))' } : undefined}>
    <section className="dshAnnotationDialog" data-annotation-floating-window role="dialog" aria-modal="false" aria-label={`${set.items.length} 条注释`}>
      <header className="dshAnnotationDialogHeader">
        <div className="dshAnnotationDialogTitle">
          <span className="dshAnnotationDialogIcon"><ReferenceIcon name="quote" /></span>
          <span><strong>{set.items.length} 条引用</strong><small>引用与评论</small></span>
        </div>
        <button className="dshAnnotationDialogClose" ref={closeRef} disabled={saving} type="button" onClick={() => controller.close()} aria-label="关闭注释详情">×</button>
      </header>
      {set.items.length > 1 && <nav className="dshAnnotationDialogTabs" aria-label="选择注释">
        {set.items.map((item) => <button
          className="dshAnnotationDialogTab"
          type="button"
          disabled={saving} aria-label={`查看注释 ${item.number}`}
          aria-pressed={item.referenceId === activeItem.referenceId}
          onClick={() => setActiveReferenceId(item.referenceId)}
          key={item.referenceId}
        >{item.number}</button>)}
      </nav>}
      <div className="dshAnnotationDialogBody">
        <article
          className="dshAnnotationDetail"
          data-annotation-reference={activeItem.referenceId}
          data-focused={snapshot.focusReferenceId === activeItem.referenceId || undefined}
          key={activeItem.referenceId}
        >
          <div className="dshAnnotationDetailHeading">
            <span className="dshAnnotationNumber">{activeItem.number}</span>
            <span className="dshAnnotationSource">{sourceDescription(activeItem)}</span>
          </div>
          <blockquote className="dshAnnotationSelected">{activeItem.selectedText}</blockquote>
          <label className="dshAnnotationCommentField">
            <span className="dshAnnotationCommentLabel"><strong>补充说明</strong>{snapshot.editable && <small>Enter 保存 · Shift + Enter 换行</small>}</span>
            {snapshot.editable
              ? <textarea
                  ref={commentRef}
                  className="dshAnnotationComment"
                  defaultValue={activeItem.userComment}
                  placeholder="写下希望模型特别关注、比较或解释的内容……"
                  autoFocus
                  disabled={saving}
                  onKeyDown={event => {
                    event.stopPropagation()
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void save() }
                    if (event.key === 'Escape') { event.preventDefault(); if (!saving) controller.close() }
                  }}
                />
              : <div className="dshAnnotationCommentReadOnly">{activeItem.userComment || '没有补充说明'}</div>}
          </label>
          {error && <div role="alert" className="dshAnnotationBlocked">{error}</div>}
          <div className="dshAnnotationActions">
            {source !== undefined && <button className="dshAnnotationIconButton" type="button" disabled={saving} title="跳转到引用位置" aria-label="跳转到引用位置" onClick={() => void run(() => source.openSource(activeItem))}><ReferenceIcon name="jump" /></button>}
            {snapshot.editable
              ? <>
                <button className="dshAnnotationIconButton" type="button" disabled={saving} aria-label="删除引用" title="删除引用" onClick={() => void run(() => remove(activeItem.referenceId))}><ReferenceIcon name="trash" /></button>
                <span className="dshAnnotationActionSpacer" />
                <button className="dshAnnotationAction" type="button" disabled={saving} onClick={() => controller.close()}>取消</button>
                <button className="dshAnnotationAction primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
              </>
              : <>
                  <button className="dshAnnotationAction primary" type="button" onClick={() => void reuse(activeItem.referenceId)}>重新添加到当前提问</button>
                  <button className="dshAnnotationAction danger" type="button" onClick={() => {
                    if (!globalThis.confirm('删除这条双向引用？DSH 中已发送的历史消息不会被改写，但双方的引用关系和 Obsidian 生成块都会删除。')) return
                    void deleteLink(set.setId, activeItem.referenceId)
                  }}>删除双向引用</button>
                </>}
            {!snapshot.editable && activeItem.backlinkState === 'failed' && <button className="dshAnnotationAction" type="button" onClick={() => void retryBacklink(set.setId, activeItem.referenceId)}>重试回链</button>}
          </div>
        </article>
      </div>
    </section>
  </div>
  return createPortal(dialog, document.body)
}
