import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import type { ReferenceItem } from '../domain/model.ts'
import type { BacklinkReceiptV2 } from '../protocol/index.ts'
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
  private readonly adapters = new Map<SourceType, HostSourceAdapter>()
  private readonly adapterListeners = new Set<(type: SourceType) => void>()

  constructor(ctx: Context, private readonly options: HostSourceRegistryOptions = {}) {
    super(ctx, 'annotationCoreHost')
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
    return this.require(item.sourceType).prepare(item, signal)
  }

  async discardPending(item: ReferenceItem): Promise<void> {
    await this.adapters.get(item.sourceType)?.discardPending?.(item)
  }

  async commitBacklink(binding: SentReferenceBinding): Promise<BacklinkReceiptV2 | undefined> {
    return this.adapters.get(binding.item.sourceType)?.commitBacklink?.(binding)
  }

  async deleteCommitted(binding: DeletedReferenceBinding): Promise<void> {
    const adapter = this.adapters.get(binding.item.sourceType)
    if (adapter?.deleteCommitted === undefined) {
      if (binding.item.sourceType === 'dsh-message') return
      throw new Error(`No committed-reference deletion adapter is registered for ${binding.item.sourceType}`)
    }
    await adapter.deleteCommitted(binding)
  }
}
