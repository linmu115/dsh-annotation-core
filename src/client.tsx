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

export function apply(ctx: Context, config?: ClientConfig): void {
  const normalized = normalizeClientConfig(config)
  ctx.inject(inject, async (ready) => {
    const client = ready as unknown as Context
    const disposeRemote = await client.remote.$mount(TYPERT_REMOTE)
    client.effect(() => () => { void disposeRemote() })
    const service = new AnnotationCoreClientService(client, normalized)
    client.effect(() => {
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
    applyNativeClient(client)
  })
}
