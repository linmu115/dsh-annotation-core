import { useEffect } from 'react'

import { suppressGenericAnnotationRow } from './conversation-projection.tsx'

export interface AnnotationConversationNodeProps {
  readonly count: number
  readonly open: () => void
  readonly genericContextKey?: string
}

export function AnnotationConversationNode({ count, open, genericContextKey }: AnnotationConversationNodeProps) {
  useEffect(() => genericContextKey === undefined ? undefined : suppressGenericAnnotationRow(genericContextKey, document), [genericContextKey])
  return <div className="dshAnnotationSentRow">
    <button className="dshAnnotationSentPill sentPill" type="button" onClick={open} aria-label={`打开 ${count} 条注释`}>
      {count} 条注释
    </button>
  </div>
}
