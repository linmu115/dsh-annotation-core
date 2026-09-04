import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { BacklinkOutbox } from '../src/host/backlink-outbox.ts'
import { annotationPreStep } from '../src/host/pre-step.ts'
import { SessionSettlementTracker } from '../src/host/session-reconcile.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import {
  AdmissionConflictError,
  AggregateRevisionConflictError,
  AnnotationStore,
  UnresolvedAdmissionError,
} from '../src/host/store.ts'
import { AnnotationSubmissionCoordinator } from '../src/host/submit-annotated.ts'
import { documentHash, selectedTextHash, submissionRequestDigest } from '../src/protocol/index.ts'

class TestAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 10_000_000,
    maxImagesPerMessage: 10,
    maxMessageImageBytes: 20_000_000,
    maxImagePixels: 10_000_000,
    maxImageDimension: 10_000,
    mediaTypes: ['image/png'],
  }

  readonly saves: SaveImageAttachment[] = []

  async validateImage(): Promise<void> {}
  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saves.push(input)
    return {
      attachmentId: `attachment-${this.saves.length}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...(input.name === undefined ? {} : { name: input.name }),
    }
  }
  async readImage(): Promise<StoredImageAttachment> { throw new Error('unused') }
  async readImageRequest(_ref: ImageAttachmentRef, _policy: ImageRequestPolicy): Promise<RequestImageAttachment> { throw new Error('unused') }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

type DeliveryMode = 'accept' | 'reject' | 'drop'

function fixture(options: { mode?: DeliveryMode; flush?: 'success' | 'fail' | 'defer' } = {}) {
  const ctx = new Context()
  new SessionStore(ctx)
  new TestAttachments(ctx)
  const session = ctx.sessions.create(SessionId(`session-${crypto.randomUUID()}`))
  const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
  const sources = new HostSourceRegistry(ctx)
  const settlements = new SessionSettlementTracker(ctx)
  const outbox = new BacklinkOutbox(store, sources, () => 100)
  const coordinator = new AnnotationSubmissionCoordinator(ctx, store, sources, settlements, outbox, () => 100)
  const flushGate = deferred()
  const flushMode = options.flush ?? 'success'
  ctx.on('session/flush', async () => {
    if (flushMode === 'fail') throw new Error('disk unavailable')
    if (flushMode === 'defer') await flushGate.promise
  })

  const sends: Array<{ message: Parameters<Agent['send']>[0]; target: string; wakeup: boolean; journalBeforeSend: boolean }> = []
  let idle = Promise.resolve()
  const agent = {
    id: session.id,
    session,
    ctx,
    options: {},
    status: 'idle',
    inbox: {},
    cancel: vi.fn(),
    runMaintenance: vi.fn(),
    followup: vi.fn(),
    steer: vi.fn(),
    inject: vi.fn(),
    whenIdle: () => idle,
    send(message: Parameters<Agent['send']>[0], target: string, wakeup: boolean) {
      sends.push({
        message,
        target,
        wakeup,
        journalBeforeSend: store.readSubmissionJournal(session.id, message.id) !== undefined,
      })
      idle = (async () => {
        await Promise.resolve()
        if ((options.mode ?? 'accept') === 'drop') return
        const next = async (): Promise<PreStepDecision> => (options.mode === 'reject'
          ? { kind: 'reject' }
          : { kind: 'enter', messages: [message] })
        const decision = await annotationPreStep(store, {
          agent: agent as unknown as Agent,
          messages: [message],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        }, next)
        if (decision.kind === 'enter') {
          for (const entered of decision.messages) session.append('user/message', entered, { surfaceOp: 'append' })
        }
      })()
    },
  } as unknown as Agent
  return { ctx, session, store, sources, settlements, coordinator, agent, sends, flushGate }
}

async function addReference(store: AnnotationStore, sessionId: string, text = 'selected') {
  return store.addReference(sessionId, {
    expectedRevision: store.read(sessionId).revision,
    operationId: `operation-${crypto.randomUUID()}`,
    setId: 'set',
    referenceId: 'reference',
    source: {
      sourceType: 'dsh-message',
      selectedText: text,
      locator: {
        profileId: 'web', sessionId: 'source', anchorId: 'anchor', role: 'user', occurrence: 0,
        selectedTextHash: selectedTextHash(text),
      },
    },
    createdAt: 1,
  })
}

function annotatedRequest(store: AnnotationStore, sessionId: string, overrides: Partial<{
  clientSubmissionId: string
  requestDigest: string
  text: string
}> = {}) {
  const state = store.readPending(sessionId)
  const text = overrides.text ?? 'question'
  return {
    expectedRevision: state.revision,
    setId: state.pending?.setId ?? 'set',
    referenceRevision: state.pending?.revision ?? 0,
    clientSubmissionId: overrides.clientSubmissionId ?? 'submission',
    requestDigest: overrides.requestDigest ?? submissionRequestDigest({ text, images: [] }),
    text,
    images: [],
    createdAt: 2,
  }
}

describe('Host annotated submission transaction', () => {
  it('journals a normal user message before fixed next-turn wake delivery and waits for disk flush', async () => {
    const f = fixture({ flush: 'defer' })
    await addReference(f.store, f.session.id)
    const operation = f.coordinator.submitAnnotated(f.agent, annotatedRequest(f.store, f.session.id))
    await vi.waitFor(() => { expect(f.sends).toHaveLength(1) })
    expect(f.sends[0]).toMatchObject({ target: 'next-turn', wakeup: true, journalBeforeSend: true })
    expect(f.sends[0]?.message.source).toEqual({ kind: 'user' })
    let settled = false
    void operation.then(() => { settled = true })
    await vi.waitFor(() => { expect(f.session.snapshotEvents().filter((event) => event.type === 'user/message')).toHaveLength(2) })
    expect(settled).toBe(false)
    f.flushGate.resolve()
    await expect(operation).resolves.toMatchObject({ kind: 'success', setId: 'set' })
    expect(f.store.readPendingState(f.session.id).pendingCount).toBe(0)
    expect(f.store.readSentSet(f.session.id, 'set')?.state).toBe('sent')
    expect(f.session.deriveMessages().map((message) => message.source.kind)).toEqual(['user', 'dsh-annotation'])
  })

  it('does not mutate or enqueue when source preparation is blocked', async () => {
    const f = fixture()
    const selected = 'note selection'
    await f.store.addReference(f.session.id, {
      expectedRevision: 0, operationId: 'note-operation', setId: 'set', referenceId: 'reference', createdAt: 1,
      source: {
        sourceType: 'obsidian-note', selectedText: selected,
        locator: { vaultId: 'vault', notePath: 'note.md', blockId: 'block', occurrence: 0, selectedTextHash: selectedTextHash(selected) },
        snapshot: { markdown: '# note', documentHash: documentHash('# note'), capturedAt: 1, freshness: 'captured' },
      },
    })
    const before = f.store.read(f.session.id)
    const result = await f.coordinator.submitAnnotated(f.agent, annotatedRequest(f.store, f.session.id))
    expect(result).toMatchObject({ kind: 'error', code: 'source-blocked' })
    expect(f.sends).toHaveLength(0)
    expect(f.store.read(f.session.id)).toEqual(before)
  })

  it('restores pending after downstream rejection and leaves uncertain flush failures ID-bound', async () => {
    const rejected = fixture({ mode: 'reject' })
    await addReference(rejected.store, rejected.session.id)
    const failed = await rejected.coordinator.submitAnnotated(rejected.agent, annotatedRequest(rejected.store, rejected.session.id))
    expect(failed).toMatchObject({ kind: 'error', code: 'durability' })
    expect(rejected.store.readPending(rejected.session.id).pending?.state).toBe('pending')
    expect(rejected.store.readAdmission(rejected.session.id, 'submission')?.state).toBe('failed')

    const unflushed = fixture({ flush: 'fail' })
    await addReference(unflushed.store, unflushed.session.id)
    const uncertain = await unflushed.coordinator.submitAnnotated(unflushed.agent, annotatedRequest(unflushed.store, unflushed.session.id))
    expect(uncertain).toMatchObject({ kind: 'error', code: 'unresolved' })
    expect(unflushed.store.readAdmission(unflushed.session.id, 'submission')?.state).toBe('enqueued')
    expect(unflushed.store.readPending(unflushed.session.id).pending?.state).toBe('committing')
    await expect(unflushed.coordinator.submitAnnotated(
      unflushed.agent,
      { ...annotatedRequest(unflushed.store, unflushed.session.id), clientSubmissionId: 'fresh' },
    )).rejects.toBeInstanceOf(UnresolvedAdmissionError)
  })

  it('is idempotent across concurrent/retried responses and rejects changed digest or stale identity', async () => {
    const f = fixture()
    await addReference(f.store, f.session.id)
    const request = annotatedRequest(f.store, f.session.id)
    const [first, second] = await Promise.all([
      f.coordinator.submitAnnotated(f.agent, request),
      f.coordinator.submitAnnotated(f.agent, request),
    ])
    expect(first).toEqual(second)
    expect(f.sends).toHaveLength(1)
    await expect(f.coordinator.submitAnnotated(f.agent, {
      ...request,
      requestDigest: submissionRequestDigest({ text: 'changed', images: [] }),
      text: 'changed',
    })).rejects.toBeInstanceOf(AdmissionConflictError)

    const stale = fixture()
    await addReference(stale.store, stale.session.id)
    const staleRequest = annotatedRequest(stale.store, stale.session.id)
    await expect(stale.coordinator.submitAnnotated(stale.agent, {
      ...staleRequest,
      referenceRevision: staleRequest.referenceRevision - 1,
    })).rejects.toBeInstanceOf(AggregateRevisionConflictError)

    const competing = fixture()
    await addReference(competing.store, competing.session.id)
    const firstRequest = annotatedRequest(competing.store, competing.session.id, { clientSubmissionId: 'first' })
    const secondRequest = { ...firstRequest, clientSubmissionId: 'second' }
    const firstClient = competing.coordinator.submitAnnotated(competing.agent, firstRequest)
    const secondClient = competing.coordinator.submitAnnotated(competing.agent, secondRequest)
    await expect(firstClient).resolves.toMatchObject({ kind: 'success' })
    await expect(secondClient).rejects.toBeInstanceOf(AggregateRevisionConflictError)
    expect(competing.sends).toHaveLength(1)
  })

  it('restores the exact pending set when official image admission rejects', async () => {
    const f = fixture()
    await addReference(f.store, f.session.id)
    const state = f.store.readPending(f.session.id)
    const text = 'question with image'
    const images = [{ mediaType: 'image/png' as const, data: 'not-canonical-base64' }]
    const result = await f.coordinator.submitAnnotated(f.agent, {
      expectedRevision: state.revision,
      setId: state.pending!.setId,
      referenceRevision: state.pending!.revision,
      clientSubmissionId: 'image-failure',
      requestDigest: submissionRequestDigest({ text, images }),
      text,
      images,
      createdAt: 2,
    })
    expect(result).toMatchObject({ kind: 'error', code: 'image-admission' })
    expect(f.sends).toHaveLength(0)
    expect(f.store.readPending(f.session.id).pending).toMatchObject({ setId: 'set', state: 'pending' })
  })

  it('sends plain claims without annotation context and refuses empty or pending claims', async () => {
    const f = fixture()
    const text = 'plain question'
    const result = await f.coordinator.submitPlain(f.agent, {
      expectedRevision: 0,
      clientSubmissionId: 'plain',
      requestDigest: submissionRequestDigest({ text, images: [] }),
      text,
      images: [],
      createdAt: 1,
    })
    expect(result).toMatchObject({ kind: 'success', clientSubmissionId: 'plain' })
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(f.store.readSubmissionJournal(f.session.id, f.sends[0]?.message.id ?? '')).toBeUndefined()

    await expect(f.coordinator.submitPlain(f.agent, {
      expectedRevision: f.store.read(f.session.id).revision,
      clientSubmissionId: 'empty',
      requestDigest: submissionRequestDigest({ text: '', images: [] }),
      text: '', images: [], createdAt: 2,
    })).rejects.toThrow(/nonempty/)

    const pending = fixture()
    await addReference(pending.store, pending.session.id)
    await expect(pending.coordinator.submitPlain(pending.agent, {
      expectedRevision: pending.store.read(pending.session.id).revision,
      clientSubmissionId: 'plain',
      requestDigest: submissionRequestDigest({ text, images: [] }),
      text, images: [], createdAt: 2,
    })).rejects.toThrow(/pending/)
  })
})
