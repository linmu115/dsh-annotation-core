import {
  calculateReferenceBudget,
} from '../domain/budget.ts'
import type {
  PreparedReferenceDocument,
  ReferenceBudgetOptions,
  SourceBudgetDetail,
  SourceBudgetIssue,
} from '../domain/budget.ts'
import type { ObsidianNoteReferenceItem, ReferenceItem, ReferenceSet } from '../domain/model.ts'
import { documentHash, selectedTextHash } from '../protocol/index.ts'
import { ReferenceItemSchema } from './store.ts'
import type { HostSourceRegistry } from './source-registry.ts'
import { SourcePreparationError } from './source-registry.ts'

export type PrepareResult =
  | {
    readonly kind: 'ready'
    readonly set: ReferenceSet
    readonly estimatedTokens: number
    readonly limit: number
    readonly documents: readonly PreparedReferenceDocument[]
  }
  | {
    readonly kind: 'needs-confirmation'
    readonly reason: 'online-refresh-failed'
    readonly referenceIds: readonly string[]
  }
  | {
    readonly kind: 'blocked'
    readonly reason: 'source-changed' | 'source-missing' | 'over-budget'
    readonly details: readonly SourceBudgetDetail[]
  }

export interface PrepareReferenceSetOptions {
  readonly budget?: ReferenceBudgetOptions
  readonly useSavedSnapshotFor?: ReadonlySet<string>
  readonly signal?: AbortSignal
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function offlineSnapshot(item: ObsidianNoteReferenceItem): ObsidianNoteReferenceItem {
  return {
    ...clone(item),
    snapshot: { ...clone(item.snapshot), freshness: 'offline' },
  }
}

function sameLocator(left: ObsidianNoteReferenceItem, right: ObsidianNoteReferenceItem): boolean {
  return left.locator.vaultId === right.locator.vaultId &&
    left.locator.notePath === right.locator.notePath &&
    left.locator.blockId === right.locator.blockId &&
    left.locator.heading === right.locator.heading &&
    left.locator.occurrence === right.locator.occurrence &&
    left.locator.selectedTextHash === right.locator.selectedTextHash
}

function validatePrepared(original: ObsidianNoteReferenceItem, prepared: ReferenceItem): ObsidianNoteReferenceItem {
  let parsed: ReferenceItem
  try {
    parsed = ReferenceItemSchema.parse(prepared)
  } catch (error) {
    throw new SourcePreparationError('protocol-mismatch', 'Source adapter returned an invalid reference record', { cause: error })
  }
  if (
    parsed.sourceType !== 'obsidian-note' ||
    parsed.referenceId !== original.referenceId ||
    parsed.number !== original.number ||
    parsed.selectedText !== original.selectedText ||
    parsed.userComment !== original.userComment ||
    parsed.backlinkState !== original.backlinkState ||
    selectedTextHash(parsed.selectedText) !== parsed.locator.selectedTextHash ||
    !sameLocator(original, parsed) ||
    documentHash(parsed.snapshot.markdown) !== parsed.snapshot.documentHash
  ) {
    throw new SourcePreparationError('protocol-mismatch', 'Source adapter returned an incompatible reference identity')
  }
  return clone(parsed)
}

function blockedDetail(
  item: ReferenceItem,
  issue: SourceBudgetIssue,
  message: string,
  totalEstimatedTokens: number,
  limit: number,
): SourceBudgetDetail {
  return {
    referenceId: item.referenceId,
    sourceType: item.sourceType,
    estimatedTokens: 0,
    totalEstimatedTokens,
    limit,
    overBy: Math.max(0, totalEstimatedTokens - limit),
    issue,
    ...(item.sourceType === 'obsidian-note' ? { notePath: item.locator.notePath } : {}),
    message,
  }
}

function failureIssue(error: SourcePreparationError): SourceBudgetIssue {
  switch (error.code) {
    case 'source-missing': return 'source-missing'
    case 'source-changed': return 'source-changed'
    case 'protocol-mismatch': return 'protocol-mismatch'
    case 'offline':
    case 'online-refresh-failed': return 'source-missing'
  }
}

export async function prepareReferenceSet(
  set: ReferenceSet,
  registry: HostSourceRegistry,
  options: PrepareReferenceSetOptions = {},
): Promise<PrepareResult> {
  const signal = options.signal ?? new AbortController().signal
  if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
  const baselineBudget = calculateReferenceBudget(set, options.budget)
  const preparedItems: ReferenceItem[] = []
  const confirmation: string[] = []
  const missing: SourceBudgetDetail[] = []
  const changed: SourceBudgetDetail[] = []

  for (const item of set.items) {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    if (item.sourceType === 'dsh-message') {
      preparedItems.push(clone(item))
      continue
    }
    if (options.useSavedSnapshotFor?.has(item.referenceId)) {
      preparedItems.push(offlineSnapshot(item))
      continue
    }
    const adapter = registry.get(item.sourceType)
    if (adapter === undefined) {
      missing.push(blockedDetail(
        item,
        'adapter-unavailable',
        'No Host source adapter is registered',
        baselineBudget.estimatedTokens,
        baselineBudget.limit,
      ))
      continue
    }
    try {
      const prepared = await adapter.prepare(clone(item), signal)
      preparedItems.push(validatePrepared(item, prepared))
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      const failure = error instanceof SourcePreparationError
        ? error
        : new SourcePreparationError('online-refresh-failed', error instanceof Error ? error.message : String(error), { cause: error })
      if (failure.code === 'offline') {
        preparedItems.push(offlineSnapshot(item))
      } else if (failure.code === 'online-refresh-failed') {
        confirmation.push(item.referenceId)
      } else {
        const target = failure.code === 'source-missing' ? missing : changed
        target.push(blockedDetail(
          item,
          failureIssue(failure),
          failure.message,
          baselineBudget.estimatedTokens,
          baselineBudget.limit,
        ))
      }
    }
  }

  if (changed.length > 0) {
    return { kind: 'blocked', reason: 'source-changed', details: Object.freeze([...changed, ...missing]) }
  }
  if (missing.length > 0) return { kind: 'blocked', reason: 'source-missing', details: Object.freeze(missing) }
  if (confirmation.length > 0) {
    return {
      kind: 'needs-confirmation',
      reason: 'online-refresh-failed',
      referenceIds: Object.freeze(confirmation),
    }
  }

  const prepared: ReferenceSet = Object.freeze({
    ...clone(set),
    items: Object.freeze(preparedItems),
  })
  const budget = calculateReferenceBudget(prepared, options.budget)
  if (budget.overBudget) {
    return { kind: 'blocked', reason: 'over-budget', details: budget.details }
  }
  return {
    kind: 'ready',
    set: prepared,
    estimatedTokens: budget.estimatedTokens,
    limit: budget.limit,
    documents: budget.documents,
  }
}
