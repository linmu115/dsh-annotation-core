import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type { ReferenceSource } from '../protocol/index.ts'
import type { AnnotationStore } from '../host/store.ts'
import { AggregateRevisionConflictError } from '../host/store.ts'
import type { BacklinkOutbox } from '../host/backlink-outbox.ts'
import type { PendingDiscardOutbox } from '../host/pending-discard-outbox.ts'
import type { CommittedDeleteOutbox } from '../host/committed-delete-outbox.ts'
import type {
  AnnotationSubmissionCoordinator,
  SubmitAnnotatedInput,
  SubmitPlainInput,
} from '../host/submit-annotated.ts'

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

export interface DeleteReferenceLinkRequest {
  readonly expectedRevision: number
  readonly setId: string
  readonly referenceId: string
  readonly deletedAt: number
}

export interface ReuseReferenceRequest {
  readonly expectedRevision: number
  readonly sourceReferenceId: string
  readonly operationId: string
  readonly setId: string
  readonly referenceId: string
  readonly createdAt: number
}

export type SubmitAnnotatedRequest = SubmitAnnotatedInput
export type SubmitPlainClaimRequest = SubmitPlainInput

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
  constructor(
    ctx: Context,
    readonly store: AnnotationStore,
    readonly submissions?: AnnotationSubmissionCoordinator,
    readonly outbox?: BacklinkOutbox,
    readonly discardOutbox?: PendingDiscardOutbox,
    readonly deleteOutbox?: CommittedDeleteOutbox,
  ) {
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
    this.discardOutbox?.kick(agent.id)
  }

  async updateComment(agent: Agent, request: UpdateCommentRequest): Promise<void> {
    await this.store.updateComment(agent.id, request)
  }

  async removeReference(agent: Agent, request: RemoveReferenceRequest): Promise<void> {
    await this.store.removeReference(agent.id, request)
    this.discardOutbox?.kick(agent.id)
  }

  async deleteReferenceLink(agent: Agent, request: DeleteReferenceLinkRequest) {
    const result = await this.store.deleteReferenceLink(agent.id, request)
    if (result.scope === 'pending') this.discardOutbox?.kick(agent.id)
    else this.deleteOutbox?.kick(agent.id)
    return result
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

  async submitAnnotated(agent: Agent, request: SubmitAnnotatedRequest, signal: AbortSignal) {
    if (this.submissions === undefined) throw new Error('Annotation submission runtime is unavailable')
    return this.submissions.submitAnnotated(agent, request, signal)
  }

  async submitPlainClaim(agent: Agent, request: SubmitPlainClaimRequest, signal: AbortSignal) {
    if (this.submissions === undefined) throw new Error('Annotation submission runtime is unavailable')
    return this.submissions.submitPlain(agent, request, signal)
  }

  async retryBacklink(agent: Agent, request: RetryBacklinkRequest) {
    const actual = this.store.read(agent.id).revision
    if (actual !== request.expectedRevision) throw new AggregateRevisionConflictError(request.expectedRevision, actual)
    if (this.outbox === undefined) return this.store.retryBacklink(agent.id, request)
    return this.outbox.retry(agent.id, request.setId, request.referenceId)
  }
}
