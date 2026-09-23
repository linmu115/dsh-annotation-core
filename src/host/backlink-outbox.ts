import { BackgroundTasks, settleAll } from './background-tasks.ts'
import type { AnnotationStore, BacklinkJob } from './store.ts'
import { AggregateRevisionConflictError } from './store.ts'
import type { HostSourceRegistry } from './source-registry.ts'
import type { ReferenceItem } from '../domain/model.ts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class BacklinkOutbox {
  private readonly tasks = new BackgroundTasks()
  private readonly active = new Map<string, Promise<void>>()

  constructor(
    readonly store: AnnotationStore,
    readonly sources: HostSourceRegistry,
    readonly now: () => number = Date.now,
    readonly onCleanup?: (sessionId: string) => void,
  ) {}

  kick(sessionId: string): void {
    void this.runPending(sessionId).catch(() => undefined)
  }

  async runPending(sessionId: string): Promise<void> {
    if (this.tasks.closed) return
    return this.tasks.run(async () => {
      const pending = this.store.listBacklinkJobs(sessionId).filter((job) => job.state === 'pending')
      await settleAll(pending.map((job) => this.runOne(sessionId, job)))
    })
  }

  dispose(): Promise<void> { return this.tasks.dispose() }

  retry(sessionId: string, setId: string, referenceId: string): Promise<BacklinkJob> {
    return this.tasks.run(() => this.retryOpen(sessionId, setId, referenceId))
  }

  private async retryOpen(sessionId: string, setId: string, referenceId: string): Promise<BacklinkJob> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      try {
        await this.store.retryBacklink(sessionId, {
          expectedRevision: aggregate.revision,
          setId,
          referenceId,
          updatedAt: this.now(),
        })
        break
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
    await this.runPending(sessionId)
    const job = this.store.listBacklinkJobs(sessionId).find(
      (candidate) => candidate.setId === setId && candidate.referenceId === referenceId,
    )
    if (job === undefined) throw new Error('Backlink job disappeared after retry')
    return job
  }

  private runOne(sessionId: string, job: BacklinkJob): Promise<void> {
    const key = `${sessionId}:${job.setId}:${job.referenceId}`
    const existing = this.active.get(key)
    if (existing !== undefined) return existing
    const task = this.commit(sessionId, job).finally(() => { this.active.delete(key) })
    this.active.set(key, task)
    return task
  }

  private async commit(sessionId: string, job: BacklinkJob): Promise<void> {
    if (this.store.readDeletedReference(sessionId, job.referenceId)?.setId === job.setId) return
    const set = this.store.readSentSet(sessionId, job.setId)
    const item = set?.items.find((candidate) => candidate.referenceId === job.referenceId)
    if (
      set === undefined || item === undefined || set.userMessageId === undefined
      || set.userAnchorId === undefined || set.userTextHash === undefined
    ) {
      await this.record(sessionId, job, { error: 'Sent reference binding is incomplete' })
      return
    }
    try {
      const receipt = await this.sources.commitBacklink({
        profileId: set.profileId,
        sessionId,
        setId: set.setId,
        referenceId: item.referenceId,
        userMessageId: set.userMessageId,
        userAnchorId: set.userAnchorId,
        userTextHash: set.userTextHash,
        item,
      })
      if (receipt === undefined) throw new Error(`No backlink writer is registered for ${item.sourceType}`)
      if (await this.cleanupDeleted(sessionId, job, item)) return
      await this.record(sessionId, job, { receipt })
    } catch (error) {
      if (await this.cleanupDeleted(sessionId, job, item)) return
      await this.record(sessionId, job, { error: errorText(error) })
    }
  }

  private async record(
    sessionId: string,
    job: BacklinkJob,
    outcome: { readonly receipt: NonNullable<BacklinkJob['receipt']> } | { readonly error: string },
  ): Promise<void> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      if (aggregate.deletedReferences[job.referenceId]?.setId === job.setId) return
      try {
        await this.store.recordBacklinkResult(sessionId, {
          expectedRevision: aggregate.revision,
          setId: job.setId,
          referenceId: job.referenceId,
          ...outcome,
          updatedAt: this.now(),
        })
        return
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }

  private async cleanupDeleted(sessionId: string, job: BacklinkJob, item: ReferenceItem): Promise<boolean> {
    for (;;) {
      const aggregate = this.store.read(sessionId)
      try {
        const queued = await this.store.reconcileDeletedBacklink(sessionId, {
          expectedRevision: aggregate.revision, setId: job.setId, item, updatedAt: this.now(),
        })
        if (queued) this.onCleanup?.(sessionId)
        return queued
      } catch (error) {
        if (!(error instanceof AggregateRevisionConflictError)) throw error
      }
    }
  }
}
