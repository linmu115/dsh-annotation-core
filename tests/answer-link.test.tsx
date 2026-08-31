import { describe, expect, it, vi } from 'vitest'

import { parseAnnotationAnswerLink, resolveAnnotationAnswerLink, resolveAnnotationSessionTarget } from '../src/client/answer-link.ts'
import type { ReferenceSet } from '../src/domain/model.ts'
import { selectedTextHash } from '../src/protocol/index.ts'

function sentSet(): ReferenceSet {
  return {
    schemaVersion: 1,
    setId: 'set-with-dashes',
    profileId: 'web',
    sessionId: 'session-1',
    state: 'sent',
    revision: 3,
    createdAt: 1,
    committedAt: 2,
    userMessageId: 'user-1',
    userAnchorId: 'user-1',
    items: [{
      referenceId: 'reference-1',
      number: 1,
      sourceType: 'dsh-message',
      selectedText: 'selected',
      userComment: 'comment',
      backlinkState: 'not-required',
      locator: {
        profileId: 'web', sessionId: 'source', anchorId: 'anchor', role: 'user', occurrence: 0,
        selectedTextHash: selectedTextHash('selected'),
      },
    }],
  }
}

describe('annotation answer links', () => {
  it('resolves a stable logical target to the active projection and retains the legacy fallback', async () => {
    const resolver = vi.fn(async () => ({ sessionId: 'session-alpha2', anchorId: 'anchor-alpha2' }))
    await expect(resolveAnnotationSessionTarget({
      logicalSessionId: 'logical-session-1',
      logicalAnchorId: 'logical-anchor-1',
      sessionId: 'session-alpha1',
      anchorId: 'anchor-alpha1',
    }, resolver)).resolves.toEqual({ sessionId: 'session-alpha2', anchorId: 'anchor-alpha2' })
    expect(resolver).toHaveBeenCalledWith({
      logicalSessionId: 'logical-session-1',
      logicalAnchorId: 'logical-anchor-1',
      legacySessionId: 'session-alpha1',
      legacyAnchorId: 'anchor-alpha1',
    })
    await expect(resolveAnnotationSessionTarget({
      logicalSessionId: 'logical-session-1', sessionId: 'session-alpha1', anchorId: 'anchor-alpha1',
    }, async () => undefined)).resolves.toEqual({ sessionId: 'session-alpha1', anchorId: 'anchor-alpha1' })
  })
  it('parses the last numeric segment without truncating dashed set IDs', () => {
    expect(parseAnnotationAnswerLink('#dsh-annotation-set-with-dashes-12')).toEqual({ setId: 'set-with-dashes', number: 12 })
  })

  it('accepts a fragment only when both set ID and number exist in this session', () => {
    const set = sentSet()
    expect(resolveAnnotationAnswerLink('#dsh-annotation-set-with-dashes-1', [set])).toMatchObject({ set, referenceId: 'reference-1', number: 1 })
    expect(resolveAnnotationAnswerLink('#dsh-annotation-set-with-dashes-2', [set])).toBeUndefined()
    expect(resolveAnnotationAnswerLink('#dsh-annotation-another-1', [set])).toBeUndefined()
    expect(resolveAnnotationAnswerLink('https://example.invalid/#dsh-annotation-set-with-dashes-1', [set])).toBeUndefined()
  })

  it('rejects malformed, zero and invented fragments without side effects', () => {
    const effect = vi.fn()
    for (const href of ['#dsh-annotation-', '#dsh-annotation-set-0', '#dsh-annotation-set-x', '#other']) {
      if (resolveAnnotationAnswerLink(href, [sentSet()]) !== undefined) effect()
    }
    expect(effect).not.toHaveBeenCalled()
  })
})
