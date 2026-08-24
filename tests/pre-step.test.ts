import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import { collectReferenceDocuments } from '../src/domain/budget.ts'
import { addReference, beginReferenceCommit, createPendingReferenceSet } from '../src/domain/state-machine.ts'
import { createAnnotationContextMessage } from '../src/host/commit-journal.ts'
import { annotationPreStep } from '../src/host/pre-step.ts'
import { AnnotationStore } from '../src/host/store.ts'
import {
  annotationContextMessageId,
  selectedTextHash,
  serializePreparedReferenceSet,
} from '../src/protocol/index.ts'

const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function preparedSet(setId: string, referenceId: string, text: string) {
  const empty = createPendingReferenceSet({ setId, profileId: 'web', sessionId: 'session', createdAt: 1 })
  const pending = addReference(empty, {
    referenceId,
    source: {
      sourceType: 'dsh-message',
      selectedText: text,
      locator: {
        profileId: 'web', sessionId: 'source', anchorId: `anchor-${referenceId}`,
        role: 'user', occurrence: 0, selectedTextHash: selectedTextHash(text),
      },
    },
  }, 0).set
  return beginReferenceCommit(pending, pending.revision)
}

function agent(id: string): Agent {
  return { id } as unknown as Agent
}

async function journal(store: AnnotationStore, sessionId: string, messageId: string, setId: string, referenceId: string) {
  const set = preparedSet(setId, referenceId, `selected-${referenceId}`)
  const serialized = serializePreparedReferenceSet(set, collectReferenceDocuments(set))
  const contextMessageId = annotationContextMessageId({ sessionId, userMessageId: messageId, setId, digest: serialized.digest })
  return store.recordSubmissionJournal(sessionId, {
    expectedRevision: store.read(sessionId).revision,
    userMessageId: messageId,
    clientSubmissionId: `submission-${referenceId}`,
    requestDigest: digest,
    setId,
    contextMessageId,
    contextDigest: serialized.digest,
    preparedSet: set,
    createdAt: 2,
  })
}

async function enter(messages: ReturnType<typeof createUserMessage>[]): Promise<PreStepDecision> {
  return { kind: 'enter', messages }
}

describe('annotation pre-step', () => {
  it('passes ordinary messages and downstream rejection through unchanged', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary' }] })
    const accepted = await annotationPreStep(store, {
      agent: agent('session'), messages: [ordinary], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => enter([ordinary]))
    expect(accepted).toEqual({ kind: 'enter', messages: [ordinary] })

    await journal(store, 'session', ordinary.id, 'set', 'reference')
    const rejected = await annotationPreStep(store, {
      agent: agent('session'), messages: [ordinary], turn: 1, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'reject' }))
    expect(rejected).toEqual({ kind: 'reject' })
  })

  it('inserts each journaled context immediately after its exact direct user ID', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const first = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] })
    const other = createUserMessage({ source: { kind: 'plugin', plugin: 'other', form: 'notice', summary: 'other' }, content: [{ type: 'text', text: 'other' }] })
    const second = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] })
    await journal(store, 'session', first.id, 'set-1', 'reference-1')
    await journal(store, 'session', second.id, 'set-2', 'reference-2')
    const decision = await annotationPreStep(store, {
      agent: agent('session'), messages: [first, other, second], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => enter([first, other, second]))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages.map((message) => message.source.kind)).toEqual([
      'user', 'dsh-annotation', 'plugin', 'user', 'dsh-annotation',
    ])
    expect(decision.messages[1]?.source).toMatchObject({ targetUserMessageId: first.id, setId: 'set-1' })
    expect(decision.messages[4]?.source).toMatchObject({ targetUserMessageId: second.id, setId: 'set-2' })
  })

  it('isolates sessions, ignores unrelated pending state, and never duplicates deterministic context', async () => {
    const store = new AnnotationStore(AnnotationStore.memoryTable(), { profileId: 'web' })
    const direct = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'direct' }] })
    await journal(store, 'other-session', direct.id, 'set-other', 'reference-other')
    await store.addReference('session', {
      expectedRevision: 0, operationId: 'pending-operation', setId: 'pending-set', referenceId: 'pending-reference',
      source: {
        sourceType: 'dsh-message', selectedText: 'pending only',
        locator: { profileId: 'web', sessionId: 'source', anchorId: 'a', role: 'user', occurrence: 0, selectedTextHash: selectedTextHash('pending only') },
      },
      createdAt: 1,
    })
    const isolated = await annotationPreStep(store, {
      agent: agent('session'), messages: [direct], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => enter([direct]))
    expect(isolated).toEqual({ kind: 'enter', messages: [direct] })
    expect(store.readPending('session').pending?.setId).toBe('pending-set')

    await journal(store, 'session', direct.id, 'set-real', 'reference-real')
    const entry = store.readSubmissionJournal('session', direct.id)
    expect(entry).toBeDefined()
    const context = createAnnotationContextMessage('session', entry!)
    const retried = await annotationPreStep(store, {
      agent: agent('session'), messages: [direct, context], turn: 2, step: 1, signal: new AbortController().signal,
    }, () => enter([direct, context]))
    expect(retried).toEqual({ kind: 'enter', messages: [direct, context] })
  })
})
