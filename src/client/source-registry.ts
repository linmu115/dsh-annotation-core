import type { ReferenceItem } from '../domain/model.ts'
import { sourceAdapterKey, type SourceAdapterKey } from '../protocol/index.ts'
import type { ClientSourceAdapter } from '../public/client-api.ts'

export class ClientSourceRegistry {
  private readonly adapters = new Map<SourceAdapterKey, ClientSourceAdapter>()

  register(type: SourceAdapterKey, adapter: ClientSourceAdapter): () => void {
    if (this.adapters.has(type)) throw new Error(`Client source adapter ${JSON.stringify(type)} is already registered`)
    this.adapters.set(type, adapter)
    return () => {
      if (this.adapters.get(type) === adapter) this.adapters.delete(type)
    }
  }

  get(type: SourceAdapterKey): ClientSourceAdapter | undefined {
    return this.adapters.get(type)
  }

  forItem(item: ReferenceItem): ClientSourceAdapter | undefined {
    return this.get(sourceAdapterKey(item))
  }
}
