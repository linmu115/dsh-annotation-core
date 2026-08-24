import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { apply as applyStorageDomain } from '@deepseek-ai/dsh-storage-domain'
import { apply as applyStorageJson } from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AdmissionConflictError,
  AnnotationStore,
  ReferenceOperationFencedError,
  openAnnotationStore,
} from '../src/host/store.ts'
import { selectedTextHash } from '../src/protocol/index.ts'
import type { DshMessageReferenceSource } from '../src/protocol/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function source(text = 'selected'): DshMessageReferenceSource {
  return {
    sourceType: 'dsh-message',
    selectedText: text,
    locator: {
      profileId: 'web',
      sessionId: 'source-session',
      anchorId: 'source-anchor',
      role: 'user',
      occurrence: 0,
      selectedTextHash: selectedTextHash(text),
    },
  }
}

async function storage(root: string): Promise<Context> {
  const ctx = new Context()
  new Storage(ctx)
  applyStorageJson(ctx, { root })
  await applyStorageDomain(ctx, { backend: 'json' })
  return ctx
}

describe('AnnotationStore', () => {
  it('isolates profiles and sessions and recovers complete aggregates after reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'annotation-store-'))
    roots.push(root)
    const firstCtx = await storage(root)
    const first = await openAnnotationStore(firstCtx, 'web')
    const otherProfile = new AnnotationStore(first.table, { profileId: 'other' })

    await first.store.addReference('session-a', {
      expectedRevision: 0,
      operationId: 'operation-a',
      setId: 'set-a',
      referenceId: 'reference-a',
      source: source(),
      createdAt: 1,
    })

    expect(first.store.readPending('session-a').pending?.items).toHaveLength(1)
    expect(first.store.readPending('session-b')).toMatchObject({ revision: 0, pending: undefined })
    expect(otherProfile.readPending('session-a')).toMatchObject({ revision: 0, pending: undefined })
    await first.close()

    const reopened = await openAnnotationStore(firstCtx, 'web')
    expect(reopened.store.readPending('session-a').pending?.items[0]?.referenceId).toBe('reference-a')
    await reopened.close()
  })

  it('uses one aggregate CAS, one pending set, idempotent identities, and final-item cleanup', async () => {
    const table = AnnotationStore.memoryTable()
    const store = new AnnotationStore(table, { profileId: 'web' })
    const added = await store.addReference('session', {
      expectedRevision: 0,
      operationId: 'operation-1',
      setId: 'set-1',
      referenceId: 'reference-1',
      source: source(),
      createdAt: 10,
    })
    expect(added).toMatchObject({ revision: 1, setId: 'set-1', referenceId: 'reference-1', created: true })

    const repeated = await store.addReference('session', {
      expectedRevision: 0,
      operationId: 'operation-1',
      setId: 'ignored',
      referenceId: 'reference-1',
      source: source(),
      createdAt: 11,
    })
    expect(repeated).toMatchObject({ revision: 1, setId: 'set-1', created: false })

    await expect(store.addReference('session', {
      expectedRevision: 1,
      operationId: 'operation-conflict',
      setId: 'set-1',
      referenceId: 'reference-1',
      source: source('different'),
      createdAt: 12,
    })).rejects.toThrow(/different canonical source/)

    const removed = await store.removeReference('session', {
      expectedRevision: 1,
      referenceId: 'reference-1',
    })
    expect(removed).toMatchObject({ revision: 2, pendingCount: 0 })
    expect(store.readPending('session').pending).toBeUndefined()
  })

  it('locks one exact pending revision and moves the committed set to durable sent lookup', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    await store.addReference('session', {
      expectedRevision: 0,
      operationId: 'operation-1',
      setId: 'set-1',
      referenceId: 'reference-1',
      source: source(),
      createdAt: 1,
    })
    const locked = await store.lockPendingForSubmission('session', {
      expectedRevision: 1,
      setId: 'set-1',
      referenceRevision: 1,
    })
    expect(locked.set.state).toBe('committing')
    await expect(store.addReference('session', {
      expectedRevision: 2,
      operationId: 'operation-2',
      setId: 'set-2',
      referenceId: 'reference-2',
      source: source('another'),
      createdAt: 2,
    })).rejects.toThrow(/must be pending/)

    const completed = await store.completePendingCommit('session', {
      expectedRevision: 2,
      setId: 'set-1',
      committedAt: 3,
      userMessageId: 'message-1',
      userAnchorId: 'message-1',
    })
    expect(completed.set.state).toBe('sent')
    expect(store.readPendingState('session').pendingCount).toBe(0)
    expect(store.readSentSet('session', 'set-1')?.userMessageId).toBe('message-1')
    expect(store.listSentForSession('session')).toHaveLength(1)
  })

  it('lets an operation fence atomically defeat a late add and protects stale guards', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const fenced = await store.fenceReferenceOperation('session', {
      expectedRevision: 0,
      operationId: 'operation-race',
    })
    expect(fenced).toEqual({ state: 'canceled', fenceRevision: 1 })

    await expect(store.addReference('session', {
      expectedRevision: 0,
      operationId: 'operation-race',
      setId: 'set-race',
      referenceId: 'reference-race',
      source: source(),
      createdAt: 20,
    })).rejects.toBeInstanceOf(ReferenceOperationFencedError)

    const state = store.readPendingState('session')
    expect(state).toEqual({ revision: 1, pendingCount: 0 })
    await expect(store.removeReference('session', {
      expectedRevision: 0,
      referenceId: 'missing',
    })).rejects.toThrow(/revision conflict/i)
  })

  it('persists admission, message journal, reconciliation, and backlink outbox idempotently', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const admission = await store.prepareAdmission('session', {
      expectedRevision: 0,
      clientSubmissionId: 'submission-1',
      requestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'annotated',
      setId: 'set-1',
      referenceRevision: 3,
      createdAt: 30,
    })
    expect(admission.record.state).toBe('prepared')

    const same = await store.prepareAdmission('session', {
      expectedRevision: 0,
      clientSubmissionId: 'submission-1',
      requestDigest: admission.record.requestDigest,
      kind: 'annotated',
      setId: 'set-1',
      referenceRevision: 3,
      createdAt: 31,
    })
    expect(same).toMatchObject({ revision: admission.revision, created: false })

    await expect(store.prepareAdmission('session', {
      expectedRevision: admission.revision,
      clientSubmissionId: 'submission-1',
      requestDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'annotated',
      setId: 'set-1',
      referenceRevision: 3,
      createdAt: 32,
    })).rejects.toBeInstanceOf(AdmissionConflictError)

    const journaled = await store.recordSubmissionJournal('session', {
      expectedRevision: admission.revision,
      userMessageId: 'message-1',
      clientSubmissionId: 'submission-1',
      requestDigest: admission.record.requestDigest,
      setId: 'set-1',
      contextMessageId: 'context-1',
      createdAt: 33,
    })
    const reconciled = await store.recordFlushReconciliation('session', {
      expectedRevision: journaled.revision,
      userMessageId: 'message-1',
      userObserved: true,
      contextObserved: true,
      flushState: 'pending',
      updatedAt: 34,
    })
    const queued = await store.enqueueBacklink('session', {
      expectedRevision: reconciled.revision,
      setId: 'set-1',
      referenceId: 'reference-1',
      createdAt: 35,
    })

    const aggregate = store.read('session')
    expect(aggregate.submissionJournal['message-1']?.clientSubmissionId).toBe('submission-1')
    expect(aggregate.flushReconciliations['message-1']?.contextObserved).toBe(true)
    expect(aggregate.backlinkJobs['set-1:reference-1']?.state).toBe('pending')
    expect(queued.revision).toBe(4)
  })

  it('recovers long polls, supports cancellation, and rejects waiters after disposal', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const abort = new AbortController()
    const canceled = store.waitRevision('session', 0, abort.signal)
    abort.abort()
    await expect(canceled).rejects.toMatchObject({ name: 'AbortError' })

    const changed = store.waitRevision('session', 0)
    await store.fenceReferenceOperation('session', { expectedRevision: 0, operationId: 'change' })
    await expect(changed).resolves.toMatchObject({ revision: 1 })

    const disposed = store.waitRevision('other', 0)
    store.close()
    await expect(disposed).rejects.toThrow(/disposed/)
  })
})
