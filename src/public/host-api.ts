import type { ReferenceItem } from '../domain/model.ts'
import type { BacklinkReceiptV2, SourceType } from '../protocol/index.ts'

export interface SentReferenceBinding {
  readonly profileId: string
  readonly sessionId: string
  readonly setId: string
  readonly referenceId: string
  readonly userMessageId: string
  readonly userAnchorId: string
  readonly userTextHash: string
  readonly item: ReferenceItem
}

export interface HostSourceAdapter {
  prepare(item: ReferenceItem, signal: AbortSignal): Promise<ReferenceItem>
  discardPending?(item: ReferenceItem): Promise<void>
  commitBacklink?(binding: SentReferenceBinding): Promise<BacklinkReceiptV2>
}

export interface AnnotationCoreHost {
  registerSourceAdapter(type: SourceType, adapter: HostSourceAdapter): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    annotationCoreHost: AnnotationCoreHost
  }
}
