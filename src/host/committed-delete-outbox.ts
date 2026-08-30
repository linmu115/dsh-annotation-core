import type { HostSourceRegistry } from './source-registry.ts'
import type { AnnotationStore, CommittedDeleteJob } from './store.ts'
import { AggregateRevisionConflictError } from './store.ts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface CommittedDeleteOutboxOptions {
  readonly now?: () => number
  readonly retryDelayMs?: number
}

/** Delivers committed-reference cleanup after Core has durably removed the relation. */
export class CommittedDeleteOutbox {
  private readonly active = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private readonly retryDelayMs: number
  private disposed = false

  constructor(
    readonly store: AnnotationStore,
    readonly sources: HostSourceRegistry,
    options: CommittedDeleteOutboxOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.retryDelayMs = options.retryDelayMs ?? 5_000
  }

  start(): void {
    for (const sessionId of this.store.sessionIds()) this.kick(sessionId)
  }

  kickAll(): void {
    for (const sessionId of this.store.sessionIds()) this.kick(sessionId)
  }

  kick(sessionId: string): void {
    if (this.disposed) return
    this.clearTimer(sessionId)
    void this.runPending(sessionId).catch(() => undefined)
  }

  async runPending(sessionId: string): Promise<void> {
    if (this.disposed) return
    await Promise.all(this.store.listCommittedDeleteJobs(sessionId).map((job) => this.runOne(sessionId, job)))
    this.scheduleRetry(sessionId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private runOne(sessionId: string, job: CommittedDeleteJob): Promise<void> {
    const key = `${sessionId}:${job.setId}:${job.referenceId}`
    const existing = this.active.get(key)
    if (existing !== undefined) return existing
    const task = this.deliver(sessionId, job).finally(() => { this.active.delete(key) })
    this.active.set(key, task)
    return task
  }

  private async deliver(sessionId: string, job: CommittedDeleteJob): Promise<void> {
    try {
      await this.sources.deleteCommitted({
        profileId: this.store.options.profileId,
        sessionId,
        setId: job.setId,
        referenceId: job.referenceId,
        deletedAt: job.deletedAt,
        item: job.item,
      })
      await this.complete(sessionId, job)
    } catch (error) {
      await this.recordFailure(sessionId, job, errorText(error))
    }
  }

  private async complete(sessionId: string, job: CommittedDeleteJob): Promise<void> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      try {
        await this.store.completeCommittedDelete(sessionId, {
          expectedRevision: aggregate.revision,
          setId: job.setId,
          referenceId: job.referenceId,
        })
        return
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }

  private async recordFailure(sessionId: string, job: CommittedDeleteJob, message: string): Promise<void> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      if (aggregate.committedDeleteJobs[`${job.setId}:${job.referenceId}`] === undefined) return
      try {
        await this.store.recordCommittedDeleteFailure(sessionId, {
          expectedRevision: aggregate.revision,
          setId: job.setId,
          referenceId: job.referenceId,
          error: message,
          updatedAt: this.now(),
        })
        return
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }

  private scheduleRetry(sessionId: string): void {
    if (this.disposed || this.store.listCommittedDeleteJobs(sessionId).length === 0 || this.timers.has(sessionId)) return
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
