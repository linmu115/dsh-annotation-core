import type { Context } from './context-types.ts'
import { createRoot } from 'react-dom/client'

import './client/styles.css'
import { normalizeClientConfig } from './client/config.ts'
import { AnnotationCoreClientService } from './client/service.tsx'
import type { ClientConfig } from './client/service.tsx'
import { applyNativeClient } from './client/native-adapter.tsx'
import { TYPERT_REMOTE } from './remote/typert.ts'

export * from './public/client-api.ts'
export { AnnotationCoreClientService } from './client/service.tsx'

export const inject: readonly string[] = ['remote', 'slots', 'sessions', 'conversation', 'uiConversation']

export async function apply(ctx: Context, config?: ClientConfig): Promise<void> {
  const normalized = normalizeClientConfig(config)
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => async () => { await disposeRemote() }, 'dsh-annotation-core: client remote')

  // DSH already injects this module's exported dependencies before apply().
  // Publish on that top-level plugin context so independently loaded consumers
  // (Sticker Board and Sidechat) can resolve annotationCore as sibling plugins.
  const service = new AnnotationCoreClientService(ctx, normalized)
  ctx.effect(() => {
    const host = document.createElement('div')
    host.dataset.dshAnnotationDialogHost = ''
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(service.renderGlobalDialog())
    return () => {
      root.unmount()
      host.remove()
    }
  }, 'dsh-annotation-core: global dialog')
  applyNativeClient(ctx)
}
