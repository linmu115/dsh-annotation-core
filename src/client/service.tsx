import { Service } from '@deepseek-ai/cordis'
import { chooseCrossSession } from './cross-session-picker.tsx'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type * as React from 'react'

import type { Context } from '../context-types.ts'
import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'
import { selectedTextHash } from '../protocol/serialization.ts'
import type { DshMessageCapture, DshMessageReferenceSource, ReferenceSource, SourceType } from '../protocol/index.ts'
import type { AnnotationCoreClient, AnnotationCoreFeature, ClientSourceAdapter, PlainComposerPort } from '../public/client-api.ts'
import { annotationRemoteForSession, unwrapRemote } from '../remote/client.ts'
import type { AnnotationCoreRemoteNamespace } from '../remote/client.ts'
import { parseAnnotationAnswerLink, resolveAnnotationAnswerLink } from './answer-link.ts'
import { createComposerBinding } from './composer-binding.tsx'
import type { ComposerBinding } from './composer-binding.tsx'
import { AnnotationConversationNode } from './conversation-node.tsx'
import { AnnotationDialogController, ReferenceDialog } from './reference-dialog.tsx'
import { ClientSourceRegistry } from './source-registry.ts'

export interface ClientConfig { readonly profileId: string }

const VERSION = '0.3.4'
type _ClientRemoteTypeRegistration = ClientRemote
const FEATURES: readonly AnnotationCoreFeature[] = Object.freeze([
  'graph-reference-actions-v1',
  'cross-session-upstream-v1',
  'dsh-message-source-v1', 'embedded-composer-v1', 'embedded-conversation-node-v1', 'answer-link-v1', 'backlink-retry-v1',
  'sent-reference-delete-v1', 'session-open-annotation-v1',
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
  private readonly lifetime=new AbortController()
  private readonly nativeComposers=new Map<string,number>()
  private crossSessionTask:Promise<void>|undefined
  private readonly graphReferenceTasks = new Map<string, {
    captureKey: string
    task: Promise<{ setId: string; referenceId: string; created: boolean }>
  }>()
  registerNativeComposer(sessionId:string):()=>void{
    this.nativeComposers.set(sessionId,(this.nativeComposers.get(sessionId)??0)+1)
    return()=>{const count=(this.nativeComposers.get(sessionId)??1)-1;if(count)this.nativeComposers.set(sessionId,count);else this.nativeComposers.delete(sessionId)}
  }
  openCrossSessionReference(input:DshMessageCapture):Promise<void>{
    if(this.crossSessionTask)return this.crossSessionTask
    const capture=structuredClone(validateCapture(input)),operationId=id('cross-reference')
    const task=chooseCrossSession({
      list:(workspaceId,after)=>this.remote(capture.sourceSessionId).upstreamDirectory({...(workspaceId===undefined?{}:{workspaceId}),...(after===undefined?{}:{after})}).then(unwrapRemote),
      select:async target=>{await this.addCrossSessionReference(target,capture,{operationId})},
    },this.lifetime.signal).finally(()=>{this.crossSessionTask=undefined})
    this.crossSessionTask=task;return task
  }

  addCrossSessionReference(target: string, input: DshMessageCapture, options: { operationId?: string } = {}) {
    const capture = structuredClone(validateCapture(input))
    if (capture.role !== 'assistant') return Promise.reject(new Error('请选择一条已完成的 AI 回复'))
    if (!target.trim() || target === capture.sourceSessionId) return Promise.reject(new Error('请选择另一个会话'))
    const operationId = options.operationId ?? id('cross-reference')
    if (!operationId.trim() || operationId.length > 256) return Promise.reject(new TypeError('Invalid reference operation ID'))
    const key = JSON.stringify([target, operationId])
    const captureKey = JSON.stringify([capture.sourceSessionId, capture.messageId, capture.anchorId, capture.role,
      capture.occurrence, capture.selectedText, capture.expectedSourceVersionId])
    const existing = this.graphReferenceTasks.get(key)
    if (existing) return existing.captureKey === captureKey ? existing.task
      : Promise.reject(new Error('同一个引用操作不能更换来源'))
    const task = this.addCrossSessionReferenceToComposer(target, capture, operationId)
      .finally(() => { this.graphReferenceTasks.delete(key) })
    this.graphReferenceTasks.set(key, { captureKey, task })
    return task
  }

  private async addCrossSessionReferenceToComposer(target: string, capture: DshMessageCapture, operationId: string) {
    const sessions = this.ctx.get('sessions') as unknown as {
      refresh(): Promise<void>; open(id: string): void; list: { getSnapshot(): { current?: string } }
    }
    this.lifetime.signal.throwIfAborted()
    await sessions.refresh()
    this.lifetime.signal.throwIfAborted()
    sessions.open(target)
    const assertTarget = () => {
      this.lifetime.signal.throwIfAborted()
      if (sessions.list.getSnapshot().current !== target)
        throw new Error('目标页面已切换，引用尚未加入，请重试')
    }
    const deadline = Date.now() + 15000
    while (!this.nativeComposers.has(target)) {
      assertTarget()
      if (Date.now() > deadline) throw new Error('目标输入框未就绪；选区已保留，可以重试')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assertTarget()
    const source = unwrapRemote(await this.remote(target).captureUpstream({ capture, operationId }))
    const beforeCommit = () => {
      assertTarget()
      if (!this.nativeComposers.has(target)) throw new Error('目标输入框未就绪；选区已保留，可以重试')
    }
    beforeCommit()
    return this.addReference(target, source, { operationId, referenceId: source.locator.upstream!.referenceId, beforeCommit })
  }

  async resolveReferenceLink(sessionId: string, referenceId: string) {
    return unwrapRemote(await this.remote(sessionId).resolveReferenceLink(referenceId))
  }
  readonly version = VERSION
  readonly features = FEATURES
  readonly sources = new ClientSourceRegistry()
  readonly dialog = new AnnotationDialogController()
  private readonly sent = new Map<string, Map<string, ReferenceSet>>()
  private readonly sentSummaries = new Map<string, Map<string, number>>()
  private readonly sentListeners = new Map<string, Set<() => void>>()

  constructor(ctx: Context, readonly config: ClientConfig) {
    super(ctx, 'annotationCore')
    ctx.effect(()=>()=>this.lifetime.abort(),'annotation-core.crossSessionPicker')
    if (config.profileId.trim().length === 0) throw new TypeError('profileId must not be empty')
  }

  private remote(sessionId: string): AnnotationCoreRemoteNamespace { return annotationRemoteForSession(this.ctx, sessionId) }

  async readPendingState(sessionId: string): Promise<{ revision: number; pendingCount: number }> {
    const state = unwrapRemote(await this.remote(sessionId).readPending())
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

  async addReference(sessionId: string, source: ReferenceSource, options: { operationId?: string; referenceId?: string; signal?: AbortSignal; beforeCommit?: () => void } = {}) {
    const remote = this.remote(sessionId); const pending = unwrapRemote(await remote.readPending()); const operationId = options.operationId ?? id('operation')
    if (options.signal?.aborted) {
      unwrapRemote(await remote.fenceReferenceOperation({ expectedRevision: pending.revision, operationId }))
      throw new DOMException('The operation was aborted', 'AbortError')
    }
    options.beforeCommit?.()
    const result = unwrapRemote(await remote.addReference({
      expectedRevision: pending.revision, operationId, setId: pending.pending?.setId ?? id('set'),
      referenceId: options.referenceId ?? id('reference'), source, createdAt: Date.now(),
    }))
    return { setId: result.setId, referenceId: result.referenceId, created: result.created }
  }

  async fenceReferenceOperation(sessionId: string, operationId: string) {
    const remote = this.remote(sessionId); const state = unwrapRemote(await remote.readPending())
    return unwrapRemote(await remote.fenceReferenceOperation({ expectedRevision: state.revision, operationId }))
  }

  async discardPendingOperation(sessionId: string, operationId: string, options: { notifySource?: boolean } = {}): Promise<void> {
    const remote = this.remote(sessionId); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.discardPendingOperation({ expectedRevision: state.revision, operationId, ...options }))
  }

  async updateComment(sessionId: string, referenceId: string, comment: string): Promise<void> {
    const remote = this.remote(sessionId); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.updateComment({ expectedRevision: state.revision, referenceId, comment }))
  }

  async removeReference(sessionId: string, referenceId: string): Promise<void> {
    const remote = this.remote(sessionId); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.removeReference({ expectedRevision: state.revision, referenceId }))
  }

  async deleteReferenceLink(sessionId: string, setId: string, referenceId: string): Promise<{ deleted: boolean; scope: 'pending' | 'sent' }> {
    const remote = this.remote(sessionId)
    const state = unwrapRemote(await remote.readPending())
    const result = unwrapRemote(await remote.deleteReferenceLink({
      expectedRevision: state.revision,
      setId,
      referenceId,
      deletedAt: Date.now(),
    }))
    if (result.scope === 'pending') {
      await this.refreshDialogPending(sessionId, setId)
    } else {
      const refreshed = unwrapRemote(await remote.readSentSet(setId))
      if (refreshed === null) this.forgetSent(sessionId, setId)
      else this.rememberSent(sessionId, refreshed)
      const dialog = this.dialog.getSnapshot()
      if (dialog.set?.setId === setId) {
        if (refreshed === null || refreshed.items.length === 0) this.dialog.close()
        else this.dialog.replace(refreshed)
      }
    }
    return { deleted: result.deleted, scope: result.scope }
  }

  async reuseReference(referenceId: string, targetSessionId: string): Promise<{ setId: string; referenceId: string }> {
    const remote = this.remote(targetSessionId); const state = unwrapRemote(await remote.readPending())
    const result = unwrapRemote(await remote.reuseReference({
      expectedRevision: state.revision, sourceReferenceId: referenceId, operationId: id('operation'),
      setId: state.pending?.setId ?? id('set'), referenceId: id('reference'), createdAt: Date.now(),
    }))
    return { setId: result.setId, referenceId: result.referenceId }
  }

  async retryBacklink(setId: string, referenceId: string): Promise<void> {
    const sessionId = [...this.sent.entries()].find(([, sets]) => sets.has(setId))?.[0]
    if (sessionId === undefined) throw new Error(`dsh-annotation-core: sent set ${JSON.stringify(setId)} has no known session`)
    const remote = this.remote(sessionId); const state = unwrapRemote(await remote.readPending())
    unwrapRemote(await remote.retryBacklink({ expectedRevision: state.revision, setId, referenceId }))
  }

  bindComposer(input: { sessionId: string; layout: 'default' | 'narrow'; plainPort?: PlainComposerPort }): ComposerBinding {
    const remote = this.remote(input.sessionId)
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
    })
    return binding
  }

  private dialogSet(): ReferenceSet {
    const set = this.dialog.getSnapshot().set
    if (set === undefined) throw new Error('dsh-annotation-core: annotation dialog has no active reference set')
    return set
  }

  private async refreshDialogPending(sessionId: string, setId: string): Promise<void> {
    const refreshed = unwrapRemote(await this.remote(sessionId).readPending())
    if (refreshed.pending?.setId === setId) this.dialog.replace(refreshed.pending)
    else if (this.dialog.getSnapshot().set?.setId === setId) this.dialog.close()
  }

  renderGlobalDialog(): React.ReactNode {
    const target = () => {
      const set = this.dialogSet()
      return { set, sessionId: set.sessionId, remote: this.remote(set.sessionId) }
    }
    return <ReferenceDialog
      controller={this.dialog} sources={this.sources}
      updateComment={async (referenceId, comment) => {
        const { set, sessionId, remote } = target()
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.updateComment({ expectedRevision: state.revision, referenceId, comment }))
        await this.refreshDialogPending(sessionId, set.setId)
      }}
      remove={async (referenceId) => {
        const { set, sessionId, remote } = target()
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.removeReference({ expectedRevision: state.revision, referenceId }))
        await this.refreshDialogPending(sessionId, set.setId)
      }}
      deleteLink={async (setId, referenceId) => {
        const { sessionId } = target()
        await this.deleteReferenceLink(sessionId, setId, referenceId)
      }}
      reuse={async (referenceId) => {
        const { remote } = target()
        const state = unwrapRemote(await remote.readPending())
        unwrapRemote(await remote.reuseReference({
          expectedRevision: state.revision, sourceReferenceId: referenceId, operationId: id('operation'),
          setId: state.pending?.setId ?? id('set'), referenceId: id('reference'), createdAt: Date.now(),
        }))
      }}
      retryBacklink={async (setId, referenceId) => {
        const { sessionId, remote } = target()
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
    const remote = this.remote(input.sessionId)
    void this.prefetchSent(input.sessionId, node.data.setId, remote).catch(() => undefined)
    return {
      key: node.key,
      node: <AnnotationConversationNode
        count={node.data.count}
        getCount={() => this.sentSummaries.get(input.sessionId)?.get(node.data.setId) ?? node.data.count}
        subscribeCount={(listener) => this.subscribeSent(input.sessionId, node.data.setId, listener)}
        {...(node.data.genericContextKey === undefined ? {} : { genericContextKey: node.data.genericContextKey })}
        open={() => void this.openSent(input.sessionId, node.data.setId, remote).catch(() => undefined)}
      />,
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
    const remote = this.remote(sessionId); void this.openSent(sessionId, target.setId, remote, target.number).catch(() => undefined)
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

  async openAnnotationInSession(sessionId: string, setId: string, referenceId?: string): Promise<boolean> {
    const set = await this.prefetchSent(sessionId, setId, this.remote(sessionId))
    if (set === undefined || (referenceId !== undefined && !set.items.some((item) => item.referenceId === referenceId))) {
      return false
    }
    this.dialog.open(set, referenceId)
    return true
  }

  private rememberSent(sessionId: string, set: ReferenceSet): void {
    const bySet = this.sent.get(sessionId) ?? new Map<string, ReferenceSet>(); bySet.set(set.setId, set); this.sent.set(sessionId, bySet)
    const summaries = this.sentSummaries.get(sessionId) ?? new Map<string, number>(); summaries.set(set.setId, set.items.length); this.sentSummaries.set(sessionId, summaries)
    this.emitSent(sessionId, set.setId)
  }

  private forgetSent(sessionId: string, setId: string): void {
    this.sent.get(sessionId)?.delete(setId)
    const summaries = this.sentSummaries.get(sessionId) ?? new Map<string, number>()
    summaries.set(setId, 0)
    this.sentSummaries.set(sessionId, summaries)
    this.emitSent(sessionId, setId)
  }

  private sentKey(sessionId: string, setId: string): string { return `${sessionId}\u0000${setId}` }

  private subscribeSent(sessionId: string, setId: string, listener: () => void): () => void {
    const key = this.sentKey(sessionId, setId)
    const listeners = this.sentListeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.sentListeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.sentListeners.delete(key)
    }
  }

  private emitSent(sessionId: string, setId: string): void {
    for (const listener of this.sentListeners.get(this.sentKey(sessionId, setId)) ?? []) listener()
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
