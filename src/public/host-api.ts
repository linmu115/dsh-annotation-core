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

export interface DeletedReferenceBinding {
  readonly profileId: string
  readonly sessionId: string
  readonly setId: string
  readonly referenceId: string
  readonly deletedAt: number
  readonly item: ReferenceItem
}

export interface HostSourceAdapter {
  prepare(item: ReferenceItem, signal: AbortSignal): Promise<ReferenceItem>
  discardPending?(item: ReferenceItem): Promise<void>
  commitBacklink?(binding: SentReferenceBinding): Promise<BacklinkReceiptV2>
  deleteCommitted?(binding: DeletedReferenceBinding): Promise<void>
}

export interface AnnotationCoreHost {
  registerSourceAdapter(type: SourceType, adapter: HostSourceAdapter): () => void
  /**
   * Optional host-side mutation used by background integrations that must not
   * depend on an open browser client.
   */
  deleteReferenceLink?(
    sessionId: string,
    setId: string,
    referenceId: string,
  ): Promise<{ deleted: boolean; scope: 'pending' | 'sent' }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    annotationCoreHost: AnnotationCoreHost
  }
}
