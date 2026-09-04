import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

import type { BacklinkOutbox } from './backlink-outbox.ts'
import { createAnnotationContextMessage } from './commit-journal.ts'
import {
  AggregateRevisionConflictError,
  type AdmissionRecord,
  type AnnotationStore,
} from './store.ts'

export interface SettlementResult {
  readonly userObserved: true
  readonly contextObserved: boolean
}

export interface SubmissionSettlement {
  readonly promise: Promise<SettlementResult>
  /** Arm the idle failure only after `agent.send()` has synchronously accepted the wake. */
  afterSend(): void
}

export type SettlementErrorCode = 'idle' | 'flush' | 'disposed' | 'aborted'

export class SettlementError extends Error {
  constructor(
    readonly code: SettlementErrorCode,
    message: string,
    readonly userObserved = false,
    readonly contextObserved = false,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SettlementError'
  }
}

interface Waiter {
  readonly key: string
  readonly agent: Agent
  readonly userMessageId: string
  readonly contextMessageId?: string
  readonly promise: Promise<SettlementResult>
  readonly resolve: (result: SettlementResult) => void
  readonly reject: (error: unknown) => void
  userObserved: boolean
  contextObserved: boolean
  flushing: boolean
  settled: boolean
  idleArmed: boolean
  abort?: () => void
  signal?: AbortSignal
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function targetMessageId(event: SessionEvent): string | undefined {
  return event.type === 'user/message' ? event.data.id : undefined
}

export function scanSubmissionEvents(
  session: Session,
  userMessageId: string,
  contextMessageId?: string,
): { userObserved: boolean; contextObserved: boolean; userSeq?: SessionSeq } {
  let userObserved = false
  let contextObserved = contextMessageId === undefined
  let userSeq: SessionSeq | undefined
  for (const event of session.snapshotEvents()) {
    const messageId = targetMessageId(event)
    if (messageId === userMessageId) {
      userObserved = true
      userSeq = event.seq
    }
    if (contextMessageId !== undefined && messageId === contextMessageId) contextObserved = true
  }
  return { userObserved, contextObserved, ...(userSeq === undefined ? {} : { userSeq }) }
}

/** Per-message settlement barrier over the public session event and flush APIs. */
export class SessionSettlementTracker {
  private readonly waiters = new Map<string, Waiter>()
  private closed = false

  constructor(readonly ctx: Context) {
    ctx.on('session/event', (session, event) => { this.observe(session, event) })
    ctx.on('agent/disposed', ({ agent }) => { this.disposeAgent(agent) })
    ctx.effect(() => () => { this.close() }, 'annotation-core.sessionSettlement')
  }

  begin(agent: Agent, input: {
    readonly userMessageId: string
    readonly contextMessageId?: string
    readonly signal?: AbortSignal
  }): SubmissionSettlement {
    if (this.closed) throw new Error('Annotation settlement tracker is disposed')
    const key = `${agent.id}:${input.userMessageId}`
    const existing = this.waiters.get(key)
    if (existing !== undefined) {
      if (existing.contextMessageId !== input.contextMessageId) throw new Error('Settlement identity conflict')
      return { promise: existing.promise, afterSend: () => { this.armIdle(existing) } }
    }
    let resolve!: (result: SettlementResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<SettlementResult>((accept, fail) => { resolve = accept; reject = fail })
    const found = scanSubmissionEvents(agent.session, input.userMessageId, input.contextMessageId)
    const waiter: Waiter = {
      key,
      agent,
      userMessageId: input.userMessageId,
      ...(input.contextMessageId === undefined ? {} : { contextMessageId: input.contextMessageId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      promise,
      resolve,
      reject,
      userObserved: found.userObserved,
      contextObserved: found.contextObserved,
      flushing: false,
      settled: false,
      idleArmed: false,
    }
    this.waiters.set(key, waiter)
    if (input.signal !== undefined) {
      const abort = () => { this.fail(waiter, new SettlementError('aborted', 'Submission settlement was aborted', waiter.userObserved, waiter.contextObserved, { cause: input.signal?.reason })) }
      waiter.abort = abort
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
    }
    this.maybeFlush(waiter)
    return { promise, afterSend: () => { this.armIdle(waiter) } }
  }

  private observe(session: Session, event: SessionEvent): void {
    const messageId = targetMessageId(event)
    if (messageId === undefined) return
    for (const waiter of this.waiters.values()) {
      if (waiter.agent.session !== session || waiter.settled) continue
      if (messageId === waiter.userMessageId) waiter.userObserved = true
      if (messageId === waiter.contextMessageId) waiter.contextObserved = true
      this.maybeFlush(waiter)
    }
  }

  private maybeFlush(waiter: Waiter): void {
    if (waiter.settled || waiter.flushing || !waiter.userObserved || !waiter.contextObserved) return
    waiter.flushing = true
    void this.ctx.sessions.flush(waiter.agent.session).then((participated) => {
      if (!participated) throw new SettlementError('flush', 'No session durability listener participated in the flush barrier', waiter.userObserved, waiter.contextObserved)
      this.succeed(waiter)
    }, (error) => { this.fail(waiter, new SettlementError('flush', `Session flush failed: ${errorMessage(error)}`, waiter.userObserved, waiter.contextObserved, { cause: error })) })
      .catch((error) => { this.fail(waiter, error) })
  }

  private armIdle(waiter: Waiter): void {
    if (waiter.idleArmed || waiter.settled) return
    waiter.idleArmed = true
    void waiter.agent.whenIdle().then(() => {
      queueMicrotask(() => {
        if (!waiter.settled && !waiter.flushing) {
          this.fail(waiter, new SettlementError('idle',
            `Agent became idle before the exact submission events were committed (user=${waiter.userObserved}, context=${waiter.contextObserved})`,
            waiter.userObserved,
            waiter.contextObserved,
          ))
        }
      })
    }, (error) => { this.fail(waiter, error) })
  }

  private succeed(waiter: Waiter): void {
    if (waiter.settled) return
    waiter.settled = true
    this.cleanup(waiter)
    waiter.resolve({ userObserved: true, contextObserved: waiter.contextObserved })
  }

  private fail(waiter: Waiter, error: unknown): void {
    if (waiter.settled) return
    waiter.settled = true
    this.cleanup(waiter)
    waiter.reject(error)
  }

  private cleanup(waiter: Waiter): void {
    this.waiters.delete(waiter.key)
    if (waiter.abort !== undefined) waiter.signal?.removeEventListener('abort', waiter.abort)
  }

  disposeAgent(agent: Agent): void {
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.agent === agent) this.fail(waiter, new SettlementError('disposed', 'Agent was disposed before submission durability was confirmed', waiter.userObserved, waiter.contextObserved))
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of [...this.waiters.values()]) this.fail(waiter, new SettlementError('disposed', 'Annotation settlement tracker was disposed', waiter.userObserved, waiter.contextObserved))
  }
}

/** Restart/HMR adoption of admissions whose Remote response or flush was interrupted. */
export class StartupSubmissionReconciler {
  constructor(
    readonly ctx: Context,
    readonly store: AnnotationStore,
    readonly outbox: BacklinkOutbox,
    readonly now: () => number = Date.now,
  ) {}

  start(): void {
    for (const agent of this.ctx.agents.list()) void this.reconcile(agent)
    this.ctx.on('agent/created', ({ agent }) => { void this.reconcile(agent) })
  }

  async reconcile(agent: Agent): Promise<void> {
    const admissions = Object.values(this.store.read(agent.id).admissions)
    for (const admission of admissions) {
      try {
        await this.reconcileAdmission(agent, admission)
      } catch (error) {
        await this.recordFailure(agent.id, admission, error)
      }
    }
    this.outbox.kick(agent.id)
  }

  private async reconcileAdmission(agent: Agent, admission: AdmissionRecord): Promise<void> {
    if (admission.state === 'durable') return
    if (admission.userMessageId === undefined) {
      await this.failTerminal(agent.id, admission, new Error('Admission stopped before a user message identity was journaled'))
      return
    }
    const found = scanSubmissionEvents(agent.session, admission.userMessageId, admission.contextMessageId)
    if (!found.userObserved) {
      await this.failTerminal(agent.id, admission, new Error('Journaled user message is absent from restored session history'))
      return
    }
    if (!found.contextObserved && admission.contextMessageId !== undefined) {
      const journal = this.store.readSubmissionJournal(agent.id, admission.userMessageId)
      if (journal === undefined || found.userSeq === undefined) {
        await this.failTerminal(agent.id, admission, new Error('Prepared annotation context cannot be reconstructed'))
        return
      }
      const hasLaterAssistant = agent.session.snapshotEvents().some(
        (event) => event.seq > found.userSeq! && event.type === 'assistant/message',
      )
      if (hasLaterAssistant) {
        await this.failTerminal(agent.id, admission, new Error('A model answer already exists without its annotation context'))
        return
      }
      const context = createAnnotationContextMessage(agent.id, journal)
      agent.session.append('user/message', context, {
        surfaceOp: 'append',
        sourceEventSeqs: [found.userSeq],
      })
    }
    const rescanned = scanSubmissionEvents(agent.session, admission.userMessageId, admission.contextMessageId)
    if (!rescanned.userObserved || !rescanned.contextObserved) {
      await this.failTerminal(agent.id, admission, new Error('Restored submission history is incomplete'))
      return
    }
    const participated = await this.ctx.sessions.flush(agent.session)
    if (!participated) throw new SettlementError('flush', 'No session durability listener participated during startup reconciliation', true, rescanned.contextObserved)
    await this.finalize(agent.id, admission, rescanned.contextObserved)
  }

  private async finalize(sessionId: string, admission: AdmissionRecord, contextObserved: boolean): Promise<void> {
    if (admission.userMessageId === undefined) return
    for (;;) {
      const aggregate = this.store.read(sessionId)
      try {
        await this.store.finalizeDurableSubmission(sessionId, {
          expectedRevision: aggregate.revision,
          clientSubmissionId: admission.clientSubmissionId,
          userMessageId: admission.userMessageId,
          userObserved: true,
          contextObserved,
          committedAt: this.now(),
        })
        return
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }

  private async recordFailure(sessionId: string, admission: AdmissionRecord, error: unknown): Promise<void> {
    if (admission.userMessageId === undefined) return
    for (;;) {
      const aggregate = this.store.read(sessionId)
      const found = aggregate.flushReconciliations[admission.userMessageId]
      try {
        await this.store.recordFlushReconciliation(sessionId, {
          expectedRevision: aggregate.revision,
          userMessageId: admission.userMessageId,
          userObserved: found?.userObserved ?? false,
          contextObserved: found?.contextObserved ?? admission.kind === 'plain',
          flushState: 'failed',
          lastError: errorMessage(error),
          updatedAt: this.now(),
        })
        return
      } catch (failure) {
        if (!(failure instanceof AggregateRevisionConflictError)) throw failure
      }
    }
  }

  private async failTerminal(sessionId: string, admission: AdmissionRecord, error: unknown): Promise<void> {
    if (admission.state === 'failed') return
    for (;;) {
      const aggregate = this.store.read(sessionId)
      try {
        await this.store.failAdmissionAndRestorePending(sessionId, {
          expectedRevision: aggregate.revision,
          clientSubmissionId: admission.clientSubmissionId,
          error: errorMessage(error),
          updatedAt: this.now(),
        })
        return
      } catch (failure) {
        if (!(failure instanceof AggregateRevisionConflictError)) throw failure
      }
    }
  }
}
