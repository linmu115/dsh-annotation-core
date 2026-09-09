import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { InputAcceptance, InputAcceptanceProvider } from '../public/host-api.ts'

/** Optional plugin-owned receipts; the ordinary RC1 path remains durable user events. */
export class InputAcceptanceRegistry {
  private readonly providers = new Set<InputAcceptanceProvider>()
  private readonly listeners = new Set<() => void>()
  register(provider: InputAcceptanceProvider): () => void {
    this.providers.add(provider)
    const release = provider.subscribe?.(() => this.notify())
    return () => { release?.(); this.providers.delete(provider); this.notify() }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private notify(): void { for (const listener of this.listeners) listener() }
  async preview(agent: Agent, messages: readonly Parameters<Agent['send']>[0][], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    for (const provider of this.providers) await provider.preview(agent, messages, signal)
  }
  read(ctx: Context, agent: Agent, ids: readonly string[]): InputAcceptance {
    const receipts = [...this.providers].map(provider => provider.read(agent, ids)).filter(value => value !== undefined)
    if (receipts.length > 1) throw new Error('Multiple acceptance providers claim the same input')
    if (receipts[0]) return receipts[0]
    const events = agent.session.snapshotEvents().slice(agent.session.inheritedEventCount)
    return { state: ids.every(id => events.some(event => event.type === 'user/message' && event.data.id === id)) ? 'accepted' : 'waiting' }
  }
  activeInputIds(agent: Agent): readonly string[] {
    return [...new Set([...this.providers].flatMap(provider => provider.activeInputIds(agent)))]
  }
}

export function acceptanceRegistry(ctx: Context): InputAcceptanceRegistry | undefined {
  return ctx.get('annotationCoreHost')?.inputAcceptance as InputAcceptanceRegistry | undefined
}
