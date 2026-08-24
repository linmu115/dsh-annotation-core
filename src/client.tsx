import type { Context } from './context-types.ts'

import './client/styles.css'
import { AnnotationCoreClientService } from './client/service.tsx'
import type { ClientConfig } from './client/service.tsx'
import { applyRc2ClientAdapter } from './rc2/client-adapter.tsx'
import { TYPERT_REMOTE } from './remote/typert.ts'

export * from './public/client-api.ts'
export { AnnotationCoreClientService } from './client/service.tsx'

export const inject: readonly string[] = ['remote', 'slots', 'sessions', 'conversation', 'conversationEvents']

export function apply(ctx: Context, config: ClientConfig): void {
  ctx.inject(inject, async (ready) => {
    const disposeRemote = await ready.remote.$mount(TYPERT_REMOTE)
    ready.effect(() => () => { void disposeRemote() })
    new AnnotationCoreClientService(ready, config)
    applyRc2ClientAdapter(ready)
  })
}
