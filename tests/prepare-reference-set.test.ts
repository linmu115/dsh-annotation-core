import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import type { ReferenceItem, ReferenceSet } from '../src/domain/model.ts'
import { addReference, createPendingReferenceSet } from '../src/domain/state-machine.ts'
import {
  prepareReferenceSet,
} from '../src/host/prepare-reference-set.ts'
import {
  HostSourceRegistry,
  SourcePreparationError,
} from '../src/host/source-registry.ts'
import { documentHash, selectedTextHash } from '../src/protocol/index.ts'

function noteSet(input: {
  setId?: string
  referenceId?: string
  selectedText?: string
  markdown?: string
  notePath?: string
} = {}): ReferenceSet {
  const selectedText = input.selectedText ?? 'selected'
  const markdown = input.markdown ?? '# Note\n\nselected ^block'
  const empty = createPendingReferenceSet({
    setId: input.setId ?? 'set',
    profileId: 'web',
    sessionId: 'target',
    createdAt: 1,
  })
  return addReference(empty, {
    referenceId: input.referenceId ?? 'reference',
    source: {
      sourceType: 'obsidian-note',
      selectedText,
      locator: {
        vaultId: 'vault',
        notePath: input.notePath ?? 'note.md',
        blockId: 'block',
        occurrence: 0,
        selectedTextHash: selectedTextHash(selectedText),
      },
      snapshot: {
        markdown,
        documentHash: documentHash(markdown),
        capturedAt: 1,
        freshness: 'captured',
      },
    },
  }, 0).set
}

function registry(prepare: (item: ReferenceItem, signal: AbortSignal) => Promise<ReferenceItem>): HostSourceRegistry {
  const result = new HostSourceRegistry(new Context())
  result.registerSourceAdapter('obsidian-note', { prepare })
  return result
}

function refreshed(item: ReferenceItem, markdown: string): ReferenceItem {
  if (item.sourceType !== 'obsidian-note') throw new Error('expected note')
  return {
    ...item,
    snapshot: {
      markdown,
      documentHash: documentHash(markdown),
      capturedAt: 2,
      freshness: 'refreshed',
    },
  }
}

describe('prepareReferenceSet', () => {
  it('accepts an unchanged online source and refreshes a changed full note', async () => {
    const original = noteSet()
    const unchanged = await prepareReferenceSet(original, registry(async (item) => item), {
      budget: { contextWindow: 100_000, countTokens: () => 10 },
    })
    expect(unchanged.kind).toBe('ready')
    if (unchanged.kind !== 'ready') return
    expect(unchanged.set.items[0]).toEqual(original.items[0])

    const changed = await prepareReferenceSet(original, registry(async (item) => refreshed(item, '# Updated\n\nselected ^block')), {
      budget: { contextWindow: 100_000, countTokens: () => 10 },
    })
    expect(changed.kind).toBe('ready')
    if (changed.kind !== 'ready') return
    expect(changed.set.items[0]?.sourceType).toBe('obsidian-note')
    expect(changed.set.items[0]?.sourceType === 'obsidian-note' && changed.set.items[0].snapshot.freshness).toBe('refreshed')
  })

  it.each([
    ['source-missing', 'source-missing'],
    ['source-changed', 'source-changed'],
  ] as const)('blocks an online %s location failure', async (code, reason) => {
    const result = await prepareReferenceSet(noteSet(), registry(async () => {
      throw new SourcePreparationError(code, `fixture ${code}`)
    }), { budget: { contextWindow: 100_000, countTokens: () => 1 } })
    expect(result).toMatchObject({ kind: 'blocked', reason })
    if (result.kind === 'blocked') expect(result.details[0]?.issue).toBe(code)
  })

  it('uses the captured snapshot while offline', async () => {
    const original = noteSet()
    const result = await prepareReferenceSet(original, registry(async () => {
      throw new SourcePreparationError('offline', 'bridge offline')
    }), { budget: { contextWindow: 100_000, countTokens: () => 1 } })
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') return
    const item = result.set.items[0]
    expect(item?.sourceType === 'obsidian-note' && item.snapshot.freshness).toBe('offline')
    expect(item?.sourceType === 'obsidian-note' && item.snapshot.markdown).toBe(
      original.items[0]?.sourceType === 'obsidian-note' ? original.items[0].snapshot.markdown : undefined,
    )
  })

  it('requires confirmation after an online refresh failure and supports explicit saved-snapshot retry', async () => {
    const adapter = registry(async () => {
      throw new SourcePreparationError('online-refresh-failed', 'timeout')
    })
    const first = await prepareReferenceSet(noteSet(), adapter, {
      budget: { contextWindow: 100_000, countTokens: () => 1 },
    })
    expect(first).toEqual({
      kind: 'needs-confirmation',
      reason: 'online-refresh-failed',
      referenceIds: ['reference'],
    })

    const confirmed = await prepareReferenceSet(noteSet(), adapter, {
      useSavedSnapshotFor: new Set(['reference']),
      budget: { contextWindow: 100_000, countTokens: () => 1 },
    })
    expect(confirmed.kind).toBe('ready')
    if (confirmed.kind === 'ready') {
      const item = confirmed.set.items[0]
      expect(item?.sourceType === 'obsidian-note' && item.snapshot.freshness).toBe('offline')
    }
  })

  it('deduplicates the same note revision but keeps two distinct revisions', async () => {
    let same = noteSet({ referenceId: 'first' })
    const source = same.items[0]
    if (source?.sourceType !== 'obsidian-note') throw new Error('expected note')
    same = addReference(same, {
      referenceId: 'second',
      source: {
        sourceType: source.sourceType,
        selectedText: source.selectedText,
        locator: { ...source.locator, blockId: 'other-block' },
        snapshot: source.snapshot,
      },
    }, same.revision).set
    const sameResult = await prepareReferenceSet(same, registry(async (item) => item), {
      budget: { contextWindow: 100_000, countTokens: () => 1 },
    })
    expect(sameResult.kind === 'ready' && sameResult.documents).toHaveLength(1)

    let revisions = noteSet({ referenceId: 'old', markdown: 'old document' })
    const old = revisions.items[0]
    if (old?.sourceType !== 'obsidian-note') throw new Error('expected note')
    revisions = addReference(revisions, {
      referenceId: 'new',
      source: {
        sourceType: 'obsidian-note',
        selectedText: old.selectedText,
        locator: { ...old.locator, blockId: 'new-block' },
        snapshot: {
          markdown: 'new document',
          documentHash: documentHash('new document'),
          capturedAt: 2,
          freshness: 'captured',
        },
      },
    }, revisions.revision).set
    const revisionResult = await prepareReferenceSet(revisions, registry(async (item) => item), {
      budget: { contextWindow: 100_000, countTokens: () => 1 },
    })
    expect(revisionResult.kind === 'ready' && revisionResult.documents).toHaveLength(2)
  })

  it('blocks unknown adapters and an over-budget set without truncating', async () => {
    const unknown = await prepareReferenceSet(noteSet(), new HostSourceRegistry(new Context()), {
      budget: { contextWindow: 100_000, countTokens: () => 1 },
    })
    expect(unknown).toMatchObject({ kind: 'blocked', reason: 'source-missing' })

    const over = await prepareReferenceSet(noteSet(), registry(async (item) => item), {
      budget: { contextWindow: 5, countTokens: (text) => text.length },
    })
    expect(over).toMatchObject({ kind: 'blocked', reason: 'over-budget' })
  })

  it('blocks a source adapter that rewrites user-authored annotation identity', async () => {
    const result = await prepareReferenceSet(noteSet(), registry(async (item) => ({
      ...item,
      userComment: 'adapter must not write this',
    })), { budget: { contextWindow: 100_000, countTokens: () => 1 } })
    expect(result).toMatchObject({ kind: 'blocked', reason: 'source-changed' })
    if (result.kind === 'blocked') expect(result.details[0]?.issue).toBe('protocol-mismatch')
  })
})
