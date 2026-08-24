import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import {
  addReference as addReferenceToSet,
  beginReferenceCommit,
  completeReferenceCommit,
  createPendingReferenceSet,
  markReferenceCommitFailed,
  removeReference as removeReferenceFromSet,
  restoreFailedReferenceCommit,
  updateReferenceComment,
} from '../domain/state-machine.ts'
import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'
import {
  BacklinkReceiptV2Schema,
  canonicalSha256,
  DshMessageLocatorSchema,
  ObsidianNoteLocatorSchema,
  ReferenceSourceSchema,
  Sha256DigestSchema,
  SourceSnapshotSchema,
} from '../protocol/index.ts'
import type { BacklinkReceiptV2, ReferenceSource } from '../protocol/index.ts'

const NonEmptyStringSchema = z.string().min(1)
const NonNegativeIntegerSchema = z.number().int().nonnegative()

const DshReferenceItemSchema = z.object({
  referenceId: NonEmptyStringSchema,
  number: z.number().int().positive(),
  selectedText: NonEmptyStringSchema,
  userComment: z.string(),
  backlinkState: z.literal('not-required'),
  sourceType: z.literal('dsh-message'),
  locator: DshMessageLocatorSchema,
}).strict()

const ObsidianReferenceItemSchema = z.object({
  referenceId: NonEmptyStringSchema,
  number: z.number().int().positive(),
  selectedText: NonEmptyStringSchema,
  userComment: z.string(),
  backlinkState: z.enum(['pending', 'written', 'failed']),
  sourceType: z.literal('obsidian-note'),
  locator: ObsidianNoteLocatorSchema,
  snapshot: SourceSnapshotSchema,
}).strict()

export const ReferenceItemSchema = z.discriminatedUnion('sourceType', [
  DshReferenceItemSchema,
  ObsidianReferenceItemSchema,
])

export const ReferenceSetSchema = z.object({
  schemaVersion: z.literal(1),
  setId: NonEmptyStringSchema,
  profileId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  state: z.enum(['pending', 'committing', 'sent', 'failed']),
  revision: NonNegativeIntegerSchema,
  items: z.array(ReferenceItemSchema),
  createdAt: NonNegativeIntegerSchema,
  committedAt: NonNegativeIntegerSchema.optional(),
  userMessageId: NonEmptyStringSchema.optional(),
  userAnchorId: NonEmptyStringSchema.optional(),
}).strict()

export type ReferenceOperationState = 'canceled' | 'committed' | 'failed'

export interface ReferenceOperationRecord {
  readonly operationId: string
  readonly state: ReferenceOperationState
  readonly fenceRevision: number
  readonly referenceId?: string | undefined
  readonly setId?: string | undefined
  readonly sourceDigest?: string | undefined
  readonly createdReference?: boolean | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

const ReferenceOperationRecordSchema = z.object({
  operationId: NonEmptyStringSchema,
  state: z.enum(['canceled', 'committed', 'failed']),
  fenceRevision: NonNegativeIntegerSchema,
  referenceId: NonEmptyStringSchema.optional(),
  setId: NonEmptyStringSchema.optional(),
  sourceDigest: Sha256DigestSchema.optional(),
  createdReference: z.boolean().optional(),
  createdAt: NonNegativeIntegerSchema,
  updatedAt: NonNegativeIntegerSchema,
}).strict()

export type AdmissionState = 'prepared' | 'enqueued' | 'durable' | 'failed'
export type AdmissionKind = 'annotated' | 'plain'

export interface AdmissionRecord {
  readonly clientSubmissionId: string
  readonly requestDigest: string
  readonly kind: AdmissionKind
  readonly state: AdmissionState
  readonly setId?: string | undefined
  readonly referenceRevision?: number | undefined
  readonly userMessageId?: string | undefined
  readonly lastError?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

const AdmissionRecordSchema = z.object({
  clientSubmissionId: NonEmptyStringSchema,
  requestDigest: Sha256DigestSchema,
  kind: z.enum(['annotated', 'plain']),
  state: z.enum(['prepared', 'enqueued', 'durable', 'failed']),
  setId: NonEmptyStringSchema.optional(),
  referenceRevision: NonNegativeIntegerSchema.optional(),
  userMessageId: NonEmptyStringSchema.optional(),
  lastError: z.string().optional(),
  createdAt: NonNegativeIntegerSchema,
  updatedAt: NonNegativeIntegerSchema,
}).strict()

export interface SubmissionJournalEntry {
  readonly userMessageId: string
  readonly clientSubmissionId: string
  readonly requestDigest: string
  readonly setId?: string | undefined
  readonly contextMessageId?: string | undefined
  readonly createdAt: number
}

const SubmissionJournalEntrySchema = z.object({
  userMessageId: NonEmptyStringSchema,
  clientSubmissionId: NonEmptyStringSchema,
  requestDigest: Sha256DigestSchema,
  setId: NonEmptyStringSchema.optional(),
  contextMessageId: NonEmptyStringSchema.optional(),
  createdAt: NonNegativeIntegerSchema,
}).strict()

export interface FlushReconciliationRecord {
  readonly userMessageId: string
  readonly userObserved: boolean
  readonly contextObserved: boolean
  readonly flushState: 'pending' | 'durable' | 'failed'
  readonly lastError?: string | undefined
  readonly updatedAt: number
}

const FlushReconciliationRecordSchema = z.object({
  userMessageId: NonEmptyStringSchema,
  userObserved: z.boolean(),
  contextObserved: z.boolean(),
  flushState: z.enum(['pending', 'durable', 'failed']),
  lastError: z.string().optional(),
  updatedAt: NonNegativeIntegerSchema,
}).strict()

export interface BacklinkJob {
  readonly setId: string
  readonly referenceId: string
  readonly state: 'pending' | 'written' | 'failed'
  readonly attempts: number
  readonly lastError?: string | undefined
  readonly receipt?: BacklinkReceiptV2 | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

const BacklinkJobSchema = z.object({
  setId: NonEmptyStringSchema,
  referenceId: NonEmptyStringSchema,
  state: z.enum(['pending', 'written', 'failed']),
  attempts: NonNegativeIntegerSchema,
  lastError: z.string().optional(),
  receipt: BacklinkReceiptV2Schema.optional(),
  createdAt: NonNegativeIntegerSchema,
  updatedAt: NonNegativeIntegerSchema,
}).strict()

export interface SessionAggregate {
  readonly schemaVersion: 1
  readonly profileId: string
  readonly sessionId: string
  readonly revision: number
  readonly pending?: ReferenceSet | undefined
  readonly sentSets: readonly ReferenceSet[]
  readonly operations: Readonly<Record<string, ReferenceOperationRecord>>
  readonly admissions: Readonly<Record<string, AdmissionRecord>>
  readonly submissionJournal: Readonly<Record<string, SubmissionJournalEntry>>
  readonly flushReconciliations: Readonly<Record<string, FlushReconciliationRecord>>
  readonly backlinkJobs: Readonly<Record<string, BacklinkJob>>
}

export const SessionAggregateSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  revision: NonNegativeIntegerSchema,
  pending: ReferenceSetSchema.optional(),
  sentSets: z.array(ReferenceSetSchema),
  operations: z.record(z.string(), ReferenceOperationRecordSchema),
  admissions: z.record(z.string(), AdmissionRecordSchema),
  submissionJournal: z.record(z.string(), SubmissionJournalEntrySchema),
  flushReconciliations: z.record(z.string(), FlushReconciliationRecordSchema),
  backlinkJobs: z.record(z.string(), BacklinkJobSchema),
}).strict() as unknown as z.ZodType<SessionAggregate>

export const annotationCoreDomainSpec = defineDomain({
  // rc.2's storage domain grammar allows only lowercase letters, digits and underscores.
  name: 'dsh_annotation_core_v1',
  version: 1,
  tables: { sessions: domainTable<string, SessionAggregate>(SessionAggregateSchema) },
})

export class AggregateRevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Aggregate revision conflict: expected ${expected}, received ${actual}`)
    this.name = 'AggregateRevisionConflictError'
  }
}

export class ReferenceOperationFencedError extends Error {
  constructor(readonly operationId: string, readonly fenceRevision: number) {
    super(`Reference operation ${JSON.stringify(operationId)} was fenced at revision ${fenceRevision}`)
    this.name = 'ReferenceOperationFencedError'
  }
}

export class AdmissionConflictError extends Error {
  constructor(readonly clientSubmissionId: string) {
    super(`Admission ${JSON.stringify(clientSubmissionId)} already exists with different canonical input`)
    this.name = 'AdmissionConflictError'
  }
}

export class AnnotationStoreDisposedError extends Error {
  constructor() {
    super('Annotation store is disposed')
    this.name = 'AnnotationStoreDisposedError'
  }
}

export interface AnnotationStoreOptions {
  readonly profileId: string
}

type SessionTable = KvTable<string, SessionAggregate>

interface MutationResult<T> {
  readonly changed: boolean
  readonly aggregate: SessionAggregate
  readonly value: T
}

interface Waiter {
  readonly afterRevision: number
  readonly resolve: (value: { revision: number; pending: ReferenceSet | undefined }) => void
  readonly reject: (error: unknown) => void
  readonly signal?: AbortSignal
  abort?: () => void
}

function emptyAggregate(profileId: string, sessionId: string): SessionAggregate {
  return {
    schemaVersion: 1,
    profileId,
    sessionId,
    revision: 0,
    sentSets: [],
    operations: {},
    admissions: {},
    submissionJournal: {},
    flushReconciliations: {},
    backlinkJobs: {},
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function assertExpected(aggregate: SessionAggregate, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || aggregate.revision !== expectedRevision) {
    throw new AggregateRevisionConflictError(expectedRevision, aggregate.revision)
  }
}

function assertIdentity(aggregate: SessionAggregate, profileId: string, sessionId: string): void {
  if (aggregate.profileId !== profileId || aggregate.sessionId !== sessionId) {
    throw new Error('Stored annotation aggregate identity does not match its key')
  }
}

function sourceFromItem(item: ReferenceItem): ReferenceSource {
  if (item.sourceType === 'dsh-message') {
    return { sourceType: item.sourceType, selectedText: item.selectedText, locator: clone(item.locator) }
  }
  return {
    sourceType: item.sourceType,
    selectedText: item.selectedText,
    locator: clone(item.locator),
    snapshot: clone(item.snapshot),
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

export class AnnotationStore {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, Set<Waiter>>()
  private disposed = false

  constructor(readonly table: SessionTable, readonly options: AnnotationStoreOptions) {
    if (options.profileId.trim().length === 0) throw new TypeError('profileId must not be empty')
  }

  static memoryTable(): SessionTable {
    const records = new Map<string, SessionAggregate>()
    return {
      get: (key) => records.get(key),
      entries: () => new Map(records).entries(),
      keys: () => new Map(records).keys(),
      get size() { return records.size },
      async put(key, value) { records.set(key, clone(value)) },
      async delete(key) { return records.delete(key) },
      async update(key, update) {
        const current = records.get(key)
        if (current === undefined) throw new Error(`missing-key: ${key}`)
        const next = update(current)
        records.set(key, clone(next))
        return clone(next)
      },
    }
  }

  private key(sessionId: string): string {
    if (sessionId.length === 0) throw new TypeError('sessionId must not be empty')
    return `${this.options.profileId}:${sessionId}`
  }

  read(sessionId: string): SessionAggregate {
    this.assertOpen()
    const stored = this.table.get(this.key(sessionId))
    if (stored === undefined) return emptyAggregate(this.options.profileId, sessionId)
    assertIdentity(stored, this.options.profileId, sessionId)
    return clone(stored)
  }

  readPending(sessionId: string): { revision: number; pending: ReferenceSet | undefined } {
    const aggregate = this.read(sessionId)
    return { revision: aggregate.revision, pending: aggregate.pending === undefined ? undefined : clone(aggregate.pending) }
  }

  readPendingState(sessionId: string): { revision: number; pendingCount: number } {
    const aggregate = this.read(sessionId)
    return { revision: aggregate.revision, pendingCount: aggregate.pending?.items.length ?? 0 }
  }

  async addReference(sessionId: string, input: {
    expectedRevision: number
    operationId: string
    setId: string
    referenceId: string
    source: ReferenceSource
    userComment?: string
    createdAt: number
  }): Promise<{ revision: number; setId: string; referenceId: string; created: boolean }> {
    const source = ReferenceSourceSchema.parse(input.source)
    const sourceDigest = canonicalSha256(source)
    return this.mutate(sessionId, (aggregate) => {
      const operation = aggregate.operations[input.operationId]
      if (operation !== undefined) {
        if (operation.state === 'canceled') throw new ReferenceOperationFencedError(input.operationId, operation.fenceRevision)
        if (operation.state === 'failed') throw new Error(`Reference operation ${JSON.stringify(input.operationId)} previously failed`)
        if (operation.referenceId !== input.referenceId || operation.sourceDigest !== sourceDigest || operation.setId === undefined) {
          throw new Error(`Reference operation ${JSON.stringify(input.operationId)} was reused with different input`)
        }
        return {
          changed: false,
          aggregate,
          value: { revision: aggregate.revision, setId: operation.setId, referenceId: input.referenceId, created: false },
        }
      }

      assertExpected(aggregate, input.expectedRevision)
      const pending = aggregate.pending ?? createPendingReferenceSet({
        setId: input.setId,
        profileId: this.options.profileId,
        sessionId,
        createdAt: input.createdAt,
      })
      const added = addReferenceToSet(pending, {
        referenceId: input.referenceId,
        source,
        ...(input.userComment === undefined ? {} : { userComment: input.userComment }),
      }, pending.revision)
      const revision = aggregate.revision + 1
      const record: ReferenceOperationRecord = {
        operationId: input.operationId,
        state: 'committed',
        fenceRevision: revision,
        referenceId: input.referenceId,
        setId: added.set.setId,
        sourceDigest,
        createdReference: added.disposition === 'added',
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }
      const next: SessionAggregate = {
        ...aggregate,
        revision,
        pending: added.set,
        operations: { ...aggregate.operations, [input.operationId]: record },
      }
      return {
        changed: true,
        aggregate: next,
        value: {
          revision,
          setId: added.set.setId,
          referenceId: input.referenceId,
          created: added.disposition === 'added',
        },
      }
    })
  }

  async fenceReferenceOperation(sessionId: string, input: {
    expectedRevision: number
    operationId: string
    now?: number
  }): Promise<{ state: ReferenceOperationState; fenceRevision: number }> {
    return this.mutate(sessionId, (aggregate) => {
      const existing = aggregate.operations[input.operationId]
      if (existing !== undefined) {
        return {
          changed: false,
          aggregate,
          value: { state: existing.state, fenceRevision: existing.fenceRevision },
        }
      }
      assertExpected(aggregate, input.expectedRevision)
      const revision = aggregate.revision + 1
      const now = input.now ?? Date.now()
      const record: ReferenceOperationRecord = {
        operationId: input.operationId,
        state: 'canceled',
        fenceRevision: revision,
        createdAt: now,
        updatedAt: now,
      }
      return {
        changed: true,
        aggregate: {
          ...aggregate,
          revision,
          operations: { ...aggregate.operations, [input.operationId]: record },
        },
        value: { state: 'canceled', fenceRevision: revision },
      }
    })
  }

  async discardPendingOperation(sessionId: string, input: {
    expectedRevision: number
    operationId: string
    now?: number
  }): Promise<{ revision: number; pendingCount: number }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      const operation = aggregate.operations[input.operationId]
      if (operation === undefined || operation.state !== 'committed') {
        return { changed: false, aggregate, value: this.pendingSummary(aggregate) }
      }
      let pending = aggregate.pending
      if (operation.createdReference && pending !== undefined && operation.referenceId !== undefined) {
        const item = pending.items.find((candidate) => candidate.referenceId === operation.referenceId)
        const retainedByAnotherOperation = Object.values(aggregate.operations).some((candidate) =>
          candidate.operationId !== operation.operationId &&
          candidate.state === 'committed' &&
          candidate.referenceId === operation.referenceId &&
          candidate.sourceDigest === operation.sourceDigest,
        )
        if (!retainedByAnotherOperation && item !== undefined && canonicalSha256(sourceFromItem(item)) === operation.sourceDigest) {
          pending = removeReferenceFromSet(pending, operation.referenceId, pending.revision)
          if (pending.items.length === 0) pending = undefined
        }
      }
      const revision = aggregate.revision + 1
      const now = input.now ?? Date.now()
      const canceled: ReferenceOperationRecord = { ...operation, state: 'canceled', fenceRevision: revision, updatedAt: now }
      const next: SessionAggregate = {
        ...aggregate,
        revision,
        ...(pending === undefined ? { pending: undefined } : { pending }),
        operations: { ...aggregate.operations, [input.operationId]: canceled },
      }
      return { changed: true, aggregate: next, value: this.pendingSummary(next) }
    })
  }

  async updateComment(sessionId: string, input: {
    expectedRevision: number
    referenceId: string
    comment: string
  }): Promise<{ revision: number; pendingCount: number }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      if (aggregate.pending === undefined) throw new RangeError('No pending reference set')
      const pending = updateReferenceComment(
        aggregate.pending,
        input.referenceId,
        input.comment,
        aggregate.pending.revision,
      )
      const next = { ...aggregate, revision: aggregate.revision + 1, pending }
      return { changed: true, aggregate: next, value: this.pendingSummary(next) }
    })
  }

  async removeReference(sessionId: string, input: {
    expectedRevision: number
    referenceId: string
  }): Promise<{ revision: number; pendingCount: number }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      if (aggregate.pending === undefined) throw new RangeError('No pending reference set')
      let pending: ReferenceSet | undefined = removeReferenceFromSet(
        aggregate.pending,
        input.referenceId,
        aggregate.pending.revision,
      )
      if (pending.items.length === 0) pending = undefined
      const next: SessionAggregate = { ...aggregate, revision: aggregate.revision + 1, pending }
      return { changed: true, aggregate: next, value: this.pendingSummary(next) }
    })
  }

  async reuseReference(sessionId: string, input: {
    expectedRevision: number
    sourceReferenceId: string
    operationId: string
    setId: string
    referenceId: string
    createdAt: number
  }): Promise<{ revision: number; setId: string; referenceId: string; created: boolean }> {
    const found = this.findSentReference(input.sourceReferenceId)
    if (found === undefined) throw new RangeError(`Unknown sent reference ${JSON.stringify(input.sourceReferenceId)}`)
    return this.addReference(sessionId, {
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      setId: input.setId,
      referenceId: input.referenceId,
      source: sourceFromItem(found.item),
      userComment: found.item.userComment,
      createdAt: input.createdAt,
    })
  }

  async lockPendingForSubmission(sessionId: string, input: {
    expectedRevision: number
    setId: string
    referenceRevision: number
  }): Promise<{ revision: number; set: ReferenceSet }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      const pending = aggregate.pending
      if (pending === undefined || pending.setId !== input.setId) throw new RangeError('Pending reference set does not match')
      if (pending.revision !== input.referenceRevision) {
        throw new AggregateRevisionConflictError(input.referenceRevision, pending.revision)
      }
      const locked = beginReferenceCommit(pending, pending.revision)
      const next = { ...aggregate, revision: aggregate.revision + 1, pending: locked }
      return { changed: true, aggregate: next, value: { revision: next.revision, set: locked } }
    })
  }

  async markPendingCommitFailed(sessionId: string, input: {
    expectedRevision: number
    setId: string
  }): Promise<{ revision: number; set: ReferenceSet }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      const pending = aggregate.pending
      if (pending === undefined || pending.setId !== input.setId) throw new RangeError('Pending reference set does not match')
      const failed = markReferenceCommitFailed(pending, pending.revision)
      const next = { ...aggregate, revision: aggregate.revision + 1, pending: failed }
      return { changed: true, aggregate: next, value: { revision: next.revision, set: failed } }
    })
  }

  async restorePendingCommit(sessionId: string, input: {
    expectedRevision: number
    setId: string
  }): Promise<{ revision: number; set: ReferenceSet }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      const pending = aggregate.pending
      if (pending === undefined || pending.setId !== input.setId) throw new RangeError('Pending reference set does not match')
      const restored = restoreFailedReferenceCommit(pending, pending.revision)
      const next = { ...aggregate, revision: aggregate.revision + 1, pending: restored }
      return { changed: true, aggregate: next, value: { revision: next.revision, set: restored } }
    })
  }

  async completePendingCommit(sessionId: string, input: {
    expectedRevision: number
    setId: string
    committedAt: number
    userMessageId: string
    userAnchorId: string
  }): Promise<{ revision: number; set: ReferenceSet }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      const pending = aggregate.pending
      if (pending === undefined || pending.setId !== input.setId) throw new RangeError('Pending reference set does not match')
      const sent = completeReferenceCommit(pending, {
        expectedRevision: pending.revision,
        committedAt: input.committedAt,
        userMessageId: input.userMessageId,
        userAnchorId: input.userAnchorId,
      })
      const next: SessionAggregate = {
        ...aggregate,
        revision: aggregate.revision + 1,
        pending: undefined,
        sentSets: [...aggregate.sentSets, sent],
      }
      return { changed: true, aggregate: next, value: { revision: next.revision, set: sent } }
    })
  }

  async prepareAdmission(sessionId: string, input: {
    expectedRevision: number
    clientSubmissionId: string
    requestDigest: string
    kind: AdmissionKind
    setId?: string
    referenceRevision?: number
    createdAt: number
  }): Promise<{ revision: number; record: AdmissionRecord; created: boolean }> {
    Sha256DigestSchema.parse(input.requestDigest)
    return this.mutate<{ revision: number; record: AdmissionRecord; created: boolean }>(sessionId, (aggregate) => {
      const existing = aggregate.admissions[input.clientSubmissionId]
      if (existing !== undefined) {
        if (
          existing.requestDigest !== input.requestDigest ||
          existing.kind !== input.kind ||
          existing.setId !== input.setId ||
          existing.referenceRevision !== input.referenceRevision
        ) throw new AdmissionConflictError(input.clientSubmissionId)
        return { changed: false, aggregate, value: { revision: aggregate.revision, record: existing, created: false } }
      }
      assertExpected(aggregate, input.expectedRevision)
      const record: AdmissionRecord = {
        clientSubmissionId: input.clientSubmissionId,
        requestDigest: input.requestDigest,
        kind: input.kind,
        state: 'prepared',
        ...(input.setId === undefined ? {} : { setId: input.setId }),
        ...(input.referenceRevision === undefined ? {} : { referenceRevision: input.referenceRevision }),
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }
      const next = {
        ...aggregate,
        revision: aggregate.revision + 1,
        admissions: { ...aggregate.admissions, [input.clientSubmissionId]: record },
      }
      return { changed: true, aggregate: next, value: { revision: next.revision, record, created: true } }
    })
  }

  readAdmission(sessionId: string, clientSubmissionId: string): AdmissionRecord | undefined {
    const record = this.read(sessionId).admissions[clientSubmissionId]
    return record === undefined ? undefined : clone(record)
  }

  async recordSubmissionJournal(sessionId: string, input: {
    expectedRevision: number
    userMessageId: string
    clientSubmissionId: string
    requestDigest: string
    setId?: string
    contextMessageId?: string
    createdAt: number
  }): Promise<{ revision: number; record: SubmissionJournalEntry; created: boolean }> {
    return this.mutate<{ revision: number; record: SubmissionJournalEntry; created: boolean }>(sessionId, (aggregate) => {
      const existing = aggregate.submissionJournal[input.userMessageId]
      const record: SubmissionJournalEntry = {
        userMessageId: input.userMessageId,
        clientSubmissionId: input.clientSubmissionId,
        requestDigest: input.requestDigest,
        ...(input.setId === undefined ? {} : { setId: input.setId }),
        ...(input.contextMessageId === undefined ? {} : { contextMessageId: input.contextMessageId }),
        createdAt: input.createdAt,
      }
      if (existing !== undefined) {
        if (canonicalSha256(existing) !== canonicalSha256(record)) throw new Error('Submission journal message ID conflict')
        return { changed: false, aggregate, value: { revision: aggregate.revision, record: existing, created: false } }
      }
      assertExpected(aggregate, input.expectedRevision)
      const next = {
        ...aggregate,
        revision: aggregate.revision + 1,
        submissionJournal: { ...aggregate.submissionJournal, [input.userMessageId]: record },
      }
      return { changed: true, aggregate: next, value: { revision: next.revision, record, created: true } }
    })
  }

  async recordFlushReconciliation(sessionId: string, input: {
    expectedRevision: number
    userMessageId: string
    userObserved: boolean
    contextObserved: boolean
    flushState: FlushReconciliationRecord['flushState']
    lastError?: string
    updatedAt: number
  }): Promise<{ revision: number; record: FlushReconciliationRecord }> {
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      const record: FlushReconciliationRecord = {
        userMessageId: input.userMessageId,
        userObserved: input.userObserved,
        contextObserved: input.contextObserved,
        flushState: input.flushState,
        ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        updatedAt: input.updatedAt,
      }
      const next = {
        ...aggregate,
        revision: aggregate.revision + 1,
        flushReconciliations: { ...aggregate.flushReconciliations, [input.userMessageId]: record },
      }
      return { changed: true, aggregate: next, value: { revision: next.revision, record } }
    })
  }

  async enqueueBacklink(sessionId: string, input: {
    expectedRevision: number
    setId: string
    referenceId: string
    createdAt: number
  }): Promise<{ revision: number; job: BacklinkJob; created: boolean }> {
    const jobKey = `${input.setId}:${input.referenceId}`
    return this.mutate<{ revision: number; job: BacklinkJob; created: boolean }>(sessionId, (aggregate) => {
      const existing = aggregate.backlinkJobs[jobKey]
      if (existing !== undefined) {
        return { changed: false, aggregate, value: { revision: aggregate.revision, job: existing, created: false } }
      }
      assertExpected(aggregate, input.expectedRevision)
      const job: BacklinkJob = {
        setId: input.setId,
        referenceId: input.referenceId,
        state: 'pending',
        attempts: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }
      const next = {
        ...aggregate,
        revision: aggregate.revision + 1,
        backlinkJobs: { ...aggregate.backlinkJobs, [jobKey]: job },
      }
      return { changed: true, aggregate: next, value: { revision: next.revision, job, created: true } }
    })
  }

  async retryBacklink(sessionId: string, input: {
    expectedRevision: number
    setId: string
    referenceId: string
    updatedAt?: number
  }): Promise<{ revision: number; job: BacklinkJob }> {
    const jobKey = `${input.setId}:${input.referenceId}`
    return this.mutate(sessionId, (aggregate) => {
      assertExpected(aggregate, input.expectedRevision)
      const existing = aggregate.backlinkJobs[jobKey]
      if (existing === undefined) throw new RangeError(`Unknown backlink job ${JSON.stringify(jobKey)}`)
      if (existing.state === 'written') {
        return { changed: false, aggregate, value: { revision: aggregate.revision, job: existing } }
      }
      const { lastError: _lastError, ...retryable } = existing
      const job: BacklinkJob = {
        ...retryable,
        state: 'pending',
        attempts: existing.attempts + 1,
        updatedAt: input.updatedAt ?? Date.now(),
      }
      const next = {
        ...aggregate,
        revision: aggregate.revision + 1,
        backlinkJobs: { ...aggregate.backlinkJobs, [jobKey]: job },
      }
      return { changed: true, aggregate: next, value: { revision: next.revision, job } }
    })
  }

  findSentReference(referenceId: string): { sessionId: string; set: ReferenceSet; item: ReferenceItem } | undefined {
    this.assertOpen()
    for (const [, aggregate] of this.table.entries()) {
      if (aggregate.profileId !== this.options.profileId) continue
      for (const set of aggregate.sentSets) {
        const item = set.items.find((candidate) => candidate.referenceId === referenceId)
        if (item !== undefined) return { sessionId: aggregate.sessionId, set: clone(set), item: clone(item) }
      }
    }
    return undefined
  }

  readSentSet(sessionId: string, setId: string): ReferenceSet | undefined {
    const set = this.read(sessionId).sentSets.find((candidate) => candidate.setId === setId)
    return set === undefined ? undefined : clone(set)
  }

  listSentForSession(sessionId: string): readonly ReferenceSet[] {
    return clone(this.read(sessionId).sentSets)
  }

  waitRevision(
    sessionId: string,
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<{ revision: number; pending: ReferenceSet | undefined }> {
    this.assertOpen()
    if (!Number.isInteger(afterRevision) || afterRevision < 0) throw new TypeError('afterRevision must be non-negative')
    const current = this.readPending(sessionId)
    if (current.revision > afterRevision) return Promise.resolve(current)
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const key = this.key(sessionId)
      const waiters = this.waiters.get(key) ?? new Set<Waiter>()
      const waiter: Waiter = { afterRevision, resolve, reject, ...(signal === undefined ? {} : { signal }) }
      if (signal !== undefined) {
        waiter.abort = () => {
          waiters.delete(waiter)
          signal.removeEventListener('abort', waiter.abort as () => void)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      waiters.add(waiter)
      this.waiters.set(key, waiters)
    })
  }

  close(): void {
    if (this.disposed) return
    this.disposed = true
    const error = new AnnotationStoreDisposedError()
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        if (waiter.signal !== undefined && waiter.abort !== undefined) {
          waiter.signal.removeEventListener('abort', waiter.abort)
        }
        waiter.reject(error)
      }
    }
    this.waiters.clear()
  }

  private pendingSummary(aggregate: SessionAggregate): { revision: number; pendingCount: number } {
    return { revision: aggregate.revision, pendingCount: aggregate.pending?.items.length ?? 0 }
  }

  private assertOpen(): void {
    if (this.disposed) throw new AnnotationStoreDisposedError()
  }

  private mutate<T>(sessionId: string, operation: (aggregate: SessionAggregate) => MutationResult<T>): Promise<T> {
    this.assertOpen()
    const key = this.key(sessionId)
    const prior = this.tails.get(key) ?? Promise.resolve()
    let result!: T
    const work = prior.then(async () => {
      this.assertOpen()
      const stored = this.table.get(key)
      const current = stored === undefined ? emptyAggregate(this.options.profileId, sessionId) : clone(stored)
      assertIdentity(current, this.options.profileId, sessionId)
      const mutation = operation(current)
      result = mutation.value
      if (!mutation.changed) return
      const validated = SessionAggregateSchema.parse(mutation.aggregate)
      if (stored === undefined) {
        await this.table.put(key, validated)
      } else {
        await this.table.update(key, (latest) => {
          if (latest.revision !== stored.revision) {
            throw new AggregateRevisionConflictError(stored.revision, latest.revision)
          }
          return validated
        })
      }
      this.notify(key, validated)
    })
    const tail = work.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    return work.then(() => result).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
  }

  private notify(key: string, aggregate: SessionAggregate): void {
    const waiters = this.waiters.get(key)
    if (waiters === undefined) return
    for (const waiter of [...waiters]) {
      if (aggregate.revision <= waiter.afterRevision) continue
      waiters.delete(waiter)
      if (waiter.signal !== undefined && waiter.abort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.abort)
      }
      waiter.resolve({
        revision: aggregate.revision,
        pending: aggregate.pending === undefined ? undefined : clone(aggregate.pending),
      })
    }
    if (waiters.size === 0) this.waiters.delete(key)
  }
}

export interface OpenAnnotationStore {
  readonly store: AnnotationStore
  readonly table: SessionTable
  readonly domain: Domain<typeof annotationCoreDomainSpec>
  close(): Promise<void>
}

export async function openAnnotationStore(ctx: Context, profileId: string): Promise<OpenAnnotationStore> {
  const domain = await ctx.storageDomain.open(annotationCoreDomainSpec)
  const table = domain.table('sessions')
  const store = new AnnotationStore(table, { profileId })
  let closed = false
  return {
    store,
    table,
    domain,
    async close() {
      if (closed) return
      closed = true
      store.close()
      await domain.close()
    },
  }
}
