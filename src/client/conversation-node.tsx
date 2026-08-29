import { useEffect, useSyncExternalStore } from 'react'

import { suppressGenericAnnotationRow } from './conversation-projection.tsx'

export interface AnnotationConversationNodeProps {
  readonly count: number
  readonly getCount?: () => number
  readonly subscribeCount?: (listener: () => void) => () => void
  readonly open: () => void
  readonly genericContextKey?: string
}

const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

export function AnnotationConversationNode({ count, getCount, subscribeCount, open, genericContextKey }: AnnotationConversationNodeProps) {
  const liveCount = useSyncExternalStore(
    subscribeCount ?? NOOP_SUBSCRIBE,
    getCount ?? (() => count),
    getCount ?? (() => count),
  )
  useEffect(() => genericContextKey === undefined ? undefined : suppressGenericAnnotationRow(genericContextKey, document), [genericContextKey])
  if (liveCount < 1) return null
  return <div className="dshAnnotationSentRow">
    <button className="dshAnnotationSentPill sentPill" type="button" onClick={open} aria-label={`打开 ${liveCount} 条注释`}>
      {liveCount} 条注释
    </button>
  </div>
}
