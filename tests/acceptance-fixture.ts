import type { Context } from '@deepseek-ai/cordis'
import { HostSourceRegistry } from '../src/host/source-registry.ts'

/** A plugin executor whose receipt is independent of user-message storage. */
export function installAcceptanceFixture(ctx: Context) {
  const sources = (ctx.get('annotationCoreHost') as HostSourceRegistry | undefined) ?? new HostSourceRegistry(ctx)
  const registry = sources.inputAcceptance
  const accepted = new Set<string>()
  const listeners = new Set<() => void>()
  registry.register({
    preview: async () => {},
    read: (_agent, ids) => ({ state: ids.every(id => accepted.has(id)) ? 'accepted' : 'waiting' }),
    activeInputIds: () => [],
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  return { sources, registry, accept(ids: readonly string[]) { for (const id of ids) accepted.add(id); for (const listener of listeners) listener() } }
}
