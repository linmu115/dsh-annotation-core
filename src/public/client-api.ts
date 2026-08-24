import type * as React from 'react'

import type { ReferenceItem } from '../domain/model.ts'
import type {
  DshMessageCapture,
  DshMessageReferenceSource,
  ReferenceSource,
  SourceType,
} from '../protocol/index.ts'

export type AnnotationCoreFeature =
  | 'dsh-message-source-v1'
  | 'embedded-composer-v1'
  | 'embedded-conversation-node-v1'
  | 'answer-link-v1'
  | 'backlink-retry-v1'

export interface ClientSourceAdapter {
  openSource(item: ReferenceItem): Promise<void>
  copySourceLink?(item: ReferenceItem): Promise<string>
}

export interface PlainComposerSnapshot {
  readonly draft: string
  readonly revision: number
}

export type PlainSubmitResult =
  | { readonly kind: 'success'; readonly submittedRevision: number }
  | { readonly kind: 'error'; readonly submittedRevision: number; readonly message: string }

export interface PlainComposerPort {
  getSnapshot(): PlainComposerSnapshot
  subscribe(listener: () => void): () => void
  setDraft(text: string): void
  submitPlain(input: { text: string; revision: number }): Promise<PlainSubmitResult>
}

export interface EmbeddedComposerSnapshot {
  readonly visibleDraft: string
  readonly pendingCount: number
  readonly canSubmit: boolean
  readonly commitState: 'idle' | 'committing' | 'failed'
  readonly error?: string
  readonly transport: 'native-command-claim' | 'core-host' | 'plain-fallback' | 'blocked'
  readonly fallbackPolicy: 'plain-allowed' | 'native-required' | 'unknown'
}

export interface EmbeddedComposerHandle {
  getSnapshot(): EmbeddedComposerSnapshot
  subscribe(listener: () => void): () => void
  setVisibleDraft(text: string): void
  submit(): Promise<void>
  renderReferenceRail(): React.ReactNode
  dispose(): void
}

export interface AnnotationCoreClient {
  readonly version: string
  readonly features: readonly AnnotationCoreFeature[]
  readPendingState(sessionId: string): Promise<{ revision: number; pendingCount: number }>
  createDshMessageSource(input: DshMessageCapture): Promise<DshMessageReferenceSource>
  addReference(
    sessionId: string,
    source: ReferenceSource,
    options?: { operationId?: string; signal?: AbortSignal },
  ): Promise<{ setId: string; referenceId: string; created: boolean }>
  fenceReferenceOperation(
    sessionId: string,
    operationId: string,
  ): Promise<{ state: 'canceled' | 'committed' | 'failed'; fenceRevision: number }>
  discardPendingOperation(sessionId: string, operationId: string): Promise<void>
  updateComment(sessionId: string, referenceId: string, comment: string): Promise<void>
  removeReference(sessionId: string, referenceId: string): Promise<void>
  reuseReference(referenceId: string, targetSessionId: string): Promise<{ setId: string; referenceId: string }>
  retryBacklink(setId: string, referenceId: string): Promise<void>
  bindComposer(input: {
    sessionId: string
    layout: 'default' | 'narrow'
    plainPort?: PlainComposerPort
  }): EmbeddedComposerHandle
  renderConversationNode(input: {
    sessionId: string
    node: unknown
    layout: 'default' | 'narrow'
  }): { key: string; node: React.ReactNode } | undefined
  handleAnswerLink(sessionId: string, href: string): boolean
  openAnnotation(setId: string, referenceId?: string): void
  registerSourceAdapter(type: SourceType, adapter: ClientSourceAdapter): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    annotationCore: AnnotationCoreClient
  }
}
