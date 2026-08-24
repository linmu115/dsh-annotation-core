import { useSyncExternalStore } from 'react'

import type { ReferenceSet } from '../domain/model.ts'
import type { ReferenceSessionStore } from './composer-binding.tsx'

export interface ReferenceRailProps {
  readonly layout: 'default' | 'narrow'
  readonly store: ReferenceSessionStore
  readonly open: (set: ReferenceSet, referenceId?: string) => void
  readonly remove: (referenceId: string) => Promise<void>
}

function sourceLabel(set: ReferenceSet, referenceId: string): string {
  const item = set.items.find((candidate) => candidate.referenceId === referenceId)
  if (item?.sourceType === 'obsidian-note') {
    const status = item.snapshot.freshness === 'captured' ? '已捕获' : item.snapshot.freshness === 'refreshed' ? '已刷新' : '离线快照'
    return `Obsidian · ${item.locator.notePath} · ${status}`
  }
  return 'DSH 会话'
}

export function ReferenceRail({ layout, store, open, remove }: ReferenceRailProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const set = snapshot.pending
  if (set === null || set.items.length === 0) {
    if (snapshot.status === 'blocked') return <div className="dshAnnotationBlocked" role="status">注释内核不可用，已阻止降级发送</div>
    return null
  }
  return <div className={`dshAnnotationRail ${layout === 'narrow' ? 'narrow' : 'default'}`} aria-label="待发送注释">
    {set.items.map((item) => <div className="dshAnnotationChip" data-annotation-chip key={item.referenceId}>
      <button className="dshAnnotationChipOpen" type="button" onClick={() => open(set, item.referenceId)} aria-label={`打开注释 ${item.number}`}>
        <span className="dshAnnotationNumber">{item.number}</span>
        <span className="dshAnnotationSource">{sourceLabel(set, item.referenceId)}</span>
        <span className="dshAnnotationPreview">{item.selectedText}</span>
      </button>
      <button className="dshAnnotationDelete" type="button" aria-label={`删除注释 ${item.number}`} onClick={() => void remove(item.referenceId)}>×</button>
    </div>)}
  </div>
}
