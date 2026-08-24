import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import type { ReferenceItem } from '../domain/model.ts'
import type { SourceType } from '../protocol/index.ts'
import type {
  AnnotationCoreHost,
  HostSourceAdapter,
  SentReferenceBinding,
} from '../public/host-api.ts'

export class HostSourceRegistry extends Service implements AnnotationCoreHost {
  private readonly adapters = new Map<SourceType, HostSourceAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'annotationCoreHost')
  }

  registerSourceAdapter(type: SourceType, adapter: HostSourceAdapter): () => void {
    if (this.adapters.has(type)) throw new Error(`Annotation source adapter ${JSON.stringify(type)} is already registered`)
    const owned = this.ctx.effect(() => {
      this.adapters.set(type, adapter)
      return () => {
        if (this.adapters.get(type) === adapter) this.adapters.delete(type)
      }
    }, `annotationCoreHost.registerSourceAdapter(${JSON.stringify(type)})`)
    return () => { owned() }
  }

  require(type: SourceType): HostSourceAdapter {
    const adapter = this.adapters.get(type)
    if (adapter === undefined) throw new Error(`No annotation source adapter is registered for ${JSON.stringify(type)}`)
    return adapter
  }

  async prepare(item: ReferenceItem, signal: AbortSignal): Promise<ReferenceItem> {
    return this.require(item.sourceType).prepare(item, signal)
  }

  async discardPending(item: ReferenceItem): Promise<void> {
    await this.adapters.get(item.sourceType)?.discardPending?.(item)
  }

  async commitBacklink(binding: SentReferenceBinding): Promise<void> {
    await this.adapters.get(binding.item.sourceType)?.commitBacklink?.(binding)
  }
}
