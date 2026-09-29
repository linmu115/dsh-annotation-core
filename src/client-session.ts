import type { SessionId } from '@deepseek-ai/dsh-session/types'
/** DSH 0.2 selection belongs to mainView retention; the catalog has no current field. */
export interface MainSessionSnapshot {
  readonly byId?: Readonly<Record<string, { readonly retainedBy?: Readonly<Record<string, number>> } | undefined>>
}
export function currentMainSession(snapshot: MainSessionSnapshot): string | undefined {
  return Object.entries(snapshot.byId ?? {}).find(([, row]) => (row?.retainedBy?.mainView ?? 0) > 0)?.[0]
}
export interface MainSessionNavigation {
  readonly sessions: { readonly list: { getSnapshot(): MainSessionSnapshot; subscribe(listener: () => void): () => void } }
  readonly uiWorkspace: { openSession(id: SessionId): void }
}
/** Wait for the official asynchronous navigation to publish its selected owner. */
export async function openMainSession(ctx: MainSessionNavigation, id: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (currentMainSession(ctx.sessions.list.getSnapshot()) === id) return
  ctx.uiWorkspace.openSession(id as SessionId)
  if (currentMainSession(ctx.sessions.list.getSnapshot()) === id) return
  await new Promise<void>((resolve, reject) => {
    let off: (() => void) | undefined
    let done = false
    const finish = (error?: unknown) => { if (done) return; done = true; clearTimeout(timer); off?.(); signal?.removeEventListener('abort', abort); error === undefined ? resolve() : reject(error) }
    const abort = () => finish(signal?.reason ?? new Error('Navigation cancelled'))
    const sync = () => { if (currentMainSession(ctx.sessions.list.getSnapshot()) === id) finish() }
    const timer = setTimeout(() => finish(new Error('Target Session did not become the main view')), 15000)
    off = ctx.sessions.list.subscribe(sync)
    if (done) { off(); return }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort(); else sync()
  })
}
