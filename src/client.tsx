import { Service } from '@deepseek-ai/cordis'
import type { Context } from './context-types.ts'
import type * as React from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'

import type { ReferenceItem } from './domain/model.ts'
import { DshMessageCaptureSchema, selectedTextHash } from './protocol/index.ts'
import type {
  DshMessageCapture,
  DshMessageReferenceSource,
  ReferenceSource,
  SourceType,
} from './protocol/index.ts'
import type {
  AnnotationCoreClient,
  AnnotationCoreFeature,
  ClientSourceAdapter,
  EmbeddedComposerHandle,
  PlainComposerPort,
} from './public/client-api.ts'
import { annotationRemote, unwrapRemote } from './remote/client.ts'
import { TYPERT_REMOTE } from './remote/typert.ts'

export * from './public/client-api.ts'

export const inject: readonly string[] = ['remote']

export interface ClientConfig {
  readonly profileId: string
}

const VERSION = '0.1.0'
type _ClientRemoteTypeRegistration = ClientRemote
const FEATURES: readonly AnnotationCoreFeature[] = Object.freeze([
  'dsh-message-source-v1',
  'backlink-retry-v1',
])

function id(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

class BlockedComposerHandle implements EmbeddedComposerHandle {
  constructor(private draft: string, private readonly plainPort?: PlainComposerPort) {}

  getSnapshot() {
    return {
      visibleDraft: this.draft,
      pendingCount: 0,
      canSubmit: false,
      commitState: 'idle' as const,
      error: 'Embedded composer is installed in Task 6.',
      transport: 'blocked' as const,
      fallbackPolicy: 'unknown' as const,
    }
  }

  subscribe(_listener: () => void): () => void { return () => undefined }
  setVisibleDraft(text: string): void {
    this.draft = text
    this.plainPort?.setDraft(text)
  }
  async submit(): Promise<void> { throw new Error('Embedded composer is not mounted yet') }
  renderReferenceRail(): React.ReactNode { return null }
  dispose(): void {}
}

export class AnnotationCoreClientService extends Service implements AnnotationCoreClient {
  readonly version = VERSION
  readonly features = FEATURES
  private readonly adapters = new Map<SourceType, ClientSourceAdapter>()

  constructor(ctx: Context, readonly config: ClientConfig) {
    super(ctx, 'annotationCore')
    if (config.profileId.trim().length === 0) throw new TypeError('profileId must not be empty')
  }

  async readPendingState(_sessionId: string): Promise<{ revision: number; pendingCount: number }> {
    const state = unwrapRemote(await annotationRemote(this.ctx).readPending())
    return { revision: state.revision, pendingCount: state.pending?.items.length ?? 0 }
  }

  async createDshMessageSource(input: DshMessageCapture): Promise<DshMessageReferenceSource> {
    const capture = DshMessageCaptureSchema.parse(input)
    return {
      sourceType: 'dsh-message',
      selectedText: capture.selectedText,
      locator: {
        profileId: this.config.profileId,
        sessionId: capture.sourceSessionId,
        ...(capture.messageId === undefined ? {} : { messageId: capture.messageId }),
        anchorId: capture.anchorId,
        role: capture.role,
        occurrence: capture.occurrence,
        selectedTextHash: selectedTextHash(capture.selectedText),
      },
    }
  }

  async addReference(
    _sessionId: string,
    source: ReferenceSource,
    options: { operationId?: string; signal?: AbortSignal } = {},
  ): Promise<{ setId: string; referenceId: string; created: boolean }> {
    const remote = annotationRemote(this.ctx)
    const pending = unwrapRemote(await remote.readPending())
    const operationId = options.operationId ?? id('operation')
    if (options.signal?.aborted) {
      unwrapRemote(await remote.fenceReferenceOperation({ expectedRevision: pending.revision, operationId }))
      throw new DOMException('The operation was aborted', 'AbortError')
    }
    const result = unwrapRemote(await remote.addReference({
      expectedRevision: pending.revision,
      operationId,
      setId: pending.pending?.setId ?? id('set'),
      referenceId: id('reference'),
      source,
      createdAt: Date.now(),
    }))
    return { setId: result.setId, referenceId: result.referenceId, created: result.created }
  }

  async fenceReferenceOperation(
    _sessionId: string,
    operationId: string,
  ): Promise<{ state: 'canceled' | 'committed' | 'failed'; fenceRevision: number }> {
    const remote = annotationRemote(this.ctx)
    const state = unwrapRemote(await remote.readPending())
    return unwrapRemote(await remote.fenceReferenceOperation({ expectedRevision: state.revision, operationId }))
  }

  async discardPendingOperation(_sessionId: string, operationId: string): Promise<void> {
    const remote = annotationRemote(this.ctx)
    const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.discardPendingOperation({ expectedRevision: state.revision, operationId }))
  }

  async updateComment(_sessionId: string, referenceId: string, comment: string): Promise<void> {
    const remote = annotationRemote(this.ctx)
    const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.updateComment({ expectedRevision: state.revision, referenceId, comment }))
  }

  async removeReference(_sessionId: string, referenceId: string): Promise<void> {
    const remote = annotationRemote(this.ctx)
    const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.removeReference({ expectedRevision: state.revision, referenceId }))
  }

  async reuseReference(
    referenceId: string,
    _targetSessionId: string,
  ): Promise<{ setId: string; referenceId: string }> {
    const remote = annotationRemote(this.ctx)
    const state = unwrapRemote(await remote.readPending())
    const result = unwrapRemote(await remote.reuseReference({
      expectedRevision: state.revision,
      sourceReferenceId: referenceId,
      operationId: id('operation'),
      setId: state.pending?.setId ?? id('set'),
      referenceId: id('reference'),
      createdAt: Date.now(),
    }))
    return { setId: result.setId, referenceId: result.referenceId }
  }

  async retryBacklink(setId: string, referenceId: string): Promise<void> {
    const remote = annotationRemote(this.ctx)
    const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.retryBacklink({ expectedRevision: state.revision, setId, referenceId }))
  }

  bindComposer(input: { sessionId: string; layout: 'default' | 'narrow'; plainPort?: PlainComposerPort }): EmbeddedComposerHandle {
    return new BlockedComposerHandle(input.plainPort?.getSnapshot().draft ?? '', input.plainPort)
  }

  renderConversationNode(_input: {
    sessionId: string
    node: unknown
    layout: 'default' | 'narrow'
  }): { key: string; node: React.ReactNode } | undefined {
    return undefined
  }

  handleAnswerLink(_sessionId: string, _href: string): boolean { return false }
  openAnnotation(_setId: string, _referenceId?: string): void {}

  registerSourceAdapter(type: SourceType, adapter: ClientSourceAdapter): () => void {
    if (this.adapters.has(type)) throw new Error(`Client source adapter ${JSON.stringify(type)} is already registered`)
    this.adapters.set(type, adapter)
    return () => {
      if (this.adapters.get(type) === adapter) this.adapters.delete(type)
    }
  }

  sourceAdapter(item: ReferenceItem): ClientSourceAdapter | undefined {
    return this.adapters.get(item.sourceType)
  }
}

export function apply(ctx: Context, config: ClientConfig): void {
  ctx.inject(['remote'], async (remoteCtx) => {
    await remoteCtx.remote.$mount(TYPERT_REMOTE)
    new AnnotationCoreClientService(remoteCtx, config)
  })
}
