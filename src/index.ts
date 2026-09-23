import s from '@deepseek-ai/schemastery'
import type { Context } from './context-types.ts'

import { HostSourceRegistry } from './host/source-registry.ts'
import { availableReferenceSets, registerReferenceTools } from './host/reference-tools.ts'
import { openAnnotationStore, type OpenAnnotationStore } from './host/store.ts'
import { BacklinkOutbox } from './host/backlink-outbox.ts'
import { PendingDiscardOutbox } from './host/pending-discard-outbox.ts'
import { CommittedDeleteOutbox } from './host/committed-delete-outbox.ts'
import { registerAnnotationPreStep } from './host/pre-step.ts'
import { SessionSettlementTracker, StartupSubmissionReconciler } from './host/session-reconcile.ts'
import { AnnotationSubmissionCoordinator } from './host/submit-annotated.ts'
import { registerAnnotationSystemPrompt } from './host/system-prompt.ts'
import { AnnotationCoreRemoteService } from './remote/service.ts'
import { openSessionExtensionData, SessionExtensionStartupStoppedError, type SessionExtensionData } from './host/session-extension-data.ts'
import { LocalSessionContext, localSessionSource } from './host/local-session-context.ts'
import { sessionContextRouter } from './host/session-context-router.ts'
import type { UpstreamHost } from './host/upstream.ts'

export * from './public/host-api.ts'
export { SourcePreparationError } from './host/source-registry.ts'
export type { SourcePreparationErrorCode } from './host/source-registry.ts'

export const name = 'dsh-annotation-core'

export interface Config {
  profileId: string
}

export const Config = s.object({
  profileId: s.string().required(),
})

export const inject: readonly string[] = [
  'storageDomain',
  'agents',
  'sessions',
  'systemPrompt',
  'attachments',
]

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.profileId.trim().length === 0) throw new TypeError('profileId must not be empty')
  // Cleanup may begin while a storage domain is still opening. Register its
  // owner first, then wait for initialization to finish before taking the drain snapshot.
  let opened: OpenAnnotationStore | undefined
  let finishInitialization!: () => void
  const initialized = new Promise<void>(resolve => { finishInitialization = resolve })
  let stopping: Promise<void> | undefined
  let closing = false
  const isClosing = () => closing || ctx.fiber.uid === null
  const shutdown = new Set<() => Promise<void> | void>()
  const stopWork = (): Promise<void> => {
    if (stopping) return stopping
    closing = true
    stopping = initialized.then(async () => {
      const results = await Promise.allSettled([...shutdown].map(stop => {
        try { return stop() } catch (error) { return Promise.reject(error) }
      }))
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, 'Annotation runtime cleanup failed')
    })
    return stopping
  }
  ctx.effect(() => async () => {
    try { await stopWork() } finally { await opened?.close() }
  }, 'annotation-core.domainClose')
  try {
    const runtime = await openAnnotationStore(ctx, config.profileId)
    opened = runtime
    const { store } = runtime
    if (isClosing()) return
    let discardOutbox!: PendingDiscardOutbox
    let deleteOutbox!: CommittedDeleteOutbox
    const sources = new HostSourceRegistry(ctx, {
      referenceDirectory: store.referenceDirectory,
      listReferences: agent => availableReferenceSets(store, agent),
      deleteReferenceLink: async (sessionId, setId, referenceId) => {
        const state = store.readPending(sessionId)
        const result = await store.deleteReferenceLink(sessionId, {
          expectedRevision: state.revision,
          setId,
          referenceId,
          deletedAt: Date.now(),
        })
        if (result.scope === 'pending') discardOutbox.kick(sessionId)
        else deleteOutbox.kick(sessionId)
        return { deleted: result.deleted, scope: result.scope }
      },
    })
    discardOutbox = new PendingDiscardOutbox(store, sources)
    deleteOutbox = new CommittedDeleteOutbox(store, sources)
    {
      const unregister = sources.onAdapterRegistered(() => {
        discardOutbox.kickAll()
        deleteOutbox.kickAll()
      })
      discardOutbox.start()
      deleteOutbox.start()
      shutdown.add(() => {
        unregister()
        return Promise.all([discardOutbox.dispose(), deleteOutbox.dispose()]).then(() => undefined)
      })
    }
    // Direct unit callers may mount only the durable/read boundary. Normal Cordis
    // loading enforces every declared injection above and therefore always enters
    // the complete transaction runtime.
    const completeRuntime = ctx.get('agents') !== undefined &&
      ctx.get('sessions') !== undefined &&
      ctx.get('systemPrompt') !== undefined &&
      ctx.get('attachments') !== undefined
    if (!completeRuntime) {
      new AnnotationCoreRemoteService(ctx, store, undefined, undefined, discardOutbox, deleteOutbox)
      return
    }
    const extensions = ctx.get('sessionExtensionData' as never) as SessionExtensionData | undefined ?? await openSessionExtensionData(ctx, stopWork, isClosing)
    if (isClosing()) return
    if (!ctx.get('sessionReferenceContext' as never)) {
      const local = new LocalSessionContext(extensions, localSessionSource(ctx))
      ctx.provide('sessionReferenceContext' as never, sessionContextRouter(local, () => ctx.get('sessionReferenceContextProvider' as never) as UpstreamHost | undefined) as never)
    }
    const settlements = new SessionSettlementTracker(ctx)
    const outbox = new BacklinkOutbox(store, sources, Date.now, sessionId => deleteOutbox?.kick(sessionId))
    shutdown.add(() => outbox.dispose())
    ctx.inject(['sessionReferenceContext'], connected => {
      let active: Promise<void> | undefined
      let disposed = false
      const retry = () => {
        if (active || disposed || closing) return
        active = Promise.resolve().then(async () => {
          try {
            for (const sessionId of store.sessionIds()) {
              if (disposed || closing) break
              for (const job of store.listBacklinkJobs(sessionId)) {
                if (disposed || closing) break
                const item = store.readSentSet(sessionId, job.setId)?.items.find(item => item.referenceId === job.referenceId)
                if (job.state === 'failed' && item?.sourceType === 'dsh-message' && item.locator.upstream)
                  await outbox.retry(sessionId, job.setId, job.referenceId).catch(() => undefined)
              }
              outbox.kick(sessionId)
            }
            discardOutbox.kickAll()
            deleteOutbox.kickAll()
          } finally { active = undefined }
        })
        void active.catch(() => undefined)
      }
      connected.effect(() => {
        void retry()
        const timer = setInterval(() => { void retry() }, 30000)
        timer.unref()
        const stop = async () => { disposed = true; clearInterval(timer); await active }
        shutdown.add(stop)
        return async () => { await stop(); shutdown.delete(stop) }
      }, 'annotation-core.upstreamOutboxRecovery')
    })
    const submissions = new AnnotationSubmissionCoordinator(ctx, store, sources, settlements, outbox)
    shutdown.add(() => { settlements.close(); return submissions.dispose() })
    new AnnotationCoreRemoteService(ctx, store, submissions, outbox, discardOutbox, deleteOutbox)
    registerAnnotationPreStep(ctx, store)
    registerAnnotationSystemPrompt(ctx)
    registerReferenceTools(ctx, store, sources)
    const reconciler = new StartupSubmissionReconciler(ctx, store, outbox)
    shutdown.add(() => reconciler.dispose())
    reconciler.start()
  } catch (error) {
    if (!(isClosing() && error instanceof SessionExtensionStartupStoppedError)) throw error
  } finally {
    finishInitialization()
  }
}
