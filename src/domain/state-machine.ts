import { canonicalJson, ReferenceSourceSchema } from '../protocol/index.ts'
import type { ReferenceSource } from '../protocol/index.ts'
import type {
  AddReferenceInput,
  CompleteReferenceCommitInput,
  CreateReferenceSetInput,
  ReferenceItem,
  ReferenceSet,
  ReferenceSetState,
  ReuseReferenceInput,
} from './model.ts'
import { REFERENCE_SET_SCHEMA_VERSION } from './model.ts'
import { renumberPendingItems } from './numbering.ts'

export class ReferenceRevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Reference revision conflict: expected ${expected}, received ${actual}`)
    this.name = 'ReferenceRevisionConflictError'
  }
}

export class ReferenceConflictError extends Error {
  constructor(readonly referenceId: string) {
    super(`Reference ${JSON.stringify(referenceId)} already exists with a different canonical source`)
    this.name = 'ReferenceConflictError'
  }
}

export class ReferenceStateError extends Error {
  constructor(readonly expected: ReferenceSetState | readonly ReferenceSetState[], readonly actual: ReferenceSetState) {
    const states = Array.isArray(expected) ? expected.join(' or ') : expected
    super(`Reference set must be ${states}; current state is ${actual}`)
    this.name = 'ReferenceStateError'
  }
}

function assertIdentifier(value: string, field: string): void {
  if (value.length === 0) throw new TypeError(`${field} must not be empty`)
}

function assertRevision(set: ReferenceSet, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || set.revision !== expectedRevision) {
    throw new ReferenceRevisionConflictError(expectedRevision, set.revision)
  }
}

function assertState(set: ReferenceSet, expected: ReferenceSetState | readonly ReferenceSetState[]): void {
  const accepted: readonly ReferenceSetState[] = Array.isArray(expected) ? expected : [expected]
  if (!accepted.includes(set.state)) throw new ReferenceStateError(expected, set.state)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

function sourceFromItem(item: ReferenceItem): ReferenceSource {
  if (item.sourceType === 'dsh-message') {
    return { sourceType: item.sourceType, selectedText: item.selectedText, locator: { ...item.locator } }
  }
  return {
    sourceType: item.sourceType,
    selectedText: item.selectedText,
    locator: { ...item.locator },
    snapshot: { ...item.snapshot },
  }
}

function itemFromSource(referenceId: string, source: ReferenceSource, number: number, userComment: string): ReferenceItem {
  if (source.sourceType === 'dsh-message') {
    return {
      referenceId,
      number,
      sourceType: source.sourceType,
      selectedText: source.selectedText,
      userComment,
      locator: { ...source.locator },
      backlinkState: 'not-required',
    }
  }
  return {
    referenceId,
    number,
    sourceType: source.sourceType,
    selectedText: source.selectedText,
    userComment,
    locator: { ...source.locator },
    snapshot: { ...source.snapshot },
    backlinkState: 'pending',
  }
}

function withRevision(set: ReferenceSet, update: Partial<ReferenceSet>): ReferenceSet {
  return deepFreeze({ ...set, ...update, revision: set.revision + 1 })
}

export function createPendingReferenceSet(input: CreateReferenceSetInput): ReferenceSet {
  assertIdentifier(input.setId, 'setId')
  assertIdentifier(input.profileId, 'profileId')
  assertIdentifier(input.sessionId, 'sessionId')
  if (!Number.isInteger(input.createdAt) || input.createdAt < 0) throw new TypeError('createdAt must be a non-negative integer')
  return deepFreeze({
    schemaVersion: REFERENCE_SET_SCHEMA_VERSION,
    setId: input.setId,
    profileId: input.profileId,
    sessionId: input.sessionId,
    state: 'pending',
    revision: 0,
    items: [],
    createdAt: input.createdAt,
  })
}

export interface AddReferenceResult {
  readonly disposition: 'added' | 'existing'
  readonly set: ReferenceSet
  readonly item: ReferenceItem
}

export function addReference(set: ReferenceSet, input: AddReferenceInput, expectedRevision: number): AddReferenceResult {
  assertState(set, 'pending')
  assertIdentifier(input.referenceId, 'referenceId')
  const source = ReferenceSourceSchema.parse(input.source)
  const existing = set.items.find((item) => item.referenceId === input.referenceId)
  if (existing !== undefined) {
    if (canonicalJson(sourceFromItem(existing)) !== canonicalJson(source)) {
      throw new ReferenceConflictError(input.referenceId)
    }
    return { disposition: 'existing', set, item: existing }
  }
  assertRevision(set, expectedRevision)
  const item = deepFreeze(itemFromSource(input.referenceId, source, set.items.length + 1, input.userComment ?? ''))
  const next = withRevision(set, { items: [...set.items, item] })
  return { disposition: 'added', set: next, item: next.items[next.items.length - 1] ?? item }
}

export function updateReferenceComment(
  set: ReferenceSet,
  referenceId: string,
  userComment: string,
  expectedRevision: number,
): ReferenceSet {
  assertState(set, 'pending')
  assertRevision(set, expectedRevision)
  const index = set.items.findIndex((item) => item.referenceId === referenceId)
  if (index < 0) throw new RangeError(`Unknown reference ${JSON.stringify(referenceId)}`)
  const items = [...set.items]
  items[index] = { ...(items[index] as ReferenceItem), userComment }
  return withRevision(set, { items })
}

export function removeReference(set: ReferenceSet, referenceId: string, expectedRevision: number): ReferenceSet {
  assertState(set, 'pending')
  assertRevision(set, expectedRevision)
  const index = set.items.findIndex((item) => item.referenceId === referenceId)
  if (index < 0) throw new RangeError(`Unknown reference ${JSON.stringify(referenceId)}`)
  const items = renumberPendingItems(set.items.filter((_, itemIndex) => itemIndex !== index))
  return withRevision(set, { items })
}

export function beginReferenceCommit(set: ReferenceSet, expectedRevision: number): ReferenceSet {
  assertState(set, 'pending')
  assertRevision(set, expectedRevision)
  if (set.items.length === 0) throw new RangeError('A reference commit requires at least one item')
  return withRevision(set, { state: 'committing' })
}

export function markReferenceCommitFailed(set: ReferenceSet, expectedRevision: number): ReferenceSet {
  assertState(set, 'committing')
  assertRevision(set, expectedRevision)
  return withRevision(set, { state: 'failed' })
}

export function restoreFailedReferenceCommit(set: ReferenceSet, expectedRevision: number): ReferenceSet {
  assertState(set, 'failed')
  assertRevision(set, expectedRevision)
  return withRevision(set, { state: 'pending' })
}

export function completeReferenceCommit(set: ReferenceSet, input: CompleteReferenceCommitInput): ReferenceSet {
  assertState(set, 'committing')
  assertRevision(set, input.expectedRevision)
  assertIdentifier(input.userMessageId, 'userMessageId')
  assertIdentifier(input.userAnchorId, 'userAnchorId')
  if (!Number.isInteger(input.committedAt) || input.committedAt < 0) throw new TypeError('committedAt must be a non-negative integer')
  return withRevision(set, {
    state: 'sent',
    committedAt: input.committedAt,
    userMessageId: input.userMessageId,
    userAnchorId: input.userAnchorId,
  })
}

export function reuseReference(sourceSet: ReferenceSet, sourceReferenceId: string, input: ReuseReferenceInput): ReferenceSet {
  assertState(sourceSet, 'sent')
  if (input.setId === sourceSet.setId || input.referenceId === sourceReferenceId) {
    throw new TypeError('Reused references require new setId and referenceId values')
  }
  const sourceItem = sourceSet.items.find((item) => item.referenceId === sourceReferenceId)
  if (sourceItem === undefined) throw new RangeError(`Unknown reference ${JSON.stringify(sourceReferenceId)}`)
  const empty = createPendingReferenceSet({
    setId: input.setId,
    profileId: sourceSet.profileId,
    sessionId: input.targetSessionId,
    createdAt: input.createdAt,
  })
  return addReference(empty, {
    referenceId: input.referenceId,
    source: sourceFromItem(sourceItem),
    userComment: sourceItem.userComment,
  }, 0).set
}
