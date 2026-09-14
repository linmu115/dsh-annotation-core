import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment'
import { submissionAttachmentFields, type SubmissionAttachment } from '../protocol/submission-attachments.ts'
import type { SubmitOutcome } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type * as React from 'react'

import type { ReferenceSet } from '../domain/model.ts'
import { submissionRequestDigest } from '../protocol/serialization.ts'
import type { EmbeddedComposerHandle, EmbeddedComposerSnapshot, PlainComposerPort } from '../public/client-api.ts'
import type { AnnotationCoreRemoteNamespace } from '../remote/client.ts'
import { unwrapRemote } from '../remote/client.ts'
import { ReferenceRail } from './reference-rail.tsx'

export type ReferenceLoadStatus = 'loading' | 'ready' | 'blocked'

export interface ReferenceSessionSnapshot {
  readonly status: ReferenceLoadStatus
  readonly revision: number
  readonly pending: ReferenceSet | null
  readonly error?: string
}

const LOADING: ReferenceSessionSnapshot = Object.freeze({ status: 'loading', revision: 0, pending: null })

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ReferenceSessionStore {
  private snapshot: ReferenceSessionSnapshot = LOADING
  private readonly listeners = new Set<() => void>()
  private readonly abort = new AbortController()
  private readonly initial: Promise<void>
  private disposed = false
  private polling = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(readonly remote: AnnotationCoreRemoteNamespace) {
    this.initial = this.start()
  }

  getSnapshot = (): ReferenceSessionSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  ready(): Promise<void> { return this.initial }

  private publish(snapshot: ReferenceSessionSnapshot): void {
    if (this.disposed) return
    if (snapshot.status === 'ready' && snapshot.revision < this.snapshot.revision) return
    this.snapshot = Object.freeze(snapshot)
    for (const listener of this.listeners) listener()
  }

  private async start(): Promise<void> {
    try {
      const first = unwrapRemote(await this.remote.readPending())
      this.publish({ status: 'ready', revision: first.revision, pending: first.pending })
      this.startPoll(first.revision)
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.publish({ status: 'blocked', revision: 0, pending: null, error: errorText(error) })
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.recover() }, 1_000)
      }
    }
  }

  private async poll(afterRevision: number): Promise<void> {
    this.polling = true
    let cursor = afterRevision
    try {
      if (this.remote.watchPending !== undefined) {
        // The Host mux shares one WebSocket across composers. An idle unary
        // wait used to occupy an HTTP connection until the next annotation.
        for await (const next of this.remote.watchPending(this.abort.signal)) {
          if (next.revision < cursor) throw new Error('Annotation revision moved backwards')
          cursor = next.revision
          if (next.revision < this.snapshot.revision) continue
          this.publish({ status: 'ready', revision: next.revision, pending: next.pending })
        }
        if (!this.abort.signal.aborted) throw new Error('Annotation updates disconnected')
        return
      }
      while (!this.abort.signal.aborted) {
        const next = unwrapRemote(await this.remote.waitRevision(cursor, this.abort.signal))
        if (next.revision < cursor) throw new Error('Annotation revision moved backwards')
        cursor = next.revision
        this.publish({ status: 'ready', revision: next.revision, pending: next.pending })
      }
    } catch (error) {
      if (!this.abort.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        this.publish({ status: 'blocked', revision: cursor, pending: this.snapshot.pending, error: errorText(error) })
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.recover() }, 1_000)
      }
    } finally {
      this.polling = false
    }
  }

  private startPoll(revision: number): void {
    if (!this.disposed && !this.polling) void this.poll(revision)
  }

  private async recover(): Promise<void> {
    if (this.disposed) return
    const snapshot = await this.refresh()
    if (snapshot.status === 'ready') this.startPoll(snapshot.revision)
    else this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.recover() }, 1_000)
  }

  async refresh(): Promise<ReferenceSessionSnapshot> {
    try {
      const next = unwrapRemote(await this.remote.readPending())
      const snapshot: ReferenceSessionSnapshot = { status: 'ready', revision: next.revision, pending: next.pending }
      this.publish(snapshot)
      this.startPoll(next.revision)
      return this.snapshot
    } catch (error) {
      const snapshot: ReferenceSessionSnapshot = {
        status: 'blocked', revision: this.snapshot.revision, pending: this.snapshot.pending, error: errorText(error),
      }
      this.publish(snapshot)
      return snapshot
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.listeners.clear()
  }
}

interface PendingAdmission {
  readonly clientSubmissionId: string
  readonly requestDigest: string
}

export interface ComposerBindingOptions {
  readonly sessionId: string
  readonly layout: 'default' | 'narrow'
  readonly remote: AnnotationCoreRemoteNamespace
  readonly store?: ReferenceSessionStore
  readonly plainPort?: PlainComposerPort
  readonly onOpen?: (set: ReferenceSet, referenceId?: string) => void
  readonly onRemove?: (referenceId: string) => Promise<void>
}

function randomId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

export class ComposerBinding implements EmbeddedComposerHandle {
  private visibleDraft: string
  private snapshot: EmbeddedComposerSnapshot
  private localRevision = 0
  private commitState: EmbeddedComposerSnapshot['commitState'] = 'idle'
  private error: string | undefined
  private readonly listeners = new Set<() => void>()
  private readonly ownStore: boolean
  private readonly unsubscribeStore: () => void
  private readonly unsubscribePlain: (() => void) | undefined
  private uncertain: PendingAdmission | undefined
  private disposed = false

  readonly store: ReferenceSessionStore

  constructor(readonly options: ComposerBindingOptions) {
    this.store = options.store ?? new ReferenceSessionStore(options.remote)
    this.ownStore = options.store === undefined
    this.visibleDraft = options.plainPort?.getSnapshot().draft ?? ''
    this.snapshot = Object.freeze(this.buildSnapshot())
    this.unsubscribeStore = this.store.subscribe(() => this.emit())
    this.unsubscribePlain = options.plainPort?.subscribe(() => {
      this.visibleDraft = options.plainPort?.getSnapshot().draft ?? this.visibleDraft
      this.emit()
    })
  }

  private buildSnapshot(): EmbeddedComposerSnapshot {
    const state = this.store.getSnapshot()
    const pendingCount = state.pending?.items.length ?? 0
    const blocked = state.status !== 'ready'
    const transport: EmbeddedComposerSnapshot['transport'] = blocked
      ? 'blocked'
      : pendingCount > 0
        ? this.options.layout === 'default' ? 'native-command-claim' : 'core-host'
        : this.options.layout === 'narrow' && this.options.plainPort !== undefined ? 'plain-fallback' : 'native-command-claim'
    return {
      visibleDraft: this.options.plainPort?.getSnapshot().draft ?? this.visibleDraft,
      pendingCount,
      canSubmit: !blocked && this.commitState !== 'committing',
      commitState: this.commitState,
      ...(this.error === undefined ? {} : { error: this.error }),
      transport,
      fallbackPolicy: blocked ? 'unknown' : pendingCount > 0 ? 'native-required' : 'plain-allowed',
    }
  }

  getSnapshot = (): EmbeddedComposerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const next = this.buildSnapshot()
    const previous = this.snapshot
    if (
      previous.visibleDraft === next.visibleDraft &&
      previous.pendingCount === next.pendingCount &&
      previous.canSubmit === next.canSubmit &&
      previous.commitState === next.commitState &&
      previous.error === next.error &&
      previous.transport === next.transport &&
      previous.fallbackPolicy === next.fallbackPolicy
    ) return
    this.snapshot = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }

  setVisibleDraft(text: string): void {
    this.visibleDraft = text
    this.localRevision += 1
    this.options.plainPort?.setDraft(text)
    this.error = undefined
    this.emit()
  }

  async submit(): Promise<void> {
    if (this.disposed) throw new Error('会话输入框已切换，请在当前输入框重试')
    const state = this.store.getSnapshot()
    if (state.status !== 'ready') throw this.fail(state.error ?? '注释内核状态未知，已阻止发送')
    if (state.pending !== null && state.pending.items.length > 0) {
      const capturedRevision = this.localRevision
      const capturedPlain = this.options.plainPort?.getSnapshot()
      const outcome = await this.submitCore(this.visibleDraft, [])
      if (outcome.kind === 'error') throw this.fail(outcome.text ?? '注释发送失败')
      if (
        capturedPlain !== undefined &&
        this.options.plainPort?.getSnapshot().revision === capturedPlain.revision &&
        this.options.plainPort.getSnapshot().draft === capturedPlain.draft
      ) {
        this.options.plainPort.setDraft('')
        this.visibleDraft = ''
        this.localRevision += 1
      } else if (capturedPlain === undefined && capturedRevision === this.localRevision) {
        this.visibleDraft = ''
        this.localRevision += 1
      }
      this.emit()
      return
    }
    const port = this.options.plainPort
    if (port === undefined) throw this.fail('普通发送由 DSH 原生输入框负责')
    const captured = port.getSnapshot()
    if (captured.draft.trim().length === 0) throw this.fail('请输入正文')
    this.beginCommit()
    try {
      const result = await port.submitPlain({ text: captured.draft, revision: captured.revision })
      if (result.kind === 'error') throw new Error(result.message)
      this.finishCommit()
    } catch (error) {
      throw this.fail(errorText(error))
    }
  }

  async submitClaim(text: string, images: readonly (SubmissionAttachment | EncodedImageAttachment)[]): Promise<SubmitOutcome> {
    const state = this.store.getSnapshot()
    if (state.status !== 'ready') return { kind: 'error', text: state.error ?? '注释内核状态未知，已阻止发送' }
    return this.submitCore(text, images)
  }

  private async submitCore(
    text: string,
    images: readonly (SubmissionAttachment | EncodedImageAttachment)[],
  ): Promise<SubmitOutcome> {
    if (this.disposed) return { kind: 'error', text: '会话输入框已切换，请在当前输入框重试' }
    if (this.commitState === 'committing') return { kind: 'error', text: '正在提交，请勿重复发送' }
    if (text.trim().length === 0) return { kind: 'error', text: images.length === 0 ? '请输入正文' : '先输入正文' }
    const fields = submissionAttachmentFields(images)
    const requestDigest = submissionRequestDigest({ text, ...fields })
    this.beginCommit()
    let identity: PendingAdmission | { readonly settled: SubmitOutcome } | undefined
    try {
      identity = await this.identityFor(requestDigest)
      if ('settled' in identity) {
        if (identity.settled.kind === 'success') {
          this.finishCommit()
          await this.store.refresh()
        } else {
          this.fail(identity.settled.text ?? '上一次发送结果仍未确定')
        }
        return identity.settled
      }
      // Stream delivery and component remounts can lag behind Host mutations.
      // Read current references after resolving any uncertain earlier admission.
      const state = await this.store.refresh()
      if (this.disposed) throw new Error('会话输入框已切换，已保留本次输入，请重试')
      if (state.status !== 'ready') throw new Error(state.error ?? '注释内核状态未知，已保留本次输入')
      const pending = state.pending
      const result = pending !== null && pending.items.length > 0
        ? unwrapRemote(await this.options.remote.submitAnnotated({
            expectedRevision: state.revision,
            setId: pending.setId,
            referenceRevision: pending.revision,
            clientSubmissionId: identity.clientSubmissionId,
            requestDigest,
            text,
            ...fields,
            createdAt: Date.now(),
          }))
        : unwrapRemote(await this.options.remote.submitPlainClaim({
            expectedRevision: state.revision,
            clientSubmissionId: identity.clientSubmissionId,
            requestDigest,
            text,
            ...fields,
            createdAt: Date.now(),
          }))
      if (result.kind === 'error') {
        this.uncertain = undefined
        this.fail(result.message)
        return { kind: 'error', text: result.message }
      }
      this.uncertain = undefined
      this.finishCommit()
      await this.store.refresh()
      return { kind: 'success' }
    } catch (error) {
      if (identity !== undefined && !('settled' in identity)) this.uncertain = identity
      let message = errorText(error)
      if (/^Aggregate revision conflict: expected -?\d+, received -?\d+$/.test(message)) {
        const refreshed = await this.store.refresh()
        message = refreshed.status === 'ready'
          ? '引用在发送准备期间发生变化，已更新引用列表并保留正文，请检查后重新发送'
          : '引用在发送准备期间发生变化，正文已保留；引用列表暂时无法更新，请连接恢复后重试'
      }
      this.fail(message)
      return { kind: 'error', text: message }
    }
  }

  private async identityFor(requestDigest: string): Promise<
    | PendingAdmission
    | { readonly settled: SubmitOutcome }
  > {
    if (this.uncertain === undefined) return { clientSubmissionId: randomId('submission'), requestDigest }
    const prior = unwrapRemote(await this.options.remote.readAdmission(this.uncertain.clientSubmissionId))
    if (prior === null || prior.state === 'failed') {
      // Reuse the key after an unknown transport outcome: an older request may
      // still arrive. Host admission identity prevents duplicate dispatch.
      if (prior === null && this.uncertain.requestDigest === requestDigest) return this.uncertain
      this.uncertain = undefined
      return { clientSubmissionId: randomId('submission'), requestDigest }
    }
    if (prior.state === 'durable') {
      await this.store.refresh()
      const sameRequest = this.uncertain.requestDigest === requestDigest
      this.uncertain = undefined
      if (sameRequest) return { settled: { kind: 'success' } }
      return { clientSubmissionId: randomId('submission'), requestDigest }
    }
    return { settled: { kind: 'error', text: '上一次发送结果仍未确定，请稍后重试' } }
  }

  private beginCommit(): void { this.commitState = 'committing'; this.error = undefined; this.emit() }
  private finishCommit(): void { this.commitState = 'idle'; this.error = undefined; this.emit() }
  private fail(message: string): Error {
    this.commitState = 'failed'; this.error = message; this.emit()
    return new Error(message)
  }

  renderReferenceRail(): React.ReactNode {
    return <ReferenceRail
      layout={this.options.layout}
      store={this.store}
      open={(set, referenceId) => this.options.onOpen?.(set, referenceId)}
      remove={this.options.onRemove ?? (async () => { throw new Error('Reference mutation is unavailable') })}
    />
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeStore()
    this.unsubscribePlain?.()
    if (this.ownStore) this.store.dispose()
    this.listeners.clear()
  }
}

export function createComposerBinding(options: ComposerBindingOptions): ComposerBinding {
  return new ComposerBinding(options)
}
