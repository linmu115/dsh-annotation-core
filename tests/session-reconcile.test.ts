import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { collectReferenceDocuments } from '../src/domain/budget.ts'
import { BacklinkOutbox } from '../src/host/backlink-outbox.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { AnnotationStore } from '../src/host/store.ts'
import { SessionSettlementTracker, StartupSubmissionReconciler } from '../src/host/session-reconcile.ts'
import { annotationContextMessageId, selectedTextHash, serializePreparedReferenceSet } from '../src/protocol/index.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

function fixture(withFlush = true) {
  const ctx = new Context()
  new SessionStore(ctx)
  const session = ctx.sessions.create(SessionId(`session-${crypto.randomUUID()}`))
  if (withFlush) ctx.on('session/flush', async () => {})
  const idle = deferred()
  const agent = {
    id: session.id,
    session,
    ctx,
    whenIdle: () => idle.promise,
  } as unknown as Agent
  return { ctx, session, agent, idle, tracker: new SessionSettlementTracker(ctx) }
}

function contextMessage(id: string, target: string) {
  return freezeMessage({
    id: MessageId(id), role: 'user' as const,
    content: [{ type: 'text' as const, text: '<dsh-annotations />' }],
    source: { kind: 'dsh-annotation' as const, schemaVersion: 1 as const, setId: 'set', targetUserMessageId: target, count: 1, digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  })
}

describe('session durability settlement', () => {
  it('waits for the exact user and context events and then an explicit successful flush', async () => {
    const { session, agent, tracker } = fixture()
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] })
    const context = contextMessage('context', user.id)
    const settlement = tracker.begin(agent, { userMessageId: user.id, contextMessageId: context.id })
    settlement.afterSend()
    let settled = false
    void settlement.promise.then(() => { settled = true })
    session.append('user/message', user, { surfaceOp: 'append' })
    await Promise.resolve()
    expect(settled).toBe(false)
    session.append('user/message', context, { surfaceOp: 'append' })
    await expect(settlement.promise).resolves.toEqual({ userObserved: true, contextObserved: true })
  })

  it('fails on idle without target context, flush nonparticipation, abort and disposal', async () => {
    const missing = fixture()
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] })
    const waiting = missing.tracker.begin(missing.agent, { userMessageId: user.id, contextMessageId: 'missing' })
    waiting.afterSend()
    missing.session.append('user/message', user, { surfaceOp: 'append' })
    missing.idle.resolve()
    await expect(waiting.promise).rejects.toThrow(/became idle/)

    const noFlush = fixture(false)
    const plain = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'plain' }] })
    const unflushed = noFlush.tracker.begin(noFlush.agent, { userMessageId: plain.id })
    noFlush.session.append('user/message', plain, { surfaceOp: 'append' })
    await expect(unflushed.promise).rejects.toThrow(/No session durability listener/)

    const aborted = fixture()
    const abort = new AbortController()
    const canceled = aborted.tracker.begin(aborted.agent, { userMessageId: 'never', signal: abort.signal })
    abort.abort()
    await expect(canceled.promise).rejects.toMatchObject({ name: 'SettlementError', code: 'aborted' })

    const disposed = fixture()
    const pending = disposed.tracker.begin(disposed.agent, { userMessageId: 'never' })
    disposed.tracker.disposeAgent(disposed.agent)
    await expect(pending.promise).rejects.toThrow(/disposed/)
  })

  it('joins identical retries without creating a second settlement barrier', async () => {
    const { session, agent, tracker } = fixture()
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'same' }] })
    const first = tracker.begin(agent, { userMessageId: user.id })
    const second = tracker.begin(agent, { userMessageId: user.id })
    expect(first.promise).toBe(second.promise)
    session.append('user/message', user, { surfaceOp: 'append' })
    await expect(first.promise).resolves.toMatchObject({ userObserved: true })
  })

  it('replays one missing deterministic context on startup, flushes, and finalizes only once', async () => {
    const { ctx, session, agent } = fixture()
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const selected = 'startup source'
    await store.addReference(session.id, {
      expectedRevision: 0, operationId: 'operation', setId: 'set', referenceId: 'reference', createdAt: 1,
      source: {
        sourceType: 'dsh-message', selectedText: selected,
        locator: { profileId: 'web', sessionId: 'source', anchorId: 'anchor', role: 'user', occurrence: 0, selectedTextHash: selectedTextHash(selected) },
      },
    })
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] })
    const begun = await store.beginAnnotatedAdmission(session.id, {
      expectedRevision: 1, clientSubmissionId: 'submission',
      requestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      setId: 'set', referenceRevision: 1, createdAt: 2,
    })
    const serialized = serializePreparedReferenceSet(begun.set!, collectReferenceDocuments(begun.set!))
    const contextId = annotationContextMessageId({ sessionId: session.id, userMessageId: user.id, setId: 'set', digest: serialized.digest })
    await store.recordEnqueuedSubmission(session.id, {
      expectedRevision: begun.revision, clientSubmissionId: 'submission',
      requestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userMessageId: user.id, contextMessageId: contextId, contextDigest: serialized.digest,
      userTextHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      preparedSet: begun.set!, createdAt: 3,
    })
    session.append('user/message', user, { surfaceOp: 'append' })
    const sources = new HostSourceRegistry(ctx)
    const outbox = new BacklinkOutbox(store, sources)
    const reconciler = new StartupSubmissionReconciler(ctx, store, outbox, () => 4)
    await reconciler.reconcile(agent)
    expect(session.deriveMessages().map((message) => message.source.kind)).toEqual(['user', 'dsh-annotation'])
    expect(store.readAdmission(session.id, 'submission')?.state).toBe('durable')
    expect(store.readSentSet(session.id, 'set')?.state).toBe('sent')
    await reconciler.reconcile(agent)
    expect(session.snapshotEvents().filter((event) => event.type === 'user/message')).toHaveLength(2)
  })
})
