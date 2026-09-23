import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { assertSessionWritable, observeSessionWriteAccess } from './write-access.ts'

const valueSchema = z.object({ sessionId: z.string().min(1), namespace: z.string().min(1), objectId: z.string().min(1), revision: z.number().int().positive(), deleted: z.boolean(), content: z.json() }).strict()
export type SessionExtensionObject = z.infer<typeof valueSchema>
export interface SessionExtensionData {
  readonly protocolVersion: 1
  get(sessionId: string, namespace: string, objectId: string): SessionExtensionObject | undefined
  list(namespace: string, sessionId?: string): SessionExtensionObject[]
  ready?(namespace: string, sessionId?: string): Promise<void>
  write(input: Omit<SessionExtensionObject, 'revision'> & { expectedRevision: number }): Promise<SessionExtensionObject>
}
/** Structural consumer of the public session-extension-sync/v1 contract. */
export interface SessionExtensionSync {
  readonly protocolVersion: 1
  readonly namespaces: readonly string[]
  read(namespace: string, sessionId?: string): Promise<readonly SessionExtensionObject[]>
  commit(value: SessionExtensionObject): Promise<void>
}
export interface SessionExtensionTable {
  get(key: string): SessionExtensionObject | undefined
  entries(): IterableIterator<[string, SessionExtensionObject]>
  put(key: string, value: SessionExtensionObject): Promise<unknown>
  update(key: string, change: (value: SessionExtensionObject) => SessionExtensionObject): Promise<unknown>
}
export const sessionExtensionsDomain = defineDomain({
  name: 'dsh_session_extensions_v1', version: 1,
  tables: { objects: domainTable<string, SessionExtensionObject>(valueSchema) },
})

/** Host-owned session data. Consumers validate their business objects before writing. */
export class LocalSessionExtensionData implements SessionExtensionData {
  readonly protocolVersion = 1 as const
  private tails = new Map<string, Promise<unknown>>()
  private syncTail: Promise<unknown> = Promise.resolve()
  constructor(private readonly table: SessionExtensionTable, private readonly assertWritable: () => Promise<void> = async () => {},
    private readonly replica: () => SessionExtensionSync | undefined = () => undefined) {}
  private transport(namespace: string) {
    const sync = this.replica()
    return sync?.protocolVersion === 1 && sync.namespaces.includes(namespace) ? sync : undefined
  }
  ready(namespace: string, sessionId?: string): Promise<void> {
    const work = this.syncTail.then(async () => {
      const sync = this.transport(namespace)
      if (!sync) return
      const incoming = (await sync.read(namespace, sessionId)).map(value => valueSchema.parse(value))
      if (incoming.some(value => value.namespace !== namespace || (sessionId && value.sessionId !== sessionId))) throw new Error('Replica returned data outside the requested session')
      const seen = new Set<string>()
      for (const value of incoming) {
        const key = JSON.stringify([value.sessionId, namespace, value.objectId])
        if (seen.has(key)) throw new Error('Replica returned duplicate session objects')
        seen.add(key)
        const current = this.table.get(key)
        if (current && (current.revision > value.revision || (current.revision === value.revision && !isDeepStrictEqual(current, value))))
          throw new Error('Session extension replicas disagree; retain both copies and reconcile before writing')
        if (!current) await this.table.put(key, value)
        else if (current.revision < value.revision) await this.table.update(key, latest => {
          if (latest.revision !== current.revision) throw new Error('Session extension changed during restore')
          return value
        })
      }
      if (sessionId) for (const value of this.list(namespace, sessionId)) {
        if (!seen.has(JSON.stringify([value.sessionId, namespace, value.objectId]))) {
          await this.assertWritable()
          await sync.commit(value)
        }
      }
    })
    this.syncTail = work.catch(() => {})
    return work
  }
  get(sessionId: string, namespace: string, objectId: string) { const value = this.table.get(JSON.stringify([sessionId, namespace, objectId])); return value && structuredClone(value) }
  list(namespace: string, sessionId?: string) { return [...this.table.entries()].map(([, value]) => value).filter(value => value.namespace === namespace && (sessionId === undefined || value.sessionId === sessionId)).map(value => structuredClone(value)) }
  write(input: Omit<SessionExtensionObject, 'revision'> & { expectedRevision: number }): Promise<SessionExtensionObject> {
    const { expectedRevision, ...fields } = input
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid session extension revision')
    const value = valueSchema.parse({ ...fields, revision: expectedRevision + 1 })
    if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('Session extension exceeds 8 MiB')
    const key = JSON.stringify([input.sessionId, input.namespace, input.objectId])
    const previous = this.tails.get(key)
    const work = this.syncTail.then(() => previous).then(async () => {
      await this.assertWritable()
      const current = this.table.get(key)
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error('Session extension revision conflict; reload before saving')
      // A lost acknowledgement leaves local state unchanged. ready() restores the
      // durable remote revision before retrying, rather than replaying the edit.
      await this.transport(value.namespace)?.commit(value)
      if (current) await this.table.update(key, latest => {
        if (latest.revision !== expectedRevision) throw new Error('Session extension revision conflict')
        return value
      })
      else await this.table.put(key, value)
      return structuredClone(value)
    })
    const tail = work.catch(() => {})
    this.tails.set(key, tail)
    this.syncTail = tail
    void tail.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key) })
    return work
  }
  async drain() { await Promise.all([this.syncTail, ...this.tails.values()]) }
}

export class SessionExtensionStartupStoppedError extends Error {
  constructor() { super('Annotation runtime stopped during storage startup') }
}

export async function openSessionExtensionData(ctx: Context, beforeClose?: () => Promise<void>, isClosing?: () => boolean) {
  observeSessionWriteAccess(ctx)
  const domain = await ctx.storageDomain.open(sessionExtensionsDomain)
  if (isClosing?.()) {
    await domain.close()
    throw new SessionExtensionStartupStoppedError()
  }
  const data = new LocalSessionExtensionData(domain.table('objects'), () => assertSessionWritable(ctx),
    () => ctx.get('sessionExtensionSync' as never) as SessionExtensionSync | undefined)
  try {
    ctx.provide('sessionExtensionData' as never, data as never)
    ctx.effect(() => async () => {
      try { await beforeClose?.() }
      finally { try { await data.drain() } finally { await domain.close() } }
    }, 'session extensions: host storage')
    return data
  } catch (error) {
    await domain.close()
    throw error
  }
}
