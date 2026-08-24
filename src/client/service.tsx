import { Service } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type * as React from 'react'

import type { Context } from '../context-types.ts'
import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'
import { selectedTextHash } from '../protocol/serialization.ts'
import type { DshMessageCapture, DshMessageReferenceSource, ReferenceSource, SourceType } from '../protocol/index.ts'
import type { AnnotationCoreClient, AnnotationCoreFeature, ClientSourceAdapter, PlainComposerPort } from '../public/client-api.ts'
import { annotationRemote, unwrapRemote } from '../remote/client.ts'
import type { AnnotationCoreRemoteNamespace } from '../remote/client.ts'
import { parseAnnotationAnswerLink, resolveAnnotationAnswerLink } from './answer-link.ts'
import { createComposerBinding } from './composer-binding.tsx'
import type { ComposerBinding } from './composer-binding.tsx'
import { AnnotationConversationNode } from './conversation-node.tsx'
import { AnnotationDialogController, ReferenceDialog } from './reference-dialog.tsx'
import { ClientSourceRegistry } from './source-registry.ts'

export interface ClientConfig { readonly profileId: string }

const VERSION = '0.1.0'
type _ClientRemoteTypeRegistration = ClientRemote
const FEATURES: readonly AnnotationCoreFeature[] = Object.freeze([
  'dsh-message-source-v1', 'embedded-composer-v1', 'embedded-conversation-node-v1', 'answer-link-v1', 'backlink-retry-v1',
])

function id(prefix: string): string { return `${prefix}-${globalThis.crypto.randomUUID()}` }

function validateCapture(input: DshMessageCapture): DshMessageCapture {
  if (
    input.selectedText.length === 0 || input.sourceSessionId.length === 0 || input.anchorId.length === 0 ||
    (input.messageId !== undefined && input.messageId.length === 0) ||
    (input.role !== 'user' && input.role !== 'assistant') ||
    !Number.isInteger(input.occurrence) || input.occurrence < 0
  ) throw new TypeError('Invalid DSH message capture')
  return input
}

interface AnnotationNodeLike {
  readonly key: string
  readonly kind: 'dsh-annotation'
  readonly data: { readonly setId: string; readonly count: number; readonly genericContextKey?: string }
}

function annotationNode(input: unknown): AnnotationNodeLike | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const node = input as { key?: unknown; kind?: unknown; data?: unknown }
  if (node.kind !== 'dsh-annotation' || typeof node.key !== 'string' || typeof node.data !== 'object' || node.data === null) return undefined
  const data = node.data as { setId?: unknown; count?: unknown; genericContextKey?: unknown }
  if (typeof data.setId !== 'string' || typeof data.count !== 'number' || !Number.isInteger(data.count) || data.count < 1) return undefined
  return {
    key: node.key, kind: 'dsh-annotation',
    data: { setId: data.setId, count: data.count, ...(typeof data.genericContextKey === 'string' ? { genericContextKey: data.genericContextKey } : {}) },
  }
}

export class AnnotationCoreClientService extends Service implements AnnotationCoreClient {
  readonly version = VERSION
  readonly features = FEATURES
  readonly sources = new ClientSourceRegistry()
  readonly dialog = new AnnotationDialogController()
  private readonly sent = new Map<string, Map<string, ReferenceSet>>()
  private readonly sentSummaries = new Map<string, Map<string, number>>()

  constructor(ctx: Context, readonly config: ClientConfig) {
    super(ctx, 'annotationCore')
    if (config.profileId.trim().length === 0) throw new TypeError('profileId must not be empty')
  }

  private remote(): AnnotationCoreRemoteNamespace { return annotationRemote(this.ctx) }

  async readPendingState(_sessionId: string): Promise<{ revision: number; pendingCount: number }> {
    const state = unwrapRemote(await this.remote().readPending())
    return { revision: state.revision, pendingCount: state.pending?.items.length ?? 0 }
  }

  async createDshMessageSource(input: DshMessageCapture): Promise<DshMessageReferenceSource> {
    const capture = validateCapture(input)
    return {
      sourceType: 'dsh-message', selectedText: capture.selectedText,
      locator: {
        profileId: this.config.profileId, sessionId: capture.sourceSessionId,
        ...(capture.messageId === undefined ? {} : { messageId: capture.messageId }),
        anchorId: capture.anchorId, role: capture.role, occurrence: capture.occurrence,
        selectedTextHash: selectedTextHash(capture.selectedText),
      },
    }
  }

  async addReference(_sessionId: string, source: ReferenceSource, options: { operationId?: string; signal?: AbortSignal } = {}) {
    const remote = this.remote(); const pending = unwrapRemote(await remote.readPending()); const operationId = options.operationId ?? id('operation')
    if (options.signal?.aborted) {
      unwrapRemote(await remote.fenceReferenceOperation({ expectedRevision: pending.revision, operationId }))
      throw new DOMException('The operation was aborted', 'AbortError')
    }
    const result = unwrapRemote(await remote.addReference({
      expectedRevision: pending.revision, operationId, setId: pending.pending?.setId ?? id('set'),
      referenceId: id('reference'), source, createdAt: Date.now(),
    }))
    return { setId: result.setId, referenceId: result.referenceId, created: result.created }
  }

  async fenceReferenceOperation(_sessionId: string, operationId: string) {
    const remote = this.remote(); const state = unwrapRemote(await remote.readPending())
    return unwrapRemote(await remote.fenceReferenceOperation({ expectedRevision: state.revision, operationId }))
  }

  async discardPendingOperation(_sessionId: string, operationId: string): Promise<void> {
    const remote = this.remote(); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.discardPendingOperation({ expectedRevision: state.revision, operationId }))
  }

  async updateComment(_sessionId: string, referenceId: string, comment: string): Promise<void> {
    const remote = this.remote(); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.updateComment({ expectedRevision: state.revision, referenceId, comment }))
  }

  async removeReference(_sessionId: string, referenceId: string): Promise<void> {
    const remote = this.remote(); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.removeReference({ expectedRevision: state.revision, referenceId }))
  }

  async reuseReference(referenceId: string, _targetSessionId: string): Promise<{ setId: string; referenceId: string }> {
    const remote = this.remote(); const state = unwrapRemote(await remote.readPending())
    const result = unwrapRemote(await remote.reuseReference({
      expectedRevision: state.revision, sourceReferenceId: referenceId, operationId: id('operation'),
      setId: state.pending?.setId ?? id('set'), referenceId: id('reference'), createdAt: Date.now(),
    }))
    return { setId: result.setId, referenceId: result.referenceId }
  }

  async retryBacklink(setId: string, referenceId: string): Promise<void> {
    const remote = this.remote(); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.retryBacklink({ expectedRevision: state.revision, setId, referenceId }))
  }

  bindComposer(input: { sessionId: string; layout: 'default' | 'narrow'; plainPort?: PlainComposerPort }): ComposerBinding {
    const remote = this.remote()
    let binding: ComposerBinding
    binding = createComposerBinding({
      ...input, remote,
      onOpen: (set, referenceId) => this.dialog.open(set, referenceId),
      onRemove: async (referenceId) => {
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.removeReference({ expectedRevision: state.revision, referenceId }))
        const refreshed = await binding.store.refresh()
        if (refreshed.pending !== null) this.dialog.replace(refreshed.pending); else this.dialog.close()
      },
      renderDialog: () => this.renderDialog(input.sessionId, remote, binding),
    })
    return binding
  }

  private renderDialog(sessionId: string, remote: AnnotationCoreRemoteNamespace, binding?: ComposerBinding): React.ReactNode {
    const refreshPending = async () => {
      const refreshed = binding === undefined ? unwrapRemote(await remote.readPending()) : await binding.store.refresh()
      if (refreshed.pending !== null) this.dialog.replace(refreshed.pending); else this.dialog.close()
    }
    return <ReferenceDialog
      controller={this.dialog} sources={this.sources}
      updateComment={async (referenceId, comment) => {
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.updateComment({ expectedRevision: state.revision, referenceId, comment })); await refreshPending()
      }}
      remove={async (referenceId) => {
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.removeReference({ expectedRevision: state.revision, referenceId })); await refreshPending()
      }}
      reuse={async (referenceId) => {
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.reuseReference({
          expectedRevision: state.revision, sourceReferenceId: referenceId, operationId: id('operation'),
          setId: state.pending?.setId ?? id('set'), referenceId: id('reference'), createdAt: Date.now(),
        })); await refreshPending()
      }}
      retryBacklink={async (setId, referenceId) => {
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.retryBacklink({ expectedRevision: state.revision, setId, referenceId }))
        const sent = unwrapRemote(await remote.readSentSet(setId))
        if (sent !== null) { this.rememberSent(sessionId, sent); this.dialog.open(sent, referenceId) }
      }}
    />
  }

  renderConversationNode(input: { sessionId: string; node: unknown; layout: 'default' | 'narrow' }): { key: string; node: React.ReactNode } | undefined {
    const node = annotationNode(input.node)
    if (node === undefined) return undefined
    const summaries = this.sentSummaries.get(input.sessionId) ?? new Map<string, number>()
    summaries.set(node.data.setId, node.data.count); this.sentSummaries.set(input.sessionId, summaries)
    const remote = this.remote()
    void this.prefetchSent(input.sessionId, node.data.setId, remote).catch(() => undefined)
    return {
      key: node.key,
      node: <>
        <AnnotationConversationNode
          count={node.data.count}
          {...(node.data.genericContextKey === undefined ? {} : { genericContextKey: node.data.genericContextKey })}
          open={() => void this.openSent(input.sessionId, node.data.setId, remote).catch(() => undefined)}
        />
        {this.renderDialog(input.sessionId, remote)}
      </>,
    }
  }

  handleAnswerLink(sessionId: string, href: string): boolean {
    const target = parseAnnotationAnswerLink(href)
    if (target === undefined) return false
    const knownSets = [...(this.sent.get(sessionId)?.values() ?? [])]
    const exact = resolveAnnotationAnswerLink(href, knownSets)
    if (exact !== undefined) { this.dialog.open(exact.set, exact.referenceId); return true }
    const count = this.sentSummaries.get(sessionId)?.get(target.setId)
    if (count === undefined || target.number > count) return false
    const remote = this.remote(); void this.openSent(sessionId, target.setId, remote, target.number).catch(() => undefined)
    return true
  }

  openAnnotation(setId: string, referenceId?: string): void {
    for (const bySet of this.sent.values()) {
      const set = bySet.get(setId)
      if (set !== undefined && (referenceId === undefined || set.items.some((item) => item.referenceId === referenceId))) {
        this.dialog.open(set, referenceId); return
      }
    }
  }

  private rememberSent(sessionId: string, set: ReferenceSet): void {
    const bySet = this.sent.get(sessionId) ?? new Map<string, ReferenceSet>(); bySet.set(set.setId, set); this.sent.set(sessionId, bySet)
    const summaries = this.sentSummaries.get(sessionId) ?? new Map<string, number>(); summaries.set(set.setId, set.items.length); this.sentSummaries.set(sessionId, summaries)
  }

  private async prefetchSent(sessionId: string, setId: string, remote: AnnotationCoreRemoteNamespace): Promise<ReferenceSet | undefined> {
    const cached = this.sent.get(sessionId)?.get(setId)
    if (cached !== undefined) return cached
    const set = unwrapRemote(await remote.readSentSet(setId))
    if (set === null) return undefined
    this.rememberSent(sessionId, set); return set
  }

  private async openSent(sessionId: string, setId: string, remote: AnnotationCoreRemoteNamespace, number?: number): Promise<void> {
    const set = await this.prefetchSent(sessionId, setId, remote)
    if (set === undefined) return
    const referenceId = number === undefined ? undefined : set.items.find((item) => item.number === number)?.referenceId
    if (number !== undefined && referenceId === undefined) return
    this.dialog.open(set, referenceId)
  }

  registerSourceAdapter(type: SourceType, adapter: ClientSourceAdapter): () => void { return this.sources.register(type, adapter) }
  sourceAdapter(item: ReferenceItem): ClientSourceAdapter | undefined { return this.sources.forItem(item) }
}
