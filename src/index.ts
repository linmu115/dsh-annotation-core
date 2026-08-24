import s from '@deepseek-ai/schemastery'
import type { Context } from './context-types.ts'

import { HostSourceRegistry } from './host/source-registry.ts'
import { openAnnotationStore } from './host/store.ts'
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

export const inject: readonly string[] = ['storageDomain']

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.profileId.trim().length === 0) throw new TypeError('profileId must not be empty')
  const opened = await openAnnotationStore(ctx, config.profileId)
  ctx.effect(() => async () => { await opened.close() }, 'annotation-core.domainClose')
  new HostSourceRegistry(ctx)
  new AnnotationCoreRemoteService(ctx, opened.store)
}
