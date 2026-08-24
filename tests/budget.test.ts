import { describe, expect, it } from 'vitest'

import * as budgetModule from '../src/domain/budget.ts'
import {
  calculateReferenceBudget,
  collectReferenceDocuments,
  estimateUtf8Tokens,
  FALLBACK_CONTEXT_WINDOW,
} from '../src/domain/budget.ts'
import { addReference, createPendingReferenceSet } from '../src/domain/state-machine.ts'
import type { ReferenceSet } from '../src/domain/model.ts'
import { documentHash, selectedTextHash } from '../src/protocol/index.ts'

function dshSet(text: string, comment = ''): ReferenceSet {
  const empty = createPendingReferenceSet({ setId: 'set', profileId: 'web', sessionId: 'target', createdAt: 1 })
  return addReference(empty, {
    referenceId: 'dsh-reference',
    userComment: comment,
    source: {
      sourceType: 'dsh-message',
      selectedText: text,
      locator: {
        profileId: 'web',
        sessionId: 'source',
        anchorId: 'anchor',
        role: 'user',
        occurrence: 0,
        selectedTextHash: selectedTextHash(text),
      },
    },
  }, 0).set
}

function addNote(set: ReferenceSet, input: {
  referenceId: string
  selectedText: string
  markdown: string
  notePath?: string
  comment?: string
}): ReferenceSet {
  return addReference(set, {
    referenceId: input.referenceId,
    userComment: input.comment ?? '',
    source: {
      sourceType: 'obsidian-note',
      selectedText: input.selectedText,
      locator: {
        vaultId: 'vault',
        notePath: input.notePath ?? 'note.md',
        blockId: `block-${input.referenceId}`,
        occurrence: 0,
        selectedTextHash: selectedTextHash(input.selectedText),
      },
      snapshot: {
        markdown: input.markdown,
        documentHash: documentHash(input.markdown),
        capturedAt: 1,
        freshness: 'captured',
      },
    },
  }, set.revision).set
}

describe('reference context budget', () => {
  it('uses known model metadata and tokenizer at the exact 20% boundary', () => {
    const exact = calculateReferenceBudget(dshSet('x'.repeat(20)), {
      contextWindow: 100,
      countTokens: (text) => text.length,
    })
    expect(exact).toMatchObject({ estimatedTokens: 20, limit: 20, overBudget: false, contextWindow: 100 })

    const over = calculateReferenceBudget(dshSet('x'.repeat(21)), {
      contextWindow: 100,
      countTokens: (text) => text.length,
    })
    expect(over).toMatchObject({ estimatedTokens: 21, limit: 20, overBudget: true })
  })

  it('falls back to a 65,536 window and a UTF-8 byte estimate', () => {
    expect(FALLBACK_CONTEXT_WINDOW).toBe(65_536)
    expect(estimateUtf8Tokens('你a')).toBe(2)
    const result = calculateReferenceBudget(dshSet('你a'))
    expect(result.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(result.limit).toBe(Math.floor(FALLBACK_CONTEXT_WINDOW * 0.2))
    expect(result.estimatedTokens).toBe(2)
  })

  it('counts selected text, comments, and each deduplicated full document', () => {
    let set = dshSet('question', 'address this')
    set = addNote(set, { referenceId: 'note-1', selectedText: 'alpha', markdown: 'full note', comment: 'why' })
    set = addNote(set, { referenceId: 'note-2', selectedText: 'beta', markdown: 'full note' })
    const seen: string[] = []
    const result = calculateReferenceBudget(set, {
      contextWindow: 10_000,
      countTokens(text) {
        seen.push(text)
        return text.length
      },
    })

    expect(collectReferenceDocuments(set)).toHaveLength(1)
    expect(result.documents).toHaveLength(1)
    expect(result.documents[0]?.referenceIds).toEqual(['note-1', 'note-2'])
    expect(seen.at(-1)).toContain('question')
    expect(seen.at(-1)).toContain('address this')
    expect(seen.at(-1)).toContain('alpha')
    expect(seen.at(-1)).toContain('beta')
    expect(seen.at(-1)?.match(/full note/g)).toHaveLength(1)
  })

  it('keeps distinct captured revisions of the same note and reports per-source overage', () => {
    let set = dshSet('root')
    set = addNote(set, { referenceId: 'old', selectedText: 'old selection', markdown: 'old document' })
    set = addNote(set, { referenceId: 'new', selectedText: 'new selection', markdown: 'new document' })
    const result = calculateReferenceBudget(set, {
      contextWindow: 20,
      countTokens: (text) => text.length,
    })

    expect(result.documents).toHaveLength(2)
    expect(result.overBudget).toBe(true)
    expect(result.details.map((detail) => detail.referenceId)).toEqual(['dsh-reference', 'old', 'new'])
    expect(result.details.every((detail) => detail.limit === 4 && detail.totalEstimatedTokens === result.estimatedTokens)).toBe(true)
  })

  it('does not export a truncation escape hatch', () => {
    expect(Object.keys(budgetModule).some((key) => key.toLowerCase().includes('truncat'))).toBe(false)
  })
})
