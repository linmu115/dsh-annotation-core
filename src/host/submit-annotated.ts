import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { beginReferenceCommit } from '../domain/state-machine.ts'
import {
  annotationContextMessageId,
  serializePreparedReferenceSet,
  submissionRequestDigest,
} from '../protocol/index.ts'
import { createDirectUserMessage } from './admit-images.ts'
import type { SubmitImageAttachment } from './admit-images.ts'
import type { BacklinkOutbox } from './backlink-outbox.ts'
import { prepareReferenceSet } from './prepare-reference-set.ts'
import type { PrepareResult } from './prepare-reference-set.ts'
import { SettlementError, SessionSettlementTracker } from './session-reconcile.ts'
import type { HostSourceRegistry } from './source-registry.ts'
import {
  AdmissionConflictError,
  AggregateRevisionConflictError,
  type AdmissionRecord,
  type AnnotationStore,
} from './store.ts'

export interface SubmitAnnotatedInput {
  readonly expectedRevision: number
  readonly setId: string
  readonly referenceRevision: number
  readonly clientSubmissionId: string
  readonly requestDigest: string
  readonly text: string
  readonly images?: readonly SubmitImageAttachment[]
  readonly useSavedSnapshotFor?: readonly string[]
  readonly createdAt: number
}

export interface SubmitPlainInput {
  readonly expectedRevision: number
  readonly clientSubmissionId: string
  readonly requestDigest: string
  readonly text: string
  readonly images?: readonly SubmitImageAttachment[]
  readonly createdAt: number
}

export interface SubmissionSuccess {
  readonly kind: 'success'
  readonly clientSubmissionId: string
  readonly userMessageId: string
  readonly setId?: string
}

export interface SubmissionFailure {
  readonly kind: 'error'
  readonly code:
    | 'source-confirmation'
    | 'source-blocked'
    | 'image-admission'
    | 'delivery'
    | 'durability'
    | 'unresolved'
  readonly message: string
  readonly details?: unknown
}

export type SubmissionResult = SubmissionSuccess | SubmissionFailure

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function prepareFailure(result: Exclude<PrepareResult, { kind: 'ready' }>): SubmissionFailure {
  if (result.kind === 'needs-confirmation') {
    return {
      kind: 'error',
      code: 'source-confirmation',
      message: 'One or more Obsidian notes could not be refreshed. Confirm use of the saved snapshot before retrying.',
      details: result,
    }
  }
  return {
    kind: 'error',
    code: 'source-blocked',
    message: `Annotation source preparation was blocked: ${result.reason}`,
    details: result,
  }
}

/** Host-owned idempotent transaction; Remote and embedded clients share this one path. */
export class AnnotationSubmissionCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(
    readonly ctx: Context,
    readonly store: AnnotationStore,
    readonly sources: HostSourceRegistry,
    readonly settlements: SessionSettlementTracker,
    readonly outbox: BacklinkOutbox,
    readonly now: () => number = Date.now,
  ) {}

  submitAnnotated(agent: Agent, input: SubmitAnnotatedInput, signal?: AbortSignal): Promise<SubmissionResult> {
    return this.exclusive(agent.id, () => this.submitAnnotatedExclusive(agent, input, signal))
  }

  submitPlain(agent: Agent, input: SubmitPlainInput, signal?: AbortSignal): Promise<SubmissionResult> {
    return this.exclusive(agent.id, () => this.submitPlainExclusive(agent, input, signal))
  }

  private async submitAnnotatedExclusive(
    agent: Agent,
    input: SubmitAnnotatedInput,
    signal?: AbortSignal,
  ): Promise<SubmissionResult> {
    this.validateRequest(input)
    const known = this.store.readAdmission(agent.id, input.clientSubmissionId)
    if (known !== undefined) {
      if (
        known.requestDigest !== input.requestDigest ||
        known.kind !== 'annotated' ||
        known.setId !== input.setId ||
        known.referenceRevision !== input.referenceRevision
      ) throw new AdmissionConflictError(input.clientSubmissionId)
      return this.resumeKnown(agent, known, signal)
    }

    const pending = this.store.readPending(agent.id)
    if (pending.pending?.setId !== input.setId || pending.pending.revision !== input.referenceRevision) {
      throw new AggregateRevisionConflictError(input.referenceRevision, pending.pending?.revision ?? -1)
    }
    const contextWindow = agent.session.requestContext()?.contextWindow
    const prepared = await prepareReferenceSet(pending.pending, this.sources, {
      budget: contextWindow === undefined ? {} : { contextWindow },
      useSavedSnapshotFor: new Set(input.useSavedSnapshotFor ?? []),
      ...(signal === undefined ? {} : { signal }),
    })
    if (prepared.kind !== 'ready') return prepareFailure(prepared)

    const begun = await this.store.beginAnnotatedAdmission(agent.id, {
      expectedRevision: input.expectedRevision,
      clientSubmissionId: input.clientSubmissionId,
      requestDigest: input.requestDigest,
      setId: input.setId,
      referenceRevision: input.referenceRevision,
      createdAt: input.createdAt,
    })
    if (!begun.created) return this.resumeKnown(agent, begun.record, signal)
    const preparedSet = beginReferenceCommit(prepared.set, prepared.set.revision)

    let message
    try {
      message = await createDirectUserMessage({
        attachments: this.ctx.attachments,
        text: input.text,
        ...(input.images === undefined ? {} : { images: input.images }),
      })
    } catch (error) {
      await this.failTerminal(agent.id, input.clientSubmissionId, error)
      return { kind: 'error', code: 'image-admission', message: errorText(error) }
    }

    const serialized = serializePreparedReferenceSet(preparedSet, prepared.documents)
    const contextMessageId = annotationContextMessageId({
      sessionId: agent.id,
      userMessageId: message.id,
      setId: input.setId,
      digest: serialized.digest,
    })
    await this.store.recordEnqueuedSubmission(agent.id, {
      expectedRevision: begun.revision,
      clientSubmissionId: input.clientSubmissionId,
      requestDigest: input.requestDigest,
      userMessageId: message.id,
      contextMessageId,
      contextDigest: serialized.digest,
      preparedSet,
      createdAt: input.createdAt,
    })
    return this.deliverAndSettle(agent, input.clientSubmissionId, message, signal)
  }

  private async submitPlainExclusive(
    agent: Agent,
    input: SubmitPlainInput,
    signal?: AbortSignal,
  ): Promise<SubmissionResult> {
    this.validateRequest(input)
    const known = this.store.readAdmission(agent.id, input.clientSubmissionId)
    if (known !== undefined) {
      if (known.requestDigest !== input.requestDigest || known.kind !== 'plain') {
        throw new AdmissionConflictError(input.clientSubmissionId)
      }
      return this.resumeKnown(agent, known, signal)
    }
    const begun = await this.store.beginPlainAdmission(agent.id, {
      expectedRevision: input.expectedRevision,
      clientSubmissionId: input.clientSubmissionId,
      requestDigest: input.requestDigest,
      createdAt: input.createdAt,
    })
    if (!begun.created) return this.resumeKnown(agent, begun.record, signal)
    let message
    try {
      message = await createDirectUserMessage({
        attachments: this.ctx.attachments,
        text: input.text,
        ...(input.images === undefined ? {} : { images: input.images }),
      })
    } catch (error) {
      await this.failTerminal(agent.id, input.clientSubmissionId, error)
      return { kind: 'error', code: 'image-admission', message: errorText(error) }
    }
    await this.store.recordEnqueuedSubmission(agent.id, {
      expectedRevision: begun.revision,
      clientSubmissionId: input.clientSubmissionId,
      requestDigest: input.requestDigest,
      userMessageId: message.id,
      createdAt: input.createdAt,
    })
    return this.deliverAndSettle(agent, input.clientSubmissionId, message, signal)
  }

  private validateRequest(input: SubmitAnnotatedInput | SubmitPlainInput): void {
    if (input.text.trim().length === 0) throw new RangeError('Submission requires nonempty text')
    const actual = submissionRequestDigest({
      text: input.text,
      ...(input.images === undefined ? {} : { images: input.images }),
    })
    if (actual !== input.requestDigest) throw new AdmissionConflictError(input.clientSubmissionId)
  }

  private async resumeKnown(agent: Agent, admission: AdmissionRecord, signal?: AbortSignal): Promise<SubmissionResult> {
    if (admission.state === 'durable') {
      if (admission.userMessageId === undefined) throw new Error('Durable admission has no user message ID')
      return {
        kind: 'success',
        clientSubmissionId: admission.clientSubmissionId,
        userMessageId: admission.userMessageId,
        ...(admission.setId === undefined ? {} : { setId: admission.setId }),
      }
    }
    if (admission.state === 'failed') {
      return { kind: 'error', code: 'delivery', message: admission.lastError ?? 'The previous submission failed' }
    }
    if (admission.state === 'prepared' || admission.userMessageId === undefined) {
      await this.failTerminal(agent.id, admission.clientSubmissionId, new Error('Prepared admission was abandoned before message journaling'))
      return { kind: 'error', code: 'delivery', message: 'The previous submission stopped before message journaling; retry with a new submission ID.' }
    }
    return this.settleRecorded(agent, admission, signal)
  }

  private async deliverAndSettle(
    agent: Agent,
    clientSubmissionId: string,
    message: Parameters<Agent['send']>[0],
    signal?: AbortSignal,
  ): Promise<SubmissionResult> {
    const admission = this.store.readAdmission(agent.id, clientSubmissionId)
    if (admission?.userMessageId !== message.id) throw new Error('Enqueued admission lost its message identity')
    const settlement = this.settlements.begin(agent, {
      userMessageId: message.id,
      ...(admission.contextMessageId === undefined ? {} : { contextMessageId: admission.contextMessageId }),
      ...(signal === undefined ? {} : { signal }),
    })
    try {
      agent.send(message, 'next-turn', true)
    } catch (error) {
      await this.failTerminal(agent.id, clientSubmissionId, error)
      return { kind: 'error', code: 'delivery', message: errorText(error) }
    }
    settlement.afterSend()
    return this.awaitSettlement(agent, admission, settlement.promise)
  }

  private async settleRecorded(agent: Agent, admission: AdmissionRecord, signal?: AbortSignal): Promise<SubmissionResult> {
    if (admission.userMessageId === undefined) throw new Error('Enqueued admission has no user message ID')
    const settlement = this.settlements.begin(agent, {
      userMessageId: admission.userMessageId,
      ...(admission.contextMessageId === undefined ? {} : { contextMessageId: admission.contextMessageId }),
      ...(signal === undefined ? {} : { signal }),
    })
    settlement.afterSend()
    return this.awaitSettlement(agent, admission, settlement.promise)
  }

  private async awaitSettlement(
    agent: Agent,
    admission: AdmissionRecord,
    promise: ReturnType<SessionSettlementTracker['begin']>['promise'],
  ): Promise<SubmissionResult> {
    try {
      const observed = await promise
      const finalized = await this.finalizeLatest(agent.id, admission, observed)
      this.outbox.kick(agent.id)
      return {
        kind: 'success',
        clientSubmissionId: admission.clientSubmissionId,
        userMessageId: finalized.userMessageId as string,
        ...(finalized.setId === undefined ? {} : { setId: finalized.setId }),
      }
    } catch (error) {
      await this.recordReconciliationFailure(agent.id, admission, error)
      if (error instanceof SettlementError && error.code !== 'idle') {
        return { kind: 'error', code: 'unresolved', message: error.message }
      }
      await this.failTerminal(agent.id, admission.clientSubmissionId, error)
      return { kind: 'error', code: 'durability', message: errorText(error) }
    }
  }

  private async finalizeLatest(
    sessionId: string,
    admission: AdmissionRecord,
    observed: { readonly userObserved: true; readonly contextObserved: boolean },
  ): Promise<AdmissionRecord> {
    if (admission.userMessageId === undefined) throw new Error('Cannot finalize an admission without a user message')
    for (;;) {
      const aggregate = this.store.read(sessionId)
      try {
        const result = await this.store.finalizeDurableSubmission(sessionId, {
          expectedRevision: aggregate.revision,
          clientSubmissionId: admission.clientSubmissionId,
          userMessageId: admission.userMessageId,
          userObserved: observed.userObserved,
          contextObserved: observed.contextObserved,
          committedAt: this.now(),
        })
        return result.admission
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }

  private async recordReconciliationFailure(sessionId: string, admission: AdmissionRecord, error: unknown): Promise<void> {
    if (admission.userMessageId === undefined) return
    for (;;) {
      const aggregate = this.store.read(sessionId)
      const previous = aggregate.flushReconciliations[admission.userMessageId]
      try {
        await this.store.recordFlushReconciliation(sessionId, {
          expectedRevision: aggregate.revision,
          userMessageId: admission.userMessageId,
          userObserved: error instanceof SettlementError ? error.userObserved : (previous?.userObserved ?? false),
          contextObserved: error instanceof SettlementError ? error.contextObserved : (previous?.contextObserved ?? admission.kind === 'plain'),
          flushState: 'failed',
          lastError: errorText(error),
          updatedAt: this.now(),
        })
        return
      } catch (failure) {
        if (!(failure instanceof AggregateRevisionConflictError)) throw failure
      }
    }
  }

  private async failTerminal(sessionId: string, clientSubmissionId: string, error: unknown): Promise<void> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      const admission = aggregate.admissions[clientSubmissionId]
      if (admission === undefined || admission.state === 'durable' || admission.state === 'failed') return
      try {
        await this.store.failAdmissionAndRestorePending(sessionId, {
          expectedRevision: aggregate.revision,
          clientSubmissionId,
          error: errorText(error),
          updatedAt: this.now(),
        })
        return
      } catch (failure) {
        if (!(failure instanceof AggregateRevisionConflictError)) throw failure
      }
    }
  }

  private async exclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => turn)
    this.tails.set(sessionId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    }
  }
}
