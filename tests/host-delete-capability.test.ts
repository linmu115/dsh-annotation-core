import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { HostSourceRegistry } from '../src/host/source-registry.ts'

describe('annotation core host deletion capability', () => {
  it('delegates a cross-app reference deletion to the configured Core mutation', async () => {
    const deleteReferenceLink = vi.fn(async () => ({ deleted: true, scope: 'sent' as const }))
    const registry = new HostSourceRegistry(new Context(), { deleteReferenceLink })

    await expect(registry.deleteReferenceLink('session-1', 'set-1', 'reference-1'))
      .resolves.toEqual({ deleted: true, scope: 'sent' })
    expect(deleteReferenceLink).toHaveBeenCalledWith('session-1', 'set-1', 'reference-1')
  })
})
