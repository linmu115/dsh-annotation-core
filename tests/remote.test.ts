import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import * as cordis from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Storage } from '@deepseek-ai/dsh-storage'
import { apply as applyStorageDomain } from '@deepseek-ai/dsh-storage-domain'
import { apply as applyStorageJson } from '@deepseek-ai/dsh-storage-json'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'

import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { AnnotationStore } from '../src/host/store.ts'
import { selectedTextHash } from '../src/protocol/index.ts'
import { apply as applyCore } from '../src/index.ts'
import { unwrapRemote } from '../src/remote/client.ts'
import { AnnotationCoreRemoteService } from '../src/remote/service.ts'
import { TYPERT, TYPERT_REMOTE } from '../src/remote/typert.ts'

interface ClientBundleDefinition {
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

async function loadGatewayClient(): Promise<Record<string, unknown>> {
  const source = await readFile(join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'lib', 'client.js'), 'utf8')
  let loaded: Record<string, unknown> | undefined
  const window = {
    __ModuleLoader__: {
      load(definition: ClientBundleDefinition) {
        loaded = definition.factory((id) => {
          if (id === '@deepseek-ai/cordis') return cordis
          throw new Error(`Unmapped client dependency ${JSON.stringify(id)}`)
        })
      },
    },
  }
  new Function('window', source)(window)
  if (loaded === undefined) throw new Error('Gateway client bundle did not register')
  return loaded
}

function mountAgentBoundary(ctx: Context, store: AnnotationStore) {
  new TypertRegistry(ctx)
  new AnnotationCoreRemoteService(ctx, store)
  const agent = { id: 'session-1', ctx, session: { snapshotEvents: () => [] } } as never
  ctx.typert.lookups.register('agent', {
    parameter: 'agent',
    wire: 'agentId',
    hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: (id) => id === 'session-1' ? agent : undefined,
  })
  ctx.typert.contexts.registerHost('agent', {
    wire: 'agentId',
    wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: (id) => id === 'session-1' ? ctx : undefined,
  })
  ctx.typert.register(TYPERT)
  return new TypertGatewayService(ctx, {})
}

describe('annotation core Typert boundary', () => {
  it('provides explicit Host and Client artifacts with Agent-scoped descriptors', () => {
    expect(TYPERT.package).toBe('dsh-annotation-core')
    expect(TYPERT.face).toBe('host')
    expect(TYPERT_REMOTE.descriptors).toHaveLength(21)
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      expect(descriptor.scope).toMatchObject({ context: 'agent', wire: 'agentId' })
      expect(descriptor.parameters[0]).toMatchObject({ source: 'lookup', lookup: 'agent', wire: 'agentId' })
    }
  })

  it('is unavailable before explicit mount metadata registration and available afterward', async () => {
    const ctx = new Context()
    new TypertRegistry(ctx)
    expect(ctx.typert.local.get('annotationCore/readPending')).toBeUndefined()
    const dispose = ctx.typert.register(TYPERT)
    expect(ctx.typert.local.get('annotationCore/readPending')).toBeDefined()
    await dispose()
    expect(ctx.typert.local.get('annotationCore/readPending')).toBeUndefined()
  })

  it('streams pending updates through the gateway without holding unary requests open', async () => {
    const ctx = new Context()
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const gateway = mountAgentBoundary(ctx, store)
    const abort = new AbortController()
    const stream = await gateway.stream({ namespace: 'annotationCore', method: 'watchPending',
      args: { agentId: 'session-1' }, signal: abort.signal })
    const iterator = stream[Symbol.asyncIterator]()
    expect(await iterator.next()).toMatchObject({ value: { revision: 0, pending: null } })
    const next = iterator.next()
    await store.addReference('session-1', { expectedRevision: 0, operationId: 'stream-add', setId: 'stream-set',
      referenceId: 'stream-ref', createdAt: 1, source: { sourceType: 'dsh-message', selectedText: 'fixture',
        locator: { profileId: 'web', sessionId: 'source', anchorId: 'a', role: 'assistant', occurrence: 0,
          selectedTextHash: selectedTextHash('fixture') } } })
    expect(await next).toMatchObject({ value: { revision: 1, pending: { items: [{ referenceId: 'stream-ref' }] } } })
    const waiting = iterator.next()
    abort.abort()
    await expect(waiting).rejects.toThrow()
    store.close()
  })

  it('authorizes through the resolved Agent and preserves wait cancellation through the gateway', async () => {
    const ctx = new Context()
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const gateway = mountAgentBoundary(ctx, store)

    const allowed = await gateway.invoke({
      namespace: 'annotationCore',
      method: 'readPending',
      args: { agentId: 'session-1' },
      signal: new AbortController().signal,
    })
    expect(allowed).toMatchObject({ revision: 0, pending: null })

    await expect(gateway.invoke({
      namespace: 'annotationCore',
      method: 'readPending',
      args: { agentId: 'not-live' },
      signal: new AbortController().signal,
    })).rejects.toThrow()

    const abort = new AbortController()
    const waiting = gateway.invoke({
      namespace: 'annotationCore',
      method: 'waitRevision',
      args: { agentId: 'session-1', afterRevision: 0 },
      signal: abort.signal,
    })
    abort.abort()
    await expect(waiting).rejects.toMatchObject({
      name: 'RemoteError',
      code: 'gateway/cancelled',
    })
  })

  it('resolves and deletes a graph relation through the registered Agent-scoped gateway', async () => {
    const ctx = new Context(), store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const gateway = mountAgentBoundary(ctx, store)
    await store.addReference('session-1', { expectedRevision: 0, operationId: 'graph', setId: 'set', referenceId: 'ref', createdAt: 1,
      source: { sourceType: 'dsh-message', selectedText: 'private fixture text', locator: { profileId: 'web', sessionId: 'source',
        anchorId: 'reply', role: 'assistant', occurrence: 0, selectedTextHash: selectedTextHash('private fixture text') } } })
    const invoke = (method: string, args: Record<string, unknown>) => gateway.invoke({ namespace: 'annotationCore', method,
      args: { agentId: 'session-1', ...args }, signal: new AbortController().signal })
    expect(await invoke('resolveReferenceLink', { referenceId: 'ref' })).toEqual({ setId: 'set', referenceId: 'ref', state: 'pending' })
    expect(await invoke('deleteReferenceLink', { request: { expectedRevision: 1, setId: 'set', referenceId: 'ref', deletedAt: 2 } }))
      .toMatchObject({ deleted: true, scope: 'pending' })
    expect(await invoke('resolveReferenceLink', { referenceId: 'ref' })).toEqual({ setId: 'set', referenceId: 'ref', state: 'deleted' })
    expect(await invoke('deleteReferenceLink', { request: { expectedRevision: 1, setId: 'set', referenceId: 'ref', deletedAt: 2 } }))
      .toMatchObject({ deleted: false, scope: 'pending' })
    await expect(invoke('resolveReferenceLink', { referenceId: 'ref', agentId: 'foreign' })).rejects.toThrow()
    await expect(invoke('resolveReferenceLink', { referenceId: 'x'.repeat(257) })).rejects.toThrow()
    store.close()
  })

  it('mounts the Client descriptor explicitly and unwraps a real RemoteResult round trip', async () => {
    const hostCtx = new Context()
    const gateway = mountAgentBoundary(
      hostCtx,
      new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' }),
    )
    const clientCtx = new Context()
    new TypertRegistry(clientCtx)
    clientCtx.typert.contexts.registerClient('agent', {
      identity: () => SessionId('session-1'),
      resolve: (id) => id === 'session-1' ? clientCtx : undefined,
    })
    clientCtx.provide('connection', {
      registerGenerationSource: () => () => {},
      start: () => ({ stop: () => {} }),
      rpc: {
        async call(_route: string, endpoint: string, body: { args: Record<string, unknown> }, signal: AbortSignal) {
          const separator = endpoint.indexOf('/')
          try {
            const value = await gateway.invoke({
              namespace: endpoint.slice(0, separator),
              method: endpoint.slice(separator + 1),
              args: body.args,
              signal,
            })
            return { ok: true, value }
          } catch (error) {
            return {
              ok: false,
              error: {
                code: 'internal',
                message: error instanceof Error ? error.message : String(error),
                details: {},
              },
            }
          }
        },
      },
    })
    const bundle = await loadGatewayClient()
    ;(bundle.apply as (ctx: Context) => void)(clientCtx)
    const remote = clientCtx.get('remote') as {
      $mount(contribution: typeof TYPERT_REMOTE): Promise<() => Promise<void>>
    }
    expect(clientCtx.get('remote.annotationCore')).toBeUndefined()
    const dispose = await remote.$mount(TYPERT_REMOTE)
    try {
      const namespace = clientCtx.get('remote.annotationCore') as {
        readPending(): Promise<{ ok: true; value: { revision: number; pending: null } } | { ok: false; error: never }>
      }
      expect(unwrapRemote(await namespace.readPending())).toEqual({ revision: 0, pending: null })
    } finally {
      await dispose()
    }
    expect(clientCtx.get('remote.annotationCore')).toBeUndefined()
  })

  it.each(['annotation', 'extensions'])('closes a late %s domain when unloading during async startup', async phase => {
    const root = await mkdtemp(join(tmpdir(), 'annotation-startup-stop-'))
    const ctx = new Context()
    new Storage(ctx)
    applyStorageJson(ctx, { root })
    await applyStorageDomain(ctx, { backend: 'json' })
    if (phase === 'extensions') {
      // Only used for the complete-runtime presence check; startup must stop before methods run.
      for (const key of ['agents', 'sessions', 'systemPrompt', 'attachments']) ctx.provide(key as never, {} as never)
    }
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const open = ctx.storageDomain.open.bind(ctx.storageDomain)
    let count = 0
    const delayed = vi.spyOn(ctx.storageDomain, 'open').mockImplementation((async (...args: Parameters<typeof open>) => {
      const domain = await open(...args)
      count += 1
      if (count === (phase === 'annotation' ? 1 : 2)) { entered.resolve(); await release.promise }
      return domain
    }) as typeof open)
    const fiber = ctx.plugin({ name: `annotation-startup-stop-${phase}`, inject: ['storageDomain'],
      async apply(child) { await applyCore(child, { profileId: 'web' }) } })
    try {
      await entered.promise
      let disposed = false
      const stopping = fiber.dispose().then(() => { disposed = true })
      await Promise.resolve(); await Promise.resolve()
      expect(disposed).toBe(false)
      release.resolve()
      await stopping
      expect(ctx.storageDomain.get('dsh_annotation_core_v1') === undefined, 'Annotation domain closed').toBe(true)
      expect(ctx.storageDomain.get('dsh_session_extensions_v1') === undefined, 'Extension domain closed').toBe(true)
      expect(ctx.get('annotationCore') === undefined, 'Core service removed').toBe(true)
      expect(ctx.get('sessionExtensionData' as never) === undefined, 'Extension service removed').toBe(true)
    } finally {
      release.resolve()
      await fiber.dispose()
      delayed.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the actual Cordis storage domain open until pending source cleanup has drained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annotation-drain-'))
    const ctx = new Context()
    new Storage(ctx)
    applyStorageJson(ctx, { root })
    await applyStorageDomain(ctx, { backend: 'json' })
    const fiber = ctx.plugin({ name: 'annotation-core-drain-test', inject: ['storageDomain'],
      async apply(child) { await applyCore(child, { profileId: 'web' }) } })
    const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    try {
      await fiber
      const remote = ctx.get('annotationCore') as unknown as AnnotationCoreRemoteService
      const sources = ctx.get('annotationCoreHost') as HostSourceRegistry
      await remote.store.addReference('session', { expectedRevision: 0, operationId: 'capture', setId: 'set', referenceId: 'ref', createdAt: 1,
        source: { sourceType: 'obsidian-note', selectedText: 'sample', locator: {
          vaultId: 'vault', notePath: 'sample.md', blockId: 'block', occurrence: 0, selectedTextHash: selectedTextHash('sample') },
          snapshot: { markdown: 'sample', documentHash: selectedTextHash('sample'), capturedAt: 1, freshness: 'captured' } } })
      await remote.store.removeReference('session', { expectedRevision: 1, referenceId: 'ref', now: 2 })
      sources.registerSourceAdapter('obsidian-note', { prepare: async item => item,
        discardPending: async () => { entered.resolve(); await release.promise } })
      await entered.promise
      let disposed = false
      const disposing = fiber.dispose().then(() => { disposed = true })
      await Promise.resolve(); await Promise.resolve()
      expect(disposed).toBe(false)
      expect(ctx.storageDomain.get('dsh_annotation_core_v1')).toBeDefined()
      release.resolve()
      await disposing
      expect(ctx.storageDomain.get('dsh_annotation_core_v1') === undefined, 'Annotation domain closed').toBe(true)
      // Reopen from persisted JSON: the acknowledgement was written before closing.
      const next = ctx.plugin({ name: 'annotation-core-drain-reopen', inject: ['storageDomain'],
        async apply(child) { await applyCore(child, { profileId: 'web' }) } })
      await next
      try { expect((ctx.get('annotationCore') as unknown as AnnotationCoreRemoteService).store.listPendingDiscardJobs('session')).toEqual([]) }
      finally { await next.dispose() }
    } finally {
      release.resolve()
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('closes the durable Domain and aborts long polls when the owning Cordis fiber disposes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annotation-lifecycle-'))
    const ctx = new Context()
    new Storage(ctx)
    applyStorageJson(ctx, { root })
    await applyStorageDomain(ctx, { backend: 'json' })
    let remoteService: AnnotationCoreRemoteService | undefined
    const fiber = ctx.plugin({
      name: 'annotation-core-lifecycle-test',
      inject: ['storageDomain'],
      async apply(child) {
        await applyCore(child, { profileId: 'web' })
      },
    })
    try {
      await fiber
      expect(ctx.storageDomain.get('dsh_annotation_core_v1')).toBeDefined()
      remoteService = ctx.get('annotationCore') as unknown as AnnotationCoreRemoteService | undefined
      if (remoteService === undefined) throw new Error('Remote service did not mount')
      const waiting = remoteService.store.waitRevision('session', 0)
      await fiber.dispose()
      await expect(waiting).rejects.toThrow(/disposed/)
      expect(ctx.storageDomain.get('dsh_annotation_core_v1') === undefined, 'Annotation domain closed').toBe(true)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
