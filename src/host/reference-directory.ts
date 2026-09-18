import { createHash } from 'node:crypto'
import type { ReferenceItem } from '../domain/model.ts'
import type { AnnotationDirectoryEntry, AnnotationDirectoryQuery } from '../public/host-api.ts'
import type { SessionAggregate } from './store.ts'

export class AnnotationDirectoryChangedError extends Error {
  constructor() { super('引用目录已更新，请从第一页重新读取'); this.name = 'AnnotationDirectoryChangedError' }
}

function page<T>(items: readonly T[], key: (item: T) => string, scope: string, revision: string | number, input: AnnotationDirectoryQuery) {
  input.signal?.throwIfAborted()
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('引用目录每页需要 1 到 50 项')
  let after: string | undefined
  if (input.after !== undefined) {
    if (input.after.length > 4096) throw new TypeError('无效引用目录游标')
    let cursor: unknown
    try { cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')) } catch { throw new TypeError('无效引用目录游标') }
    if (!cursor || typeof cursor !== 'object' || !('scope' in cursor) || !('revision' in cursor) || !('after' in cursor)
      || cursor.scope !== scope || typeof cursor.after !== 'string') throw new TypeError('无效引用目录游标')
    if (cursor.revision !== revision) throw new AnnotationDirectoryChangedError()
    after = cursor.after
  }
  const ordered = [...items].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
  const remaining = after === undefined ? ordered : ordered.filter(item => key(item) > after!)
  const selected = remaining.slice(0, limit)
  return { items: selected, nextCursor: remaining.length > limit
    ? Buffer.from(JSON.stringify({ scope, revision, after: key(selected.at(-1)!) })).toString('base64url') : null }
}

export function referenceDirectorySessions(profileId: string, items: readonly { nativeSessionId: string; sourceRevision: number }[], input: AnnotationDirectoryQuery) {
  const ids = items.map(item => item.nativeSessionId).sort()
  const revision = createHash('sha256').update(JSON.stringify(ids)).digest('hex')
  return page(items, item => item.nativeSessionId, `${profileId}:sessions`, revision, input)
}

function bounded(value: string | undefined, max: number): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= max ? value : undefined
}

function entry(item: ReferenceItem, setId: string, state: AnnotationDirectoryEntry['state'], targetMessageId?: string): AnnotationDirectoryEntry {
  const source: { nativeSessionId?: string; title?: string; vaultId?: string; notePath?: string; anchorId?: string; upstreamReferenceId?: string } = {}
  if (item.sourceType === 'dsh-message') {
    const nativeSessionId = bounded(item.locator.sessionId, 256), anchorId = bounded(item.locator.anchorId, 256)
    if (nativeSessionId) source.nativeSessionId = nativeSessionId
    if (anchorId) source.anchorId = anchorId
    if (item.locator.upstream) {
      source.upstreamReferenceId = item.locator.upstream.referenceId
      source.title = item.locator.upstream.sourceTitle.slice(0, 500)
    }
  } else {
    const vaultId = bounded(item.locator.vaultId, 256), notePath = bounded(item.locator.notePath, 2048), anchorId = bounded(item.locator.blockId, 256)
    if (vaultId) source.vaultId = vaultId
    if (notePath) source.notePath = notePath
    if (anchorId) source.anchorId = anchorId
  }
  return {
    ...(targetMessageId ? { targetMessageId } : {}),
    referenceId: item.referenceId, setId, sourceType: item.sourceType, state, source,
    selectedText: item.selectedText.slice(0, 4000), userComment: item.userComment.slice(0, 2000),
    ...(item.selectedText.length > 4000 || item.userComment.length > 2000 ? { truncated: true } : {}),
  }
}

/** Legacy aggregates initially retain their last acknowledged export revision. */
export function referenceDirectoryRevision(aggregate: SessionAggregate): number {
  return aggregate.directoryRevision ?? aggregate.revision
}

/** Select pointers without reading snapshot, initial context, or journal bodies. */
function records(aggregate: SessionAggregate) {
  const records = new Map<string, { referenceId: string; materialize: () => AnnotationDirectoryEntry }>()
  for (const set of [...aggregate.sentSets, ...(aggregate.pending ? [aggregate.pending] : [])]) {
    for (const item of set.items) records.set(item.referenceId, { referenceId: item.referenceId, materialize: () => entry(item, set.setId, set.state, set.userMessageId) })
  }
  // Positive tombstones survive when their original item and cleanup job are gone.
  for (const deleted of Object.values(aggregate.deletedReferences)) records.set(deleted.referenceId, {
    referenceId: deleted.referenceId,
    materialize: () => ({ referenceId: deleted.referenceId, setId: deleted.setId, sourceType: deleted.sourceType,
      state: 'deleted', selectedText: '', userComment: '', source: {} }),
  })
  // restoredGraphReferences are grants already represented by annotation-upstream.
  return [...records.values()]
}

/** Streams bounded public rows into a digest; never builds a transcript snapshot. */
function fingerprint(aggregate: SessionAggregate): string {
  const hash = createHash('sha256')
  for (const record of records(aggregate).sort((a, b) => a.referenceId < b.referenceId ? -1 : a.referenceId > b.referenceId ? 1 : 0)) {
    hash.update(JSON.stringify(record.materialize())).update('\n')
  }
  return hash.digest('hex')
}

/** Store mutations preserve these readonly collection identities when changing internal jobs only. */
export function referenceDirectoryChanged(before: SessionAggregate, after: SessionAggregate): boolean {
  if (before.pending === after.pending && before.sentSets === after.sentSets && before.deletedReferences === after.deletedReferences) return false
  return fingerprint(before) !== fingerprint(after)
}

/** Select pointers first, then copy only the requested page. No snapshot/journal traversal. */
export function referenceDirectoryEntries(aggregate: SessionAggregate, input: AnnotationDirectoryQuery) {
  const revision = referenceDirectoryRevision(aggregate)
  const selected = page(records(aggregate), item => item.referenceId, `${aggregate.profileId}:${aggregate.sessionId}:entries`, revision, input)
  return { nativeSessionId: aggregate.sessionId, sourceRevision: revision,
    items: selected.items.map(item => item.materialize()), nextCursor: selected.nextCursor }
}
