import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'
import type { ClientSourceRegistry } from './source-registry.ts'

export interface AnnotationDialogSnapshot {
  readonly open: boolean
  readonly set?: ReferenceSet
  readonly focusReferenceId?: string
  readonly editable: boolean
}

const CLOSED: AnnotationDialogSnapshot = Object.freeze({ open: false, editable: false })

export class AnnotationDialogController {
  private snapshot: AnnotationDialogSnapshot = CLOSED
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): AnnotationDialogSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }

  open(set: ReferenceSet, focusReferenceId?: string): void {
    this.snapshot = Object.freeze({
      open: true,
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
  readonly reuse: (referenceId: string) => Promise<void>
  readonly retryBacklink: (setId: string, referenceId: string) => Promise<void>
}

function sourceDescription(item: ReferenceItem): string {
  if (item.sourceType === 'dsh-message') return `${item.locator.role === 'user' ? '用户' : '助手'}消息 · ${item.locator.sessionId}`
  const freshness = item.snapshot.freshness === 'captured' ? '已捕获' : item.snapshot.freshness === 'refreshed' ? '已刷新' : '离线快照'
  return `${item.locator.notePath} · ${freshness}`
}

export function ReferenceDialog({ controller, sources, updateComment, remove, reuse, retryBacklink }: ReferenceDialogProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const closeRef = useRef<HTMLButtonElement>(null)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const [activeReferenceId, setActiveReferenceId] = useState<string>()
  const referenceIds = snapshot.set?.items.map((item) => item.referenceId).join('\u0000') ?? ''
  useEffect(() => {
    if (!snapshot.open || snapshot.set === undefined) return
    const preferred = snapshot.focusReferenceId !== undefined && snapshot.set.items.some((item) => item.referenceId === snapshot.focusReferenceId)
      ? snapshot.focusReferenceId
      : snapshot.set.items[0]?.referenceId
    setActiveReferenceId(preferred)
  }, [snapshot.open, snapshot.set?.setId, snapshot.focusReferenceId, referenceIds])
  useEffect(() => {
    if (!snapshot.open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      controller.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [controller, snapshot.open])
  if (!snapshot.open || snapshot.set === undefined) return null
  const set = snapshot.set
  const activeItem = set.items.find((item) => item.referenceId === activeReferenceId)
    ?? set.items.find((item) => item.referenceId === snapshot.focusReferenceId)
    ?? set.items[0]
  if (activeItem === undefined) return null
  const source = sources.forItem(activeItem)
  const dialog = <div className="dshAnnotationFloatingLayer">
    <section className="dshAnnotationDialog" data-annotation-floating-window role="dialog" aria-modal="false" aria-label={`${set.items.length} 条注释`}>
      <header className="dshAnnotationDialogHeader">
        <div className="dshAnnotationDialogTitle">
          <span className="dshAnnotationDialogIcon" aria-hidden="true">✦</span>
          <span><strong>{set.items.length} 条注释</strong><small>引用详情与补充说明</small></span>
        </div>
        <button className="dshAnnotationDialogClose" ref={closeRef} type="button" onClick={() => controller.close()} aria-label="关闭注释详情">×</button>
      </header>
      {set.items.length > 1 && <nav className="dshAnnotationDialogTabs" aria-label="选择注释">
        {set.items.map((item) => <button
          className="dshAnnotationDialogTab"
          type="button"
          aria-label={`查看注释 ${item.number}`}
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
            <span className="dshAnnotationCommentLabel"><strong>补充说明</strong>{snapshot.editable && <small>失焦时自动保存</small>}</span>
            {snapshot.editable
              ? <textarea
                  ref={commentRef}
                  className="dshAnnotationComment"
                  defaultValue={activeItem.userComment}
                  placeholder="写下希望模型特别关注、比较或解释的内容……"
                  onBlur={(event) => {
                    if (event.currentTarget.value !== activeItem.userComment) void updateComment(activeItem.referenceId, event.currentTarget.value)
                  }}
                />
              : <div className="dshAnnotationCommentReadOnly">{activeItem.userComment || '没有补充说明'}</div>}
          </label>
          <div className="dshAnnotationActions">
            {source !== undefined && <button className="dshAnnotationAction" type="button" onClick={() => void source.openSource(activeItem)}>打开来源</button>}
            {source?.copySourceLink !== undefined && <button className="dshAnnotationAction" type="button" onClick={() => void source.copySourceLink?.(activeItem).then((text) => navigator.clipboard.writeText(text))}>复制来源链接</button>}
            {snapshot.editable
              ? <button className="dshAnnotationAction danger" type="button" onClick={() => void remove(activeItem.referenceId)}>删除</button>
              : <button className="dshAnnotationAction primary" type="button" onClick={() => void reuse(activeItem.referenceId)}>重新添加到当前提问</button>}
            {!snapshot.editable && activeItem.backlinkState === 'failed' && <button className="dshAnnotationAction" type="button" onClick={() => void retryBacklink(set.setId, activeItem.referenceId)}>重试回链</button>}
          </div>
        </article>
      </div>
    </section>
  </div>
  return createPortal(dialog, document.body)
}
