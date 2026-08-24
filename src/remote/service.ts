import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { ReferenceSource } from '../protocol/index.ts'
import type { AnnotationStore } from '../host/store.ts'

export interface AddReferenceRequest {
  readonly expectedRevision: number
  readonly operationId: string
  readonly setId: string
  readonly referenceId: string
  readonly source: ReferenceSource
  readonly userComment?: string
  readonly createdAt: number
}

export interface FenceReferenceOperationRequest {
  readonly expectedRevision: number
  readonly operationId: string
}

export interface DiscardPendingOperationRequest extends FenceReferenceOperationRequest {}

export interface UpdateCommentRequest {
  readonly expectedRevision: number
  readonly referenceId: string
  readonly comment: string
}

export interface RemoveReferenceRequest {
  readonly expectedRevision: number
  readonly referenceId: string
}

export interface ReuseReferenceRequest {
  readonly expectedRevision: number
  readonly sourceReferenceId: string
  readonly operationId: string
  readonly setId: string
  readonly referenceId: string
  readonly createdAt: number
}

export interface SubmitAnnotatedRequest {
  readonly expectedRevision: number
  readonly setId: string
  readonly referenceRevision: number
  readonly clientSubmissionId: string
  readonly requestDigest: string
  readonly text: string
  readonly images?: readonly unknown[]
  readonly createdAt: number
}

export interface SubmitPlainClaimRequest {
  readonly expectedRevision: number
  readonly clientSubmissionId: string
  readonly requestDigest: string
  readonly text: string
  readonly images?: readonly unknown[]
  readonly createdAt: number
}

export interface RetryBacklinkRequest {
  readonly expectedRevision: number
  readonly setId: string
  readonly referenceId: string
}

/**
 * Agent-scoped Host boundary. Task 3 owns durable admission and identity;
 * Task 5 replaces the prepared-only submit methods with the full Agent transaction.
 */
export class AnnotationCoreRemoteService extends TypertRemoteService {
  constructor(ctx: Context, readonly store: AnnotationStore) {
    super(ctx, 'annotationCore')
  }

  readPending(agent: Agent): { revision: number; pending: ReturnType<AnnotationStore['readPending']>['pending'] | null } {
    const state = this.store.readPending(agent.id)
    return { revision: state.revision, pending: state.pending ?? null }
  }

  addReference(agent: Agent, request: AddReferenceRequest) {
    return this.store.addReference(agent.id, request)
  }

  fenceReferenceOperation(agent: Agent, request: FenceReferenceOperationRequest) {
    return this.store.fenceReferenceOperation(agent.id, request)
  }

  async discardPendingOperation(agent: Agent, request: DiscardPendingOperationRequest): Promise<void> {
    await this.store.discardPendingOperation(agent.id, request)
  }

  async updateComment(agent: Agent, request: UpdateCommentRequest): Promise<void> {
    await this.store.updateComment(agent.id, request)
  }

  async removeReference(agent: Agent, request: RemoveReferenceRequest): Promise<void> {
    await this.store.removeReference(agent.id, request)
  }

  reuseReference(agent: Agent, request: ReuseReferenceRequest) {
    return this.store.reuseReference(agent.id, request)
  }

  readSentSet(agent: Agent, setId: string) {
    return this.store.readSentSet(agent.id, setId) ?? null
  }

  listSentForSession(agent: Agent) {
    return this.store.listSentForSession(agent.id)
  }

  async waitRevision(agent: Agent, afterRevision: number, signal: AbortSignal) {
    const state = await this.store.waitRevision(agent.id, afterRevision, signal)
    return { revision: state.revision, pending: state.pending ?? null }
  }

  readAdmission(agent: Agent, clientSubmissionId: string) {
    return this.store.readAdmission(agent.id, clientSubmissionId) ?? null
  }

  async submitAnnotated(agent: Agent, request: SubmitAnnotatedRequest, _signal: AbortSignal) {
    const pending = this.store.readPending(agent.id)
    if (pending.pending?.setId !== request.setId || pending.pending.revision !== request.referenceRevision) {
      throw new Error('Annotated submission does not match the Host-authoritative pending set revision')
    }
    return this.store.prepareAdmission(agent.id, {
      expectedRevision: request.expectedRevision,
      clientSubmissionId: request.clientSubmissionId,
      requestDigest: request.requestDigest,
      kind: 'annotated',
      setId: request.setId,
      referenceRevision: request.referenceRevision,
      createdAt: request.createdAt,
    })
  }

  async submitPlainClaim(agent: Agent, request: SubmitPlainClaimRequest, _signal: AbortSignal) {
    if (request.text.trim().length === 0) throw new RangeError('Plain claim requires nonempty text')
    if (this.store.readPendingState(agent.id).pendingCount !== 0) {
      throw new Error('Plain claim is blocked while Host-authoritative references are pending')
    }
    return this.store.prepareAdmission(agent.id, {
      expectedRevision: request.expectedRevision,
      clientSubmissionId: request.clientSubmissionId,
      requestDigest: request.requestDigest,
      kind: 'plain',
      createdAt: request.createdAt,
    })
  }

  retryBacklink(agent: Agent, request: RetryBacklinkRequest) {
    return this.store.retryBacklink(agent.id, request)
  }
}
