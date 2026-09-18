import type { DshMessageCapture } from '../protocol/index.ts'

/** A consumer contributes an action, never another DOM selection listener. */
export interface SelectionAction {
  readonly id: string
  readonly label: string | (() => string)
  readonly order?: number
  readonly iconPath?: string
  available?(capture: DshMessageCapture): boolean
  run(capture: DshMessageCapture): Promise<unknown>
}

export class SelectionActions {
  private readonly actions = new Map<string, SelectionAction>()
  private snapshot: readonly SelectionAction[] = []
  private readonly listeners = new Set<() => void>()
  getSnapshot = (): readonly SelectionAction[] => this.snapshot
  subscribe = (notify: () => void): (() => void) => {
    this.listeners.add(notify)
    return () => { this.listeners.delete(notify) }
  }
  register(action: SelectionAction): () => void {
    if (!action.id.trim() || this.actions.has(action.id)) throw new Error('Selection action already registered or missing an ID')
    this.actions.set(action.id, action)
    this.changed()
    return () => {
      if (this.actions.get(action.id) !== action) return
      this.actions.delete(action.id)
      this.changed()
    }
  }
  private changed(): void {
    this.snapshot = [...this.actions.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id))
    for (const notify of this.listeners) notify()
  }
}
