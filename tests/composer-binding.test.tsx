// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createComposerBinding, ReferenceSessionStore } from '../src/client/composer-binding.tsx'
import { ReferenceRail } from '../src/client/reference-rail.tsx'
import type { ReferenceSet } from '../src/domain/model.ts'
import { selectedTextHash } from '../src/protocol/index.ts'
import type { AnnotationCoreRemoteNamespace } from '../src/remote/client.ts'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()) })

function set(items = 2): ReferenceSet {
  return {
    schemaVersion: 1, setId: 'set-1', profileId: 'web', sessionId: 'session-1', state: 'pending', revision: items,
    createdAt: 1,
    items: Array.from({ length: items }, (_, index) => ({
      referenceId: `reference-${index + 1}`, number: index + 1, sourceType: 'dsh-message' as const,
      selectedText: `selected ${index + 1}`, userComment: index === 0 ? 'comment' : '', backlinkState: 'not-required' as const,
      locator: { profileId: 'web', sessionId: 'source', anchorId: `anchor-${index}`, role: 'user' as const, occurrence: 0, selectedTextHash: selectedTextHash(`selected ${index + 1}`) },
    })),
  }
}

function ok<T>(value: T) { return Promise.resolve({ ok: true as const, value }) }

function remote(initial: ReferenceSet | null = set()) {
  let revision = initial?.revision ?? 0
  let pending = initial
  let wake: (() => void) | undefined
  const calls = { annotated: vi.fn(), plain: vi.fn(), admission: vi.fn() }
  const value = {
    readPending: () => ok({ revision, pending }),
    waitRevision: async (_after: number, signal?: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        wake = resolve
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      return { ok: true as const, value: { revision, pending } }
    },
    submitAnnotated: calls.annotated.mockImplementation(async (request) => ({ ok: true as const, value: { kind: 'success' as const, clientSubmissionId: request.clientSubmissionId, userMessageId: 'user-1', setId: request.setId } })),
    submitPlainClaim: calls.plain.mockImplementation(async (request) => ({ ok: true as const, value: { kind: 'success' as const, clientSubmissionId: request.clientSubmissionId, userMessageId: 'user-plain' } })),
    readAdmission: calls.admission.mockImplementation(() => ok(null)),
  } as unknown as AnnotationCoreRemoteNamespace
  return {
    value, calls,
    publish(next: ReferenceSet | null) { pending = next; revision += 1; wake?.(); wake = undefined },
  }
}

describe('shared annotation composer binding', () => {
  it('renders the same accessible clean rail in default and narrow layouts', async () => {
    const fake = remote()
    const store = new ReferenceSessionStore(fake.value)
    await store.ready()
    for (const layout of ['default', 'narrow'] as const) {
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host); roots.push(root)
      await act(async () => root.render(<ReferenceRail layout={layout} store={store} open={() => undefined} remove={() => Promise.resolve()} />))
      expect(host.getAttribute('data-layout')).toBeNull()
      expect(host.querySelectorAll('[data-annotation-chip]')).toHaveLength(2)
      expect(host.textContent).toContain('selected 1')
      expect(host.textContent).not.toMatch(/@|<dsh-annotations|\u2063/)
      expect(host.querySelector('[aria-label="删除注释 1"]')).not.toBeNull()
    }
    store.dispose()
  })

  it('uses Host for annotated submit and retains the visible draft on every error', async () => {
    const fake = remote()
    const store = new ReferenceSessionStore(fake.value)
    await store.ready()
    const binding = createComposerBinding({ sessionId: 'session-1', layout: 'narrow', remote: fake.value, store })
    binding.setVisibleDraft('question')
    await binding.submit()
    expect(fake.calls.annotated).toHaveBeenCalledTimes(1)
    expect(binding.getSnapshot().visibleDraft).toBe('')

    binding.setVisibleDraft('retry')
    fake.calls.annotated.mockResolvedValueOnce({ ok: true, value: { kind: 'error', code: 'delivery', message: 'offline' } })
    await expect(binding.submit()).rejects.toThrow('offline')
    expect(binding.getSnapshot().visibleDraft).toBe('retry')
    expect(binding.getSnapshot()).toMatchObject({ commitState: 'failed', error: 'offline' })
    binding.dispose()
  })

  it('dynamically submits plain text after the final pending reference disappears', async () => {
    const fake = remote(set(1))
    const store = new ReferenceSessionStore(fake.value)
    await store.ready()
    const binding = createComposerBinding({ sessionId: 'session-1', layout: 'default', remote: fake.value, store })
    fake.publish(null)
    await vi.waitFor(() => expect(store.getSnapshot().pending).toBeNull())
    await expect(binding.submitClaim('ordinary', [])).resolves.toEqual({ kind: 'success' })
    expect(fake.calls.annotated).not.toHaveBeenCalled()
    expect(fake.calls.plain).toHaveBeenCalledTimes(1)
    await expect(binding.submitClaim('', [])).resolves.toMatchObject({ kind: 'error', text: '请输入正文' })
    binding.dispose()
  })

  it('never overwrites a newer sidechat draft when a plain send settles', async () => {
    let snapshot = { draft: 'old', revision: 1 }
    let settle!: (value: { kind: 'success'; submittedRevision: number }) => void
    const port = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      setDraft: (text: string) => { snapshot = { draft: text, revision: snapshot.revision + 1 } },
      submitPlain: () => new Promise<{ kind: 'success'; submittedRevision: number }>((resolve) => { settle = resolve }),
    }
    const fake = remote(null)
    const store = new ReferenceSessionStore(fake.value)
    await store.ready()
    const binding = createComposerBinding({ sessionId: 'session-1', layout: 'narrow', remote: fake.value, store, plainPort: port })
    const sending = binding.submit()
    snapshot = { draft: 'newer', revision: 2 }
    settle({ kind: 'success', submittedRevision: 1 })
    await sending
    expect(snapshot.draft).toBe('newer')
    expect(binding.getSnapshot().visibleDraft).toBe('newer')
    binding.dispose()
  })

  it('blocks unknown core state and aborts its long poll on dispose', async () => {
    const fake = remote()
    const store = new ReferenceSessionStore(fake.value)
    expect(store.getSnapshot().status).toBe('loading')
    const binding = createComposerBinding({ sessionId: 'session-1', layout: 'narrow', remote: fake.value, store })
    expect(binding.getSnapshot()).toMatchObject({ transport: 'blocked', fallbackPolicy: 'unknown' })
    store.dispose()
    binding.dispose()
  })
})
