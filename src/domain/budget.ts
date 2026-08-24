import type { ReferenceItem, ReferenceSet } from './model.ts'

export const FALLBACK_CONTEXT_WINDOW = 65_536
export const REFERENCE_BUDGET_RATIO = 0.2

export type SourceBudgetIssue =
  | 'over-budget'
  | 'source-changed'
  | 'source-missing'
  | 'adapter-unavailable'
  | 'protocol-mismatch'

export interface PreparedReferenceDocument {
  readonly key: string
  readonly vaultId: string
  readonly notePath: string
  readonly documentHash: string
  readonly markdown: string
  readonly referenceIds: readonly string[]
}

export interface SourceBudgetDetail {
  readonly referenceId: string
  readonly sourceType: ReferenceItem['sourceType']
  readonly estimatedTokens: number
  readonly totalEstimatedTokens: number
  readonly limit: number
  readonly overBy: number
  readonly issue: SourceBudgetIssue
  readonly notePath?: string
  readonly message?: string
}

export interface ReferenceBudgetOptions {
  readonly contextWindow?: number
  readonly countTokens?: (text: string) => number
}

export interface ReferenceBudgetResult {
  readonly contextWindow: number
  readonly estimatedTokens: number
  readonly limit: number
  readonly overBudget: boolean
  readonly documents: readonly PreparedReferenceDocument[]
  readonly details: readonly SourceBudgetDetail[]
}

interface MutableDocument {
  key: string
  vaultId: string
  notePath: string
  documentHash: string
  markdown: string
  referenceIds: string[]
}

function documentKey(item: Extract<ReferenceItem, { sourceType: 'obsidian-note' }>): string {
  return JSON.stringify([
    item.locator.vaultId,
    item.locator.notePath,
    item.snapshot.documentHash,
  ])
}

export function collectReferenceDocuments(set: ReferenceSet): readonly PreparedReferenceDocument[] {
  const documents = new Map<string, MutableDocument>()
  for (const item of set.items) {
    if (item.sourceType !== 'obsidian-note') continue
    const key = documentKey(item)
    const existing = documents.get(key)
    if (existing !== undefined) {
      existing.referenceIds.push(item.referenceId)
      continue
    }
    documents.set(key, {
      key,
      vaultId: item.locator.vaultId,
      notePath: item.locator.notePath,
      documentHash: item.snapshot.documentHash,
      markdown: item.snapshot.markdown,
      referenceIds: [item.referenceId],
    })
  }
  return [...documents.values()].map((document) => Object.freeze({
    ...document,
    referenceIds: Object.freeze([...document.referenceIds]),
  }))
}

export function estimateUtf8Tokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 3)
}

function contextWindow(options: ReferenceBudgetOptions): number {
  const value = options.contextWindow
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : FALLBACK_CONTEXT_WINDOW
}

function estimator(options: ReferenceBudgetOptions): (text: string) => number {
  if (options.countTokens === undefined) return estimateUtf8Tokens
  return (text) => {
    const tokens = options.countTokens?.(text)
    if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0) {
      throw new TypeError(`Token estimator must return a non-negative safe integer; received ${String(tokens)}`)
    }
    return tokens
  }
}

function itemText(item: ReferenceItem): string {
  return item.userComment.length === 0
    ? item.selectedText
    : `${item.selectedText}\n${item.userComment}`
}

export function calculateReferenceBudget(
  set: ReferenceSet,
  options: ReferenceBudgetOptions = {},
): ReferenceBudgetResult {
  const window = contextWindow(options)
  const limit = Math.floor(window * REFERENCE_BUDGET_RATIO)
  const count = estimator(options)
  const documents = collectReferenceDocuments(set)
  const documentOwner = new Map<string, string>()
  for (const document of documents) {
    const owner = document.referenceIds[0]
    if (owner !== undefined) documentOwner.set(document.key, owner)
  }

  const perItem = set.items.map((item) => {
    const parts = [itemText(item)]
    if (item.sourceType === 'obsidian-note') {
      const key = documentKey(item)
      if (documentOwner.get(key) === item.referenceId) {
        const document = documents.find((candidate) => candidate.key === key)
        if (document !== undefined) parts.push(document.markdown)
      }
    }
    return { item, text: parts.join('\n') }
  })
  const allMaterial = [
    ...set.items.map(itemText),
    ...documents.map((document) => document.markdown),
  ].join('\n')
  const perItemTokens = perItem.map(({ text }) => count(text))
  const estimatedTokens = count(allMaterial)
  const overBy = Math.max(0, estimatedTokens - limit)
  const details = perItem.map(({ item }, index): SourceBudgetDetail => ({
    referenceId: item.referenceId,
    sourceType: item.sourceType,
    estimatedTokens: perItemTokens[index] ?? 0,
    totalEstimatedTokens: estimatedTokens,
    limit,
    overBy,
    issue: 'over-budget',
    ...(item.sourceType === 'obsidian-note' ? { notePath: item.locator.notePath } : {}),
  }))
  return Object.freeze({
    contextWindow: window,
    estimatedTokens,
    limit,
    overBudget: estimatedTokens > limit,
    documents: Object.freeze([...documents]),
    details: Object.freeze(details),
  })
}
