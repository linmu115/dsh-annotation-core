import { describe, expect, it } from 'vitest'
import { ASSISTANT_KIND, USER_KINDS, isEligibleSelection, roleForMessageKind } from '../src/client/selection-capture.ts'
describe('rc.2 selection contract', () => {
  const valid = {
    blank: false,
    sameMessage: true,
    kind: ASSISTANT_KIND,
    streaming: false,
    excluded: false,
    hasSession: true,
    hasAnchor: true,
  }

  it('supports both user and assistant message DOM kinds', () => {
    expect(ASSISTANT_KIND).toBe('assistant-step')
    expect(USER_KINDS).toEqual(new Set(['user', 'steering']))
    expect(roleForMessageKind('assistant-step')).toBe('assistant')
    expect(roleForMessageKind('user')).toBe('user')
    expect(roleForMessageKind('steering')).toBe('user')
    expect(isEligibleSelection(valid)).toBe(true)
    expect(isEligibleSelection({ ...valid, kind: 'user' })).toBe(true)
    expect(isEligibleSelection({ ...valid, kind: 'steering' })).toBe(true)
  })

  it('requires a real source anchor and rejects unsafe selections', () => {
    expect(isEligibleSelection({ ...valid, hasAnchor: false })).toBe(false)
    expect(isEligibleSelection({ ...valid, sameMessage: false })).toBe(false)
    expect(isEligibleSelection({ ...valid, blank: true })).toBe(false)
    expect(isEligibleSelection({ ...valid, kind: 'assistant' })).toBe(false)
    expect(isEligibleSelection({ ...valid, streaming: true })).toBe(false)
    expect(isEligibleSelection({ ...valid, excluded: true })).toBe(false)
    expect(isEligibleSelection({ ...valid, hasSession: false })).toBe(false)
  })
})
