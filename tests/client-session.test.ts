import { describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { currentMainSession, openMainSession, type MainSessionNavigation } from '../src/client-session.ts'

// Compile against the installed 0.2 SDK, with no fabricated current/open members.
const acceptsActualSdk = (sessions: ISessions, uiWorkspace: Context['uiWorkspace']): MainSessionNavigation => ({ sessions, uiWorkspace })
void acceptsActualSdk

describe('official 0.2 main-view ownership', () => {
  it('ignores background bindings, absent rows, and the removed current field', () => {
    const state = { current: 'obsolete', byId: { background: { retainedBy: { plugin: 1 } }, absent: undefined, selected: { retainedBy: { mainView: 1 } } } }
    expect(currentMainSession(state)).toBe('selected')
    expect(currentMainSession({ byId: { background: { retainedBy: { mainView: 0 } } } })).toBeUndefined()
  })
  it('waits for published mainView retention and removes its observer', async () => {
    let state = { byId: { target: { retainedBy: { mainView: 0 } } } }
    const listeners = new Set<() => void>()
    const ctx = { sessions: { list: { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } } }, uiWorkspace: { openSession: vi.fn() } }
    let complete = false
    const task = openMainSession(ctx, 'target').then(() => { complete = true })
    await Promise.resolve()
    expect(complete).toBe(false)
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledWith('target')
    state = { byId: { target: { retainedBy: { mainView: 1 } } } }
    for (const fn of listeners) fn()
    await task
    expect(listeners.size).toBe(0)
    await openMainSession(ctx, 'target')
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledTimes(1)
  })
  it('cancels a pending navigation without retaining its subscription', async () => {
    const listeners = new Set<() => void>(), controller = new AbortController()
    const ctx = { sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } } }, uiWorkspace: { openSession: vi.fn() } }
    const task = openMainSession(ctx, 'target', controller.signal)
    controller.abort(new Error('owner disposed'))
    await expect(task).rejects.toThrow('owner disposed')
    expect(listeners.size).toBe(0)
  })
})
