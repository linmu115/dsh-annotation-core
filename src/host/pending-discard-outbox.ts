import { BackgroundTasks, settleAll } from './background-tasks.ts'
import type { HostSourceRegistry } from './source-registry.ts'
import type { AnnotationStore, PendingDiscardJob } from './store.ts'
import { AggregateRevisionConflictError } from './store.ts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface PendingDiscardOutboxOptions {
  readonly now?: () => number
  readonly retryDelayMs?: number
}

export class PendingDiscardOutbox {
  private readonly tasks = new BackgroundTasks()
  private readonly active = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private readonly retryDelayMs: number
  private disposed = false

  constructor(
    readonly store: AnnotationStore,
    readonly sources: HostSourceRegistry,
    options: PendingDiscardOutboxOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.retryDelayMs = options.retryDelayMs ?? 5_000
  }

  start(): void {
    if (this.disposed) return
    for (const sessionId of this.store.sessionIds()) this.kick(sessionId)
  }

  kickAll(): void {
    if (this.disposed) return
    for (const sessionId of this.store.sessionIds()) this.kick(sessionId)
  }

  kick(sessionId: string): void {
    if (this.disposed) return
    this.clearTimer(sessionId)
    void this.runPending(sessionId).catch(() => undefined)
  }

  async runPending(sessionId: string): Promise<void> {
    if (this.disposed) return
    return this.tasks.run(async () => {
      await settleAll(this.store.listPendingDiscardJobs(sessionId).map((job) => this.runOne(sessionId, job)))
      this.scheduleRetry(sessionId)
    })
  }

  dispose(): Promise<void> {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    return this.tasks.dispose()
  }

  private runOne(sessionId: string, job: PendingDiscardJob): Promise<void> {
    const key = `${sessionId}:${job.referenceId}`
    const existing = this.active.get(key)
    if (existing !== undefined) return existing
    const task = this.discard(sessionId, job).finally(() => { this.active.delete(key) })
    this.active.set(key, task)
    return task
  }

  private async discard(sessionId: string, job: PendingDiscardJob): Promise<void> {
    try {
      const deletion = this.store.readDeletedReference(sessionId, job.referenceId)
      if (deletion !== undefined && deletion.disposition !== 'discard') {
        if (deletion.scope !== 'pending' || deletion.referenceId !== job.referenceId ||
          job.item.referenceId !== job.referenceId || deletion.sourceType !== job.item.sourceType) {
          throw new Error('Pending discard job does not match its deleted reference identity')
        }
        // A persisted relation deletion needs an exact acknowledgement. This
        // also repairs old discard jobs without changing their stored format.
        await this.sources.deleteCommitted({
          profileId: this.store.options.profileId,
          sessionId,
          setId: deletion.setId,
          referenceId: job.referenceId,
          deletedAt: deletion.deletedAt,
          item: job.item,
        })
      } else {
        if (!await this.sources.discardPending(job.item)) return
      }
      await this.complete(sessionId, job.referenceId)
    } catch (error) {
      await this.recordFailure(sessionId, job.referenceId, errorText(error))
    }
  }

  private async complete(sessionId: string, referenceId: string): Promise<void> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      try {
        await this.store.completePendingDiscard(sessionId, {
          expectedRevision: aggregate.revision,
          referenceId,
        })
        return
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }

  private async recordFailure(sessionId: string, referenceId: string, errorTextValue: string): Promise<void> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      if (aggregate.pendingDiscardJobs[referenceId] === undefined) return
      try {
        await this.store.recordPendingDiscardFailure(sessionId, {
          expectedRevision: aggregate.revision,
          referenceId,
          error: errorTextValue,
          updatedAt: this.now(),
        })
        return
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }

  private scheduleRetry(sessionId: string): void {
    if (this.disposed || this.store.listPendingDiscardJobs(sessionId).length === 0 || this.timers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      this.kick(sessionId)
    }, this.retryDelayMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.timers.set(sessionId, timer)
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(sessionId)
  }
}
