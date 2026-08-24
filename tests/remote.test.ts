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
import { describe, expect, it } from 'vitest'

import { AnnotationStore } from '../src/host/store.ts'
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
  const agent = { id: 'session-1', ctx } as never
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
  return new TypertGatewayService(ctx)
}

describe('annotation core Typert boundary', () => {
  it('provides explicit Host and Client artifacts with Agent-scoped descriptors', () => {
    expect(TYPERT.package).toBe('dsh-annotation-core')
    expect(TYPERT.face).toBe('host')
    expect(TYPERT_REMOTE.descriptors).toHaveLength(14)
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
    await expect(waiting).rejects.toMatchObject({ name: 'RemoteInvocationCancelled' })
  })

  it('mounts the Client descriptor explicitly and unwraps a real RemoteResult round trip', async () => {
    const hostCtx = new Context()
    const gateway = mountAgentBoundary(
      hostCtx,
      new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' }),
    )
    const clientCtx = new Context()
    new TypertRegistry(clientCtx)
    clientCtx.typert.contexts.registerClient('agent', { identity: () => SessionId('session-1') })
    clientCtx.provide('connection', {
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
      remoteService = ctx.get('annotationCore') as AnnotationCoreRemoteService | undefined
      if (remoteService === undefined) throw new Error('Remote service did not mount')
      const waiting = remoteService.store.waitRevision('session', 0)
      await fiber.dispose()
      await expect(waiting).rejects.toThrow(/disposed/)
      expect(ctx.storageDomain.get('dsh_annotation_core_v1')).toBeUndefined()
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
