import { collectReferenceDocuments } from '../domain/budget.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'

import type { AnnotationStore, SubmissionJournalEntry } from './store.ts'
import {
  annotationContextMessageId,
  serializePreparedReferenceSet,
} from '../protocol/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-annotation': {
      kind: 'dsh-annotation'
      schemaVersion: 1
      setId: string
      targetUserMessageId: string
      count: number
      digest: string
    }
  }
}

export function createAnnotationContextMessage(
  sessionId: string,
  journal: SubmissionJournalEntry,
): UserMessage {
  if (
    journal.setId === undefined ||
    journal.preparedSet === undefined ||
    journal.contextDigest === undefined ||
    journal.contextMessageId === undefined
  ) throw new TypeError('Submission journal does not contain prepared annotation context')
  const serialized = serializePreparedReferenceSet(
    journal.preparedSet,
    collectReferenceDocuments(journal.preparedSet),
  )
  if (serialized.digest !== journal.contextDigest) throw new Error('Persisted annotation context digest does not match its prepared set')
  const expectedId = annotationContextMessageId({
    sessionId,
    userMessageId: journal.userMessageId,
    setId: journal.setId,
    digest: serialized.digest,
  })
  if (expectedId !== journal.contextMessageId) throw new Error('Persisted annotation context ID does not match its journal identity')
  return freezeMessage({
    id: MessageId(expectedId),
    role: 'user',
    content: [{ type: 'text', text: serialized.text }],
    source: {
      kind: 'dsh-annotation',
      schemaVersion: 1,
      setId: journal.setId,
      targetUserMessageId: journal.userMessageId,
      count: journal.preparedSet.items.length,
      digest: serialized.digest,
    },
  })
}

export function journalForDirectUser(
  store: AnnotationStore,
  sessionId: string,
  message: UserMessage,
): SubmissionJournalEntry | undefined {
  if (message.source.kind !== 'user') return undefined
  return store.readSubmissionJournal(sessionId, message.id)
}
