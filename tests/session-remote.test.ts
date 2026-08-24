import { describe, expect, it } from 'vitest'

import { annotationRemoteForSession } from '../src/remote/client.ts'

describe('session-scoped annotation remote', () => {
  it('resolves the namespace from the requested Agent scope, not the root/current page', () => {
    const childRemote = { readPending: async () => ({ ok: true, value: { revision: 0, pending: null } }) }
    const childScope = { get: (name: string) => name === 'remote.annotationCore' ? childRemote : undefined }
    const ctx = {
      get: (name: string) => name === 'sessions'
        ? { scope: (sessionId: string) => sessionId === 'child' ? childScope : undefined }
        : name === 'remote.annotationCore' ? { root: true } : undefined,
    }
    expect(annotationRemoteForSession(ctx as never, 'child')).toBe(childRemote)
    expect(() => annotationRemoteForSession(ctx as never, 'missing')).toThrow(/scope/i)
  })
})
