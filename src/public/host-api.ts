import type { ReferenceItem } from '../domain/model.ts'
import type { ReferenceSet } from '../domain/model.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
  /** Confirm a durably deleted relation, including a pending relation tombstone. */
  deleteCommitted?(binding: DeletedReferenceBinding): Promise<void>
}

export interface InputAcceptance { readonly state: 'accepted' | 'not-accepted' | 'waiting' }
export interface InputAcceptanceProvider {
  preview(agent: Agent, messages: readonly Parameters<Agent['send']>[0][], signal: AbortSignal): Promise<void>
  /** Undefined means this provider never owned these input identities. */
  read(agent: Agent, inputIds: readonly string[]): InputAcceptance | undefined
  activeInputIds(agent: Agent): readonly string[]
  subscribe?(listener: () => void): () => void
}

/** Bounded read model for optional host mirrors; this is not a submission API. */
export interface AnnotationDirectoryEntry {
  readonly referenceId: string
  readonly setId: string
  readonly sourceType: 'dsh-message' | 'obsidian-note'
  readonly state: 'pending' | 'committing' | 'sent' | 'failed' | 'deleted'
  readonly selectedText: string
  readonly userComment: string
  readonly source: {
    readonly nativeSessionId?: string
    readonly title?: string
    readonly vaultId?: string
    readonly noteId?: string
    readonly notePath?: string
    readonly anchorId?: string
    readonly upstreamReferenceId?: string
  }
  readonly truncated?: boolean
}
export interface AnnotationDirectoryQuery {
  readonly after?: string
  readonly limit?: number
  readonly signal?: AbortSignal
}
export interface AnnotationReferenceDirectory {
  readonly protocolVersion: 1
  listSessions(input?: AnnotationDirectoryQuery): Promise<{
    readonly items: readonly { readonly nativeSessionId: string; readonly sourceRevision: number }[]
    readonly nextCursor: string | null
  }>
  listEntries(input: AnnotationDirectoryQuery & { readonly nativeSessionId: string }): Promise<{
    readonly nativeSessionId: string
    readonly sourceRevision: number
    readonly items: readonly AnnotationDirectoryEntry[]
    readonly nextCursor: string | null
  }>
  /** Fires after durable visible directory changes; sourceRevision is independent of internal journal/job revisions. */
  subscribe(listener: (change: { readonly nativeSessionId: string; readonly sourceRevision: number }) => void): () => void
}

export interface AnnotationCoreHost {
  readonly referenceDirectory?: AnnotationReferenceDirectory | undefined
  readonly inputAcceptance?: {
    register(provider: InputAcceptanceProvider): () => void
  }
  registerSourceAdapter(type: SourceType, adapter: HostSourceAdapter): () => void
  /** Read submitted references and the supplied agent's current input batch, excluding drafts. */
  listReferences?(agent: Agent): readonly ReferenceSet[]
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
