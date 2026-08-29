import { describe, expect, it, vi } from 'vitest'

import { AnnotationCoreClientService } from '../src/client/service.tsx'

const sentSet = {
  setId: 'set-1',
  state: 'sent',
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  items: [{
    referenceId: 'reference-1',
    number: 1,
    userComment: '',
    source: {
      sourceType: 'obsidian-note',
      selectedText: 'quoted text',
      locator: { notePath: 'note.md', blockId: 'block-1' },
    },
    createdAt: 1,
  }],
}

function fixture(set: typeof sentSet | undefined) {
  const open = vi.fn()
  const service = Object.create(AnnotationCoreClientService.prototype) as AnnotationCoreClientService
  Object.assign(service, {
    dialog: { open },
    remote: vi.fn(() => ({ readSentSet: vi.fn() })),
    prefetchSent: vi.fn(async () => set),
  })
  return { service, open }
}

describe('session-addressed annotation opening', () => {
  it('loads the sent set before opening a cold dialog', async () => {
    const { service, open } = fixture(sentSet)
    await expect(service.openAnnotationInSession('session-1', 'set-1', 'reference-1')).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith(sentSet, 'reference-1')
  })

  it('refuses a missing set or mismatched reference identity', async () => {
    const missing = fixture(undefined)
    await expect(missing.service.openAnnotationInSession('session-1', 'set-1')).resolves.toBe(false)
    expect(missing.open).not.toHaveBeenCalled()

    const mismatched = fixture(sentSet)
    await expect(mismatched.service.openAnnotationInSession('session-1', 'set-1', 'reference-other')).resolves.toBe(false)
    expect(mismatched.open).not.toHaveBeenCalled()
  })
})
