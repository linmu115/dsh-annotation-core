import type { Context } from '@deepseek-ai/cordis'
import type { AnnotationStore } from './store.ts'
import { upstreamOf, type UpstreamHost } from './upstream.ts'

/** Offline or unknown identities never imply deletion. Only a positive authority tombstone does. */
export async function reconcileGraphRevocations(ctx: Context, store: AnnotationStore, sessionId: string, pendingOnly = false, referenceIds?: readonly string[]) {
  const host = ctx.get('maintenanceSessionContext' as never) as UpstreamHost | undefined
  if (host?.protocolVersion !== 1 || !host.status) return
  const state = store.read(sessionId)
  const items = [...(state.pending?.items ?? []), ...(pendingOnly ? [] : [
    ...state.sentSets.flatMap(set => set.items), ...Object.values(state.restoredGraphReferences ?? {}),
  ])]
  const ids = [...new Set(items.filter(item => upstreamOf(item)?.targetSessionId === sessionId && (!referenceIds || referenceIds.includes(item.referenceId))).map(item => item.referenceId))]
  // Keep authority traffic bounded even when an old conversation has many references.
  for (let start = 0; start < ids.length; start += 8) {
    await Promise.all(ids.slice(start, start + 8).map(async referenceId => {
      let value
      try { value = await host.status!(sessionId, referenceId) } catch { return }
      if (value.referenceId === referenceId && value.state === 'revoked')
        await store.reconcileRevokedGraphReference(sessionId, referenceId)
    }))
  }
}
