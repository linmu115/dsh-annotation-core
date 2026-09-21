import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { deriveEventMessage, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { UpstreamHost } from './upstream.ts'
import type { SessionExtensionData } from './session-extension-data.ts'

const namespace = 'annotation-upstream'
const entrySchema = z.object({ eventId: z.string(), role: z.string(), text: z.string() })
const recordSchema = z.object({ referenceId: z.string(), sourceNativeSessionId: z.string(), targetNativeSessionId: z.string(), sourceTitle: z.string(), sourceVersionId: z.string(), cutoffEventId: z.string(), sourceAnchorId: z.string(), selectedText: z.string(), requestDigest: z.string(), state: z.enum(['pending', 'sent', 'revoked']), targetMessageId: z.string().nullable(), entries: z.array(entrySchema), turnStart: z.number().int().nonnegative() })
type RecordValue = z.infer<typeof recordSchema>
type Entry = z.infer<typeof entrySchema>
export interface LocalSessionSource {
  workspaces?(): Promise<{ id: string; title: string }[]>
  list(workspaceId?: string): Promise<{ id: string; title: string }[]>
  read(sessionId: string): Promise<{ title: string; entries: Entry[] }>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Immutable source material and grants are session extensions, not an adapter database. */
export class LocalSessionContext implements UpstreamHost {
  readonly protocolVersion = 1 as const
  private captureTail: Promise<unknown> = Promise.resolve()
  private executions = new Map<string, { used: number; limit: number; closed: boolean }>()
  constructor(private readonly data: SessionExtensionData, private readonly source: LocalSessionSource) {}
  async directory(workspaceId?: string, after?: string) {
    const rows = (await (!workspaceId && this.source.workspaces ? this.source.workspaces() : this.source.list(workspaceId))).sort((a, b) => a.id.localeCompare(b.id)).filter(row => !after || row.id > after)
    const items = rows.slice(0, 50)
    return { items, nextCursor: rows.length > 50 ? items.at(-1)!.id : null }
  }
  async preview(id: string, cursor?: string, selection?: { sourceVersionId: string; sourceAnchorId: string }) {
    const snapshot = await this.source.read(id)
    let entries = snapshot.entries
    let sourceVersionId = `local-version-${digest(entries)}`
    if (selection && selection.sourceVersionId !== sourceVersionId) {
      const saved = this.data.list(namespace).filter(object => !object.deleted).map(object => recordSchema.parse(object.content)).find(record => record.sourceNativeSessionId === id && record.sourceVersionId === selection.sourceVersionId && record.sourceAnchorId === selection.sourceAnchorId && record.state !== 'revoked')
      if (!saved) throw new Error('固定来源版本不可用')
      entries = saved.entries; sourceVersionId = saved.sourceVersionId
    }
    const reply = selection ? entries.findIndex(entry => entry.eventId === selection.sourceAnchorId && entry.role === 'assistant') : entries.findLastIndex(entry => entry.role === 'assistant')
    if (reply < 0) throw new Error('会话尚无已完成回复')
    const start = entries.slice(0, reply).findLastIndex(entry => entry.role === 'user')
    if (start < 0) throw new Error('所选回复缺少用户请求')
    const fingerprint = digest([id, sourceVersionId, entries[reply]!.eventId])
    let index = start, offset = 0
    if (cursor) { const value = z.tuple([z.literal(fingerprint), z.number().int().min(start).max(reply), z.number().int().nonnegative()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); index = value[1]; offset = value[2]; if (offset > entries[index]!.text.length) throw new Error('预览游标无效') }
    const entry = entries[index]!, text = entry.text.slice(offset, offset + 2000), complete = offset + text.length >= entry.text.length
    const nextIndex = complete ? index + 1 : index, nextOffset = complete ? 0 : offset + text.length
    return { logicalSessionId: id, nativeSessionId: id, title: snapshot.title, sourceVersionId,
      items: [{ ...entry, text, offset, complete }], hasMore: nextIndex <= reply,
      nextCursor: nextIndex <= reply ? Buffer.from(JSON.stringify([fingerprint, nextIndex, nextOffset])).toString('base64url') : null,
      capture: { sourceSessionId: id, anchorId: entries[reply]!.eventId, messageId: entries[reply]!.eventId, role: 'assistant', occurrence: 0, selectedText: entries[reply]!.text.slice(0, 4000) } }
  }
  private record(target: string, id: string, allowRevoked = false) {
    const object = this.data.get(target, namespace, id)
    if (!object || object.deleted) throw new Error('会话引用不存在')
    const record = recordSchema.parse(object.content)
    if (record.targetNativeSessionId !== target || record.referenceId !== id || (!allowRevoked && record.state === 'revoked')) throw new Error('此引用在目标会话中不可用')
    return { record, object }
  }
  capture(input: Parameters<UpstreamHost['capture']>[0]) {
    const work = this.captureTail.then(() => this.captureSerial(input))
    this.captureTail = work.catch(() => {})
    return work
  }
  private async captureSerial(input: Parameters<UpstreamHost['capture']>[0]) {
    const referenceId = `local-ref-${digest([input.targetNativeSessionId, input.operationId])}`
    const requestDigest = digest(input)
    const previous = this.data.get(input.targetNativeSessionId, namespace, referenceId)
    if (previous) {
      const saved = this.record(input.targetNativeSessionId, referenceId).record
      if (saved.requestDigest !== requestDigest) throw new Error('引用操作身份已用于其他内容')
      return saved
    }
    if (input.sourceNativeSessionId === input.targetNativeSessionId) throw new Error('不能将会话引用为自己的上游')
    await this.source.read(input.targetNativeSessionId)
    const snapshot = await this.source.read(input.sourceNativeSessionId)
    const sourceVersionId = `local-version-${digest(snapshot.entries)}`
    if (input.expectedSourceVersionId && input.expectedSourceVersionId !== sourceVersionId) throw new Error('来源版本已改变，请重新选择')
    const selected = snapshot.entries.findIndex(entry => entry.eventId === input.anchorId && entry.role === 'assistant')
    if (selected < 0 || !input.selectedText || !snapshot.entries[selected]!.text.includes(input.selectedText)) throw new Error('请选择已完成回复中的有效选段')
    const reachable = new Set([input.targetNativeSessionId])
    const grants = this.data.list(namespace).filter(item => !item.deleted).map(item => recordSchema.parse(item.content)).filter(record => record.state !== 'revoked')
    for (let changed = true; changed;) {
      changed = false
      for (const grant of grants) if (reachable.has(grant.sourceNativeSessionId) && !reachable.has(grant.targetNativeSessionId)) { reachable.add(grant.targetNativeSessionId); changed = true }
      if (reachable.has(input.sourceNativeSessionId)) throw new Error('此连接会形成上下文循环')
    }
    const entries = snapshot.entries.slice(0, selected + 1)
    const turnStart = entries.findLastIndex(entry => entry.role === 'user')
    if (turnStart < 0) throw new Error('无法找到所选回复对应的用户请求')
    const record: RecordValue = { referenceId, requestDigest, sourceNativeSessionId: input.sourceNativeSessionId, targetNativeSessionId: input.targetNativeSessionId, sourceTitle: snapshot.title, sourceVersionId, cutoffEventId: entries.at(-1)!.eventId, sourceAnchorId: input.anchorId, selectedText: input.selectedText, state: 'pending', targetMessageId: null, entries, turnStart }
    await this.data.write({ sessionId: input.targetNativeSessionId, namespace, objectId: referenceId, expectedRevision: 0, deleted: false, content: record })
    return record
  }
  async inspect(target: string, id: string) { const { record } = this.record(target, id); await this.source.read(record.sourceNativeSessionId); return record }
  async status(target: string, id: string) { const { record } = this.record(target, id, true); return { referenceId: id, state: record.state } }
  async describe(target: string, id: string) { const record = await this.inspect(target, id); return { record, sourceNativeSessionId: record.sourceNativeSessionId } }
  async bind(target: string, id: string, messageId: string | null) {
    const { record, object } = this.record(target, id, true)
    if (record.state === 'revoked' && messageId !== null) throw new Error('引用已撤销')
    if (record.targetMessageId && messageId && record.targetMessageId !== messageId) throw new Error('引用已经绑定另一次提交')
    const state = messageId === null ? 'revoked' : 'sent'
    if (record.state === state && record.targetMessageId === messageId) return record
    const next = { ...record, state, targetMessageId: messageId }
    await this.data.write({ sessionId: target, namespace, objectId: id, expectedRevision: object.revision, deleted: false, content: next })
    return next
  }
  async read(input: Parameters<UpstreamHost['read']>[0]) {
    const record = await this.inspect(input.targetNativeSessionId, input.referenceId)
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1024 || input.maxBytes > 1024 * 1024) throw new Error('引用读取额度无效')
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < input.maxBytes) throw new Error('引用总额度无效')
    const executionKey = JSON.stringify([input.targetNativeSessionId, input.executionId])
    const budget = this.executions.get(executionKey) ?? { used: 0, limit: input.totalBytes, closed: false }
    if (budget.closed) throw new Error('本轮引用读取已经结束')
    budget.limit = Math.min(budget.limit, input.totalBytes)
    const maxBytes = Math.min(input.maxBytes, budget.limit - budget.used)
    if (maxBytes < 1024) throw new Error('本轮引用读取预算已用完')
    this.executions.set(executionKey, budget)
    const turns: Entry[][] = []
    for (const entry of record.entries) {
      if (entry.role === 'user' || turns.length === 0) turns.push([])
      turns.at(-1)!.push(entry)
    }
    let ordered = turns.toReversed()
    if (input.userRequestId) {
      ordered = ordered.filter(turn => turn[0]?.eventId === input.userRequestId && turn[0]?.role === 'user')
      if (!ordered.length) throw new Error('请求身份不在已授权的固定来源中')
    }
    const selectedLength = ordered[0]?.length ?? 0, visible = ordered.flat()
    const fingerprint = digest([record.referenceId, record.sourceVersionId, input.query ?? null, input.userRequestId ?? null, input.targetNativeSessionId])
    let index = 0, offset = 0
    if (input.cursor) {
      const cursor = z.tuple([z.literal(fingerprint), z.number().int().nonnegative(), z.number().int().nonnegative()]).parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
      index = cursor[1]; offset = cursor[2]
      if (!visible[index] || offset > visible[index]!.text.length) throw new Error('引用读取游标无效')
    }
    const items: { eventId: string; role: string; text: string; offset: number; complete: boolean }[] = []
    const result = () => ({ referenceId: record.referenceId, sourceVersionId: record.sourceVersionId, cutoffEventId: record.cutoffEventId, items, nextCursor: index < visible.length ? Buffer.from(JSON.stringify([fingerprint, index, offset])).toString('base64url') : null, hasMore: index < visible.length, selectedTurn: { complete: index >= selectedLength } })
    while (index < visible.length && items.length < 20 && !(input.view === 'selected-turn' && index >= selectedLength)) {
      const entry = visible[index]!
      if (input.query && !entry.text.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) { index++; offset = 0; continue }
      const item = { eventId: entry.eventId, role: entry.role, text: entry.text.slice(offset), offset, complete: true }
      items.push(item)
      while (Buffer.byteLength(JSON.stringify(result())) > maxBytes - 256 && item.text.length) { item.text = item.text.slice(0, Math.floor(item.text.length * 0.8)); item.complete = false }
      if (!item.text.length && entry.text.length) { items.pop(); break }
      if (!item.complete) { offset += item.text.length; break }
      index++; offset = 0
    }
    if (!items.length && index < visible.length) throw new Error('引用额度不足以返回内容')
    const page = result()
    const size = Buffer.byteLength(JSON.stringify(page))
    if (size > maxBytes) throw new Error('引用读取结果超过额度')
    budget.used += size
    return page
  }
  async endExecution(target: string, executionId: string) { this.executions.set(JSON.stringify([target, executionId]), { used: 0, limit: 0, closed: true }) }
}

/** DSH's public query service supplies cold and live history; no filesystem paths are read. */
export function localSessionSource(ctx: Context): LocalSessionSource {
  const query = () => ctx.get('sessionQuery' as never) as unknown as {
    listSessions(): Promise<{ header: { id: string; cwd?: string }; title?: string }[]>
    readSession(id: string): Promise<{ session: { id: string }; events: unknown[] }>
  } | undefined
  const text = (value: unknown) => Array.isArray(value) ? value.map(block => typeof block === 'object' && block && 'type' in block && block.type === 'text' && 'text' in block ? String(block.text) : '').join('') : ''
  const entries = (events: unknown[]): Entry[] => events.flatMap(raw => {
    const event = raw as SessionEvent
    if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type) || (event.type === 'assistant/message' && event.data.interrupted)) return []
    const message = deriveEventMessage(event)
    if (!message) return []
    return [{ eventId: String(message.id), role: event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : 'tool', text: text(message.content) }]
  })
  return {
    async workspaces() {
      const registry = ctx.get('workspaceRegistry' as never) as { list(): { id: string; title?: string; path: string }[] } | undefined
      if (!registry) throw new Error('本地工作区服务尚未就绪')
      return registry.list().map(row => ({ id: String(row.id), title: row.title || row.path }))
    },
    async list(workspaceId) {
      const registry = ctx.get('workspaceRegistry' as never) as { get(id: string): { sessionIds: readonly string[] } | undefined } | undefined
      const workspace = workspaceId ? registry?.get(workspaceId) : undefined
      if (workspaceId && !workspace) throw new Error('本地工作区不存在或工作区服务尚未就绪')
      const service = query()
      const rows = service ? (await service.listSessions()).map(row => ({ id: row.header.id, title: row.title ?? row.header.id }))
        : ctx.sessions.list().map(session => ({ id: String(session.id), title: String(session.id) }))
      return workspace ? rows.filter(row => workspace.sessionIds.includes(row.id)) : rows
    },
    async read(id) {
      const live = ctx.sessions.get(id as never)
      if (live) return { title: id, entries: entries([...live.snapshotEvents()]) }
      const service = query()
      if (!service) throw new Error('本地会话历史读取服务尚未就绪')
      const snapshot = await service.readSession(id)
      if (snapshot.session.id !== id) throw new Error('会话来源身份不一致')
      return { title: id, entries: entries(snapshot.events) }
    },
  }
}
