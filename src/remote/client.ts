import type { Context } from '@deepseek-ai/cordis'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

import type { AdmissionRecord } from '../host/store.ts'
import type { SubmissionResult } from '../host/submit-annotated.ts'
import type { ReferenceSet } from '../domain/model.ts'
import type {
  AddReferenceRequest,
  DiscardPendingOperationRequest,
  DeleteReferenceLinkRequest,
  FenceReferenceOperationRequest,
  RemoveReferenceRequest,
  RetryBacklinkRequest,
  ReuseReferenceRequest,
  SubmitAnnotatedRequest,
  SubmitPlainClaimRequest,
  UpdateCommentRequest,
} from './service.ts'
export { TYPERT_REMOTE } from './typert.ts'

export interface AnnotationCoreRemoteNamespace {
  readPending(): Promise<RemoteResult<{ revision: number; pending: ReferenceSet | null }>>
  addReference(request: AddReferenceRequest): Promise<RemoteResult<{
    revision: number
    setId: string
    referenceId: string
    created: boolean
  }>>
  fenceReferenceOperation(request: FenceReferenceOperationRequest): Promise<RemoteResult<{
    state: 'canceled' | 'committed' | 'failed'
    fenceRevision: number
  }>>
  discardPendingOperation(request: DiscardPendingOperationRequest): Promise<RemoteResult<void>>
  updateComment(request: UpdateCommentRequest): Promise<RemoteResult<void>>
  removeReference(request: RemoveReferenceRequest): Promise<RemoteResult<void>>
  deleteReferenceLink(request: DeleteReferenceLinkRequest): Promise<RemoteResult<{
    revision: number
    deleted: boolean
    scope: 'pending' | 'sent'
  }>>
  reuseReference(request: ReuseReferenceRequest): Promise<RemoteResult<{
    revision: number
    setId: string
    referenceId: string
    created: boolean
  }>>
  readSentSet(setId: string): Promise<RemoteResult<ReferenceSet | null>>
  listSentForSession(): Promise<RemoteResult<readonly ReferenceSet[]>>
  waitRevision(afterRevision: number, signal?: AbortSignal): Promise<RemoteResult<{
    revision: number
    pending: ReferenceSet | null
  }>>
  readAdmission(clientSubmissionId: string): Promise<RemoteResult<AdmissionRecord | null>>
  submitAnnotated(request: SubmitAnnotatedRequest, signal?: AbortSignal): Promise<RemoteResult<SubmissionResult>>
  submitPlainClaim(request: SubmitPlainClaimRequest, signal?: AbortSignal): Promise<RemoteResult<SubmissionResult>>
  retryBacklink(request: RetryBacklinkRequest): Promise<RemoteResult<unknown>>
}

export class AnnotationRemoteFailureError extends Error {
  constructor(readonly failure: RemoteFailure) {
    super(failure.message)
    this.name = 'AnnotationRemoteFailureError'
  }
}

export function unwrapRemote<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new AnnotationRemoteFailureError(result.error)
  return result.value
}

export function annotationRemote(ctx: Context): AnnotationCoreRemoteNamespace {
  const service = ctx.get('remote.annotationCore') as AnnotationCoreRemoteNamespace | undefined
  if (service === undefined) throw new Error('dsh-annotation-core: Remote descriptor is not mounted')
  return service
}

interface SessionScopeService {
  scope(sessionId: string): Context | undefined
}

/** Resolve a Remote namespace from the explicitly requested Agent scope. */
export function annotationRemoteForSession(ctx: Context, sessionId: string): AnnotationCoreRemoteNamespace {
  const sessions = ctx.get('sessions') as SessionScopeService | undefined
  const scoped = sessions?.scope(sessionId)
  if (scoped === undefined) throw new Error(`dsh-annotation-core: session scope unavailable for ${JSON.stringify(sessionId)}`)
  return annotationRemote(scoped)
}
