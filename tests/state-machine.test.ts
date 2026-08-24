import { describe, expect, it } from 'vitest'

import { documentHash, selectedTextHash } from '../src/protocol/index.ts'
import {
  ReferenceConflictError,
  ReferenceRevisionConflictError,
  addReference,
  beginReferenceCommit,
  completeReferenceCommit,
  createPendingReferenceSet,
  markReferenceCommitFailed,
  removeReference,
  restoreFailedReferenceCommit,
  reuseReference,
} from '../src/domain/state-machine.ts'

function dshSource(text: string, anchorId: string) {
  return {
    sourceType: 'dsh-message' as const,
    selectedText: text,
    locator: {
      profileId: 'web',
      sessionId: 'source-session',
      anchorId,
      role: 'assistant' as const,
      occurrence: 0,
      selectedTextHash: selectedTextHash(text),
    },
  }
}

function obsidianSource(text: string, notePath: string) {
  const markdown = `# Note\n\n${text}`
  return {
    sourceType: 'obsidian-note' as const,
    selectedText: text,
    locator: {
      vaultId: 'vault-main',
      notePath,
      blockId: 'dsh-note-1',
      occurrence: 0,
      selectedTextHash: selectedTextHash(text),
    },
    snapshot: {
      markdown,
      documentHash: documentHash(markdown),
      capturedAt: 100,
      freshness: 'captured' as const,
    },
  }
}

describe('reference set state machine', () => {
  it('moves pending to committing to sent with sequential CAS revisions', () => {
    const empty = createPendingReferenceSet({
      setId: 'set-1', profileId: 'web', sessionId: 'target-session', createdAt: 100,
    })
    const added = addReference(empty, {
      referenceId: 'reference-1', source: dshSource('first', 'anchor-1'), userComment: 'Use this.',
    }, 0).set
    expect(added.revision).toBe(1)
    expect(() => beginReferenceCommit(added, 0)).toThrow(ReferenceRevisionConflictError)

    const committing = beginReferenceCommit(added, 1)
    expect(committing).toMatchObject({ state: 'committing', revision: 2 })
    const sent = completeReferenceCommit(committing, {
      expectedRevision: 2,
      committedAt: 200,
      userMessageId: 'user-message-1',
      userAnchorId: 'user-node-1',
      userTextHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    })
    expect(sent).toMatchObject({ state: 'sent', revision: 3, committedAt: 200 })
  })

  it('restores a failed commit to pending without losing references', () => {
    const base = addReference(createPendingReferenceSet({
      setId: 'set-2', profileId: 'web', sessionId: 'target-session', createdAt: 100,
    }), { referenceId: 'reference-1', source: dshSource('first', 'anchor-1') }, 0).set
    const committing = beginReferenceCommit(base, 1)
    const failed = markReferenceCommitFailed(committing, 2)
    expect(failed).toMatchObject({ state: 'failed', revision: 3 })
    const restored = restoreFailedReferenceCommit(failed, 3)
    expect(restored.state).toBe('pending')
    expect(restored.items.map((item) => item.referenceId)).toEqual(['reference-1'])
    expect(restored.revision).toBe(4)
  })

  it('renumbers pending items after deletion but freezes sent numbers', () => {
    let set = createPendingReferenceSet({
      setId: 'set-3', profileId: 'web', sessionId: 'target-session', createdAt: 100,
    })
    for (const [index, text] of ['first', 'second', 'third'].entries()) {
      set = addReference(set, {
        referenceId: `reference-${index + 1}`,
        source: index === 1 ? obsidianSource(text, 'notes/mixed.md') : dshSource(text, `anchor-${index + 1}`),
      }, set.revision).set
    }
    expect(set.items.map((item) => item.sourceType)).toEqual(['dsh-message', 'obsidian-note', 'dsh-message'])
    expect(set.items.map((item) => item.number)).toEqual([1, 2, 3])
    set = removeReference(set, 'reference-2', 3)
    expect(set.items.map((item) => [item.referenceId, item.number])).toEqual([
      ['reference-1', 1], ['reference-3', 2],
    ])

    const sent = completeReferenceCommit(beginReferenceCommit(set, 4), {
      expectedRevision: 5,
      committedAt: 200,
      userMessageId: 'user-message-3',
      userAnchorId: 'user-node-3',
      userTextHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    })
    expect(() => removeReference(sent, 'reference-1', 6)).toThrow(/pending/)
    expect(sent.items.map((item) => item.number)).toEqual([1, 2])
  })

  it('treats the same reference ID and canonical source as idempotent but rejects conflicts', () => {
    const empty = createPendingReferenceSet({
      setId: 'set-4', profileId: 'web', sessionId: 'target-session', createdAt: 100,
    })
    const first = addReference(empty, {
      referenceId: 'reference-1', source: dshSource('same', 'anchor-1'),
    }, 0)
    const duplicate = addReference(first.set, {
      referenceId: 'reference-1', source: dshSource('same', 'anchor-1'),
    }, 1)
    expect(duplicate.disposition).toBe('existing')
    expect(duplicate.set).toBe(first.set)
    expect(duplicate.item).toBe(first.item)

    expect(() => addReference(first.set, {
      referenceId: 'reference-1', source: dshSource('different', 'anchor-1'),
    }, 1)).toThrow(ReferenceConflictError)
  })

  it('reuses a sent item with new IDs without mutating history', () => {
    const pending = addReference(createPendingReferenceSet({
      setId: 'set-history', profileId: 'web', sessionId: 'old-session', createdAt: 100,
    }), { referenceId: 'reference-history', source: dshSource('history', 'anchor-history') }, 0).set
    const sent = completeReferenceCommit(beginReferenceCommit(pending, 1), {
      expectedRevision: 2,
      committedAt: 200,
      userMessageId: 'user-message-history',
      userAnchorId: 'user-node-history',
      userTextHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    })
    const historicalSnapshot = JSON.stringify(sent)

    const reused = reuseReference(sent, 'reference-history', {
      setId: 'set-new',
      referenceId: 'reference-new',
      targetSessionId: 'new-session',
      createdAt: 300,
    })
    expect(reused).toMatchObject({ setId: 'set-new', sessionId: 'new-session', state: 'pending', revision: 1 })
    expect(reused.items[0]).toMatchObject({ referenceId: 'reference-new', number: 1 })
    expect(JSON.stringify(sent)).toBe(historicalSnapshot)
  })
})
