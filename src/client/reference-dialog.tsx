import { useEffect, useRef, useSyncExternalStore } from 'react'

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
  useEffect(() => { if (snapshot.open) closeRef.current?.focus() }, [snapshot.open])
  if (!snapshot.open || snapshot.set === undefined) return null
  const set = snapshot.set
  return <div className="dshAnnotationDialogBackdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) controller.close()
  }}>
    <section className="dshAnnotationDialog" role="dialog" aria-modal="true" aria-label={`${set.items.length} 条注释`}>
      <header className="dshAnnotationDialogHeader">
        <strong>{set.items.length} 条注释</strong>
        <button ref={closeRef} type="button" onClick={() => controller.close()} aria-label="关闭注释详情">×</button>
      </header>
      <div className="dshAnnotationDialogBody">
        {set.items.map((item) => <article
          className="dshAnnotationDetail"
          data-annotation-reference={item.referenceId}
          data-focused={snapshot.focusReferenceId === item.referenceId || undefined}
          key={item.referenceId}
        >
          <h3>注释 {item.number}</h3>
          <p className="dshAnnotationSource">{sourceDescription(item)}</p>
          <div className="dshAnnotationSelected">{item.selectedText}</div>
          <label>补充注解
            {snapshot.editable
              ? <textarea className="dshAnnotationComment" defaultValue={item.userComment} onBlur={(event) => {
                  if (event.currentTarget.value !== item.userComment) void updateComment(item.referenceId, event.currentTarget.value)
                }} />
              : <div className="dshAnnotationSelected">{item.userComment || '无'}</div>}
          </label>
          <div className="dshAnnotationActions">
            {sources.forItem(item) !== undefined && <button type="button" onClick={() => void sources.forItem(item)?.openSource(item)}>打开来源</button>}
            {sources.forItem(item)?.copySourceLink !== undefined && <button type="button" onClick={() => void sources.forItem(item)?.copySourceLink?.(item).then((text) => navigator.clipboard.writeText(text))}>复制来源链接</button>}
            {snapshot.editable
              ? <button type="button" onClick={() => void remove(item.referenceId)}>删除</button>
              : <button type="button" onClick={() => void reuse(item.referenceId)}>重新添加到当前提问</button>}
            {!snapshot.editable && item.backlinkState === 'failed' && <button type="button" onClick={() => void retryBacklink(set.setId, item.referenceId)}>重试回链</button>}
          </div>
        </article>)}
      </div>
    </section>
  </div>
}
