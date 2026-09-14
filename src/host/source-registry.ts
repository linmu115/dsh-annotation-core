import { Service } from '@deepseek-ai/cordis'
import { inspectUpstream, upstreamOf, upstreamHost, prepareInitialUpstream } from './upstream.ts'
import { InputAcceptanceRegistry } from './input-acceptance.ts'
import type { Context } from '@deepseek-ai/cordis'

import type { ReferenceItem } from '../domain/model.ts'
import type { ReferenceCommitReceipt } from './reference-commit-receipt.ts'
import type { SourceType } from '../protocol/index.ts'
import type {
  AnnotationCoreHost,
  DeletedReferenceBinding,
  HostSourceAdapter,
  SentReferenceBinding,
} from '../public/host-api.ts'

export type SourcePreparationErrorCode =
  | 'offline'
  | 'online-refresh-failed'
  | 'source-missing'
  | 'source-changed'
  | 'protocol-mismatch'

export interface HostSourceRegistryOptions {
  readonly listReferences?: NonNullable<AnnotationCoreHost['listReferences']>
  readonly deleteReferenceLink?: (
    sessionId: string,
    setId: string,
    referenceId: string,
  ) => Promise<{ deleted: boolean; scope: 'pending' | 'sent' }>
}

export class SourcePreparationError extends Error {
  constructor(readonly code: SourcePreparationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourcePreparationError'
  }
}

export class HostSourceRegistry extends Service implements AnnotationCoreHost {
  readonly inputAcceptance = new InputAcceptanceRegistry()
  private readonly adapters = new Map<SourceType, HostSourceAdapter>()
  private readonly adapterListeners = new Set<(type: SourceType) => void>()

  constructor(ctx: Context, private readonly options: HostSourceRegistryOptions = {}) {
    super(ctx, 'annotationCoreHost')
  }

  listReferences(...args: Parameters<NonNullable<AnnotationCoreHost['listReferences']>>) {
    if (this.options.listReferences === undefined) throw new Error('Host reference reads are not configured')
    return this.options.listReferences(...args)
  }

  async deleteReferenceLink(
    sessionId: string,
    setId: string,
    referenceId: string,
  ): Promise<{ deleted: boolean; scope: 'pending' | 'sent' }> {
    if (this.options.deleteReferenceLink === undefined) {
      throw new Error('Host-side reference deletion is not configured')
    }
    return this.options.deleteReferenceLink(sessionId, setId, referenceId)
  }

  registerSourceAdapter(type: SourceType, adapter: HostSourceAdapter): () => void {
    if (this.adapters.has(type)) throw new Error(`Annotation source adapter ${JSON.stringify(type)} is already registered`)
    const owned = this.ctx.effect(() => {
      this.adapters.set(type, adapter)
      for (const listener of this.adapterListeners) listener(type)
      return () => {
        if (this.adapters.get(type) === adapter) this.adapters.delete(type)
      }
    }, `annotationCoreHost.registerSourceAdapter(${JSON.stringify(type)})`)
    return () => { owned() }
  }

  onAdapterRegistered(listener: (type: SourceType) => void): () => void {
    this.adapterListeners.add(listener)
    return () => { this.adapterListeners.delete(listener) }
  }

  require(type: SourceType): HostSourceAdapter {
    const adapter = this.adapters.get(type)
    if (adapter === undefined) throw new Error(`No annotation source adapter is registered for ${JSON.stringify(type)}`)
    return adapter
  }

  get(type: SourceType): HostSourceAdapter | undefined {
    return this.adapters.get(type)
  }

  async prepare(item: ReferenceItem, signal: AbortSignal): Promise<ReferenceItem> {
    if(upstreamOf(item)){await inspectUpstream(this.ctx,item);signal.throwIfAborted();return item}
    return this.require(item.sourceType).prepare(item, signal)
  }

  async prepareUpstreamContext(item: ReferenceItem, executionId: string, maxBytes: number, totalBytes: number, signal: AbortSignal) {
    signal.throwIfAborted()
    const context = await prepareInitialUpstream(this.ctx, item, executionId, maxBytes, totalBytes)
    signal.throwIfAborted()
    return context
  }

  async endUpstreamExecution(targetSessionId: string, executionId: string): Promise<void> {
    const host = upstreamHost(this.ctx)
    if (typeof host.endExecution === 'function') await host.endExecution(targetSessionId, executionId)
  }

  async discardPending(item: ReferenceItem): Promise<boolean> {
    const upstream = upstreamOf(item)
    if (upstream) {
      await upstreamHost(this.ctx).bind(upstream.targetSessionId, upstream.referenceId, null)
      return true
    }
    const adapter = this.adapters.get(item.sourceType)
    if (!adapter?.discardPending) return false
    await adapter.discardPending(item)
    return true
  }

  async commitBacklink(binding: SentReferenceBinding): Promise<ReferenceCommitReceipt | undefined> {
    const upstream = upstreamOf(binding.item)
    if (upstream) {
      if (upstream.targetSessionId !== binding.sessionId) throw new Error('引用绑定的目标会话不一致')
      await upstreamHost(this.ctx).bind(binding.sessionId, upstream.referenceId, binding.userMessageId)
      const requestId=binding.item.sourceType==='dsh-message'?binding.item.initialContext?.disclosureRequestId:undefined
      if(requestId)await upstreamHost(this.ctx).settleRead?.(binding.sessionId,upstream.referenceId,requestId,'returned')
      return { kind: 'maintenance-reference', referenceId: upstream.referenceId,
        targetMessageId: binding.userMessageId, writtenAt: Date.now() }
    }
    return this.adapters.get(binding.item.sourceType)?.commitBacklink?.(binding)
  }

  async deleteCommitted(binding: DeletedReferenceBinding): Promise<void> {
    const upstream = upstreamOf(binding.item)
    if (upstream) {
      if (upstream.targetSessionId !== binding.sessionId) throw new Error('引用绑定的目标会话不一致')
      await upstreamHost(this.ctx).bind(binding.sessionId, upstream.referenceId, null)
      return
    }
    const adapter = this.adapters.get(binding.item.sourceType)
    if (adapter?.deleteCommitted === undefined) {
      if (binding.item.sourceType === 'dsh-message') return
      throw new Error(`No committed-reference deletion adapter is registered for ${binding.item.sourceType}`)
    }
    await adapter.deleteCommitted(binding)
  }
}
