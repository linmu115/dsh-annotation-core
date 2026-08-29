// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply as applyClient, inject } from '../src/client.tsx'

afterEach(() => document.body.replaceChildren())

describe('alpha.1 client service scope', () => {
  it('publishes annotationCore where a separately loaded consumer can inject it', async () => {
    const root = new Context()
    const disposeRemote = vi.fn(async () => undefined)
    root.provide('remote', { $mount: vi.fn(async () => disposeRemote) })
    root.provide('sessions', {
      list: { getSnapshot: () => ({ current: undefined }) },
      binding: () => undefined,
    })
    root.provide('conversation', { input: { for: () => ({ beginCommand: () => false }) } })
    root.provide('uiConversation', { events: { register: vi.fn(() => () => undefined) } })
    root.provide('slots', {
      inject: vi.fn((_name: string, register: () => unknown) => { register(); return () => undefined }),
      register: vi.fn(() => () => undefined),
    })

    const core = root.plugin({
      name: 'annotation-core-client-scope-test',
      inject: [...inject],
      apply: (ctx) => applyClient(ctx, { profileId: 'web' }),
    })
    await core

    let injected: unknown
    const consumer = root.plugin({
      name: 'annotation-core-client-consumer-test',
      inject: ['annotationCore'],
      apply(ctx) { injected = ctx.get('annotationCore') },
    })
    await consumer

    expect(injected).toMatchObject({ version: '0.3.2' })
    expect(document.querySelector('[data-dsh-annotation-dialog-host]')).not.toBeNull()

    await consumer.dispose()
    await core.dispose()
    expect(document.querySelector('[data-dsh-annotation-dialog-host]')).toBeNull()
    expect(disposeRemote).toHaveBeenCalledOnce()
  })
})
