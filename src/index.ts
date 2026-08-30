import s from '@deepseek-ai/schemastery'
import type { Context } from './context-types.ts'

import { HostSourceRegistry } from './host/source-registry.ts'
import { openAnnotationStore } from './host/store.ts'
import { BacklinkOutbox } from './host/backlink-outbox.ts'
import { PendingDiscardOutbox } from './host/pending-discard-outbox.ts'
import { CommittedDeleteOutbox } from './host/committed-delete-outbox.ts'
import { registerAnnotationPreStep } from './host/pre-step.ts'
import { SessionSettlementTracker, StartupSubmissionReconciler } from './host/session-reconcile.ts'
import { AnnotationSubmissionCoordinator } from './host/submit-annotated.ts'
import { registerAnnotationSystemPrompt } from './host/system-prompt.ts'
import { AnnotationCoreRemoteService } from './remote/service.ts'

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
  const opened = await openAnnotationStore(ctx, config.profileId)
  ctx.effect(() => async () => { await opened.close() }, 'annotation-core.domainClose')
  let discardOutbox!: PendingDiscardOutbox
  let deleteOutbox!: CommittedDeleteOutbox
  const sources = new HostSourceRegistry(ctx, {
    deleteReferenceLink: async (sessionId, setId, referenceId) => {
      const state = opened.store.readPending(sessionId)
      const result = await opened.store.deleteReferenceLink(sessionId, {
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
  discardOutbox = new PendingDiscardOutbox(opened.store, sources)
  deleteOutbox = new CommittedDeleteOutbox(opened.store, sources)
  ctx.effect(() => {
    const unregister = sources.onAdapterRegistered(() => {
      discardOutbox.kickAll()
      deleteOutbox.kickAll()
    })
    discardOutbox.start()
    deleteOutbox.start()
    return () => {
      unregister()
      discardOutbox.dispose()
      deleteOutbox.dispose()
    }
  }, 'annotation-core.pendingDiscardOutbox')
  // Direct unit callers may mount only the durable/read boundary. Normal Cordis
  // loading enforces every declared injection above and therefore always enters
  // the complete transaction runtime.
  const completeRuntime = ctx.get('agents') !== undefined &&
    ctx.get('sessions') !== undefined &&
    ctx.get('systemPrompt') !== undefined &&
    ctx.get('attachments') !== undefined
  if (!completeRuntime) {
    new AnnotationCoreRemoteService(ctx, opened.store, undefined, undefined, discardOutbox, deleteOutbox)
    return
  }
  const settlements = new SessionSettlementTracker(ctx)
  const outbox = new BacklinkOutbox(opened.store, sources)
  const submissions = new AnnotationSubmissionCoordinator(ctx, opened.store, sources, settlements, outbox)
  new AnnotationCoreRemoteService(ctx, opened.store, submissions, outbox, discardOutbox, deleteOutbox)
  registerAnnotationPreStep(ctx, opened.store)
  registerAnnotationSystemPrompt(ctx)
  new StartupSubmissionReconciler(ctx, opened.store, outbox).start()
}
