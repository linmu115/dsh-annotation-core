import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { z } from 'zod'

import { ReferenceSourceSchema, Sha256DigestSchema } from '../protocol/index.ts'

const stringCodec = (symbol: string) => ({ mode: 'strict' as const, typeSymbol: symbol, schema: z.string().min(1) })
const integerCodec = (symbol: string) => ({ mode: 'strict' as const, typeSymbol: symbol, schema: z.number().int().nonnegative() })
const unknownCodec = (symbol: string) => ({ mode: 'strict' as const, typeSymbol: symbol, schema: z.unknown() })
const voidCodec = (symbol: string) => ({ mode: 'strict' as const, typeSymbol: symbol, schema: z.undefined() })

const AgentParameter = {
  name: 'agent',
  wire: 'agentId',
  source: 'lookup' as const,
  lookup: 'agent',
  codec: stringCodec('@deepseek-ai/dsh-session/types#SessionId'),
}

const Scope = { context: 'agent', wire: 'agentId' }

function jsonParameter(name: string, schema: z.ZodType, typeSymbol = `dsh-annotation-core#${name}`) {
  return { name, wire: name, source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol, schema } }
}

const RevisionSchema = z.number().int().nonnegative()
const MutationBase = {
  expectedRevision: RevisionSchema,
}
const AddReferenceRequestSchema = z.object({
  ...MutationBase,
  operationId: z.string().min(1),
  setId: z.string().min(1),
  referenceId: z.string().min(1),
  source: ReferenceSourceSchema,
  userComment: z.string().optional(),
  createdAt: RevisionSchema,
}).strict()
const FenceRequestSchema = z.object({ ...MutationBase, operationId: z.string().min(1) }).strict()
const UpdateCommentRequestSchema = z.object({
  ...MutationBase,
  referenceId: z.string().min(1),
  comment: z.string(),
}).strict()
const RemoveReferenceRequestSchema = z.object({ ...MutationBase, referenceId: z.string().min(1) }).strict()
const ReuseReferenceRequestSchema = z.object({
  ...MutationBase,
  sourceReferenceId: z.string().min(1),
  operationId: z.string().min(1),
  setId: z.string().min(1),
  referenceId: z.string().min(1),
  createdAt: RevisionSchema,
}).strict()
const SubmitAnnotatedRequestSchema = z.object({
  ...MutationBase,
  setId: z.string().min(1),
  referenceRevision: RevisionSchema,
  clientSubmissionId: z.string().min(1),
  requestDigest: Sha256DigestSchema,
  text: z.string(),
  images: z.array(z.unknown()).optional(),
  createdAt: RevisionSchema,
}).strict()
const SubmitPlainClaimRequestSchema = z.object({
  ...MutationBase,
  clientSubmissionId: z.string().min(1),
  requestDigest: Sha256DigestSchema,
  text: z.string(),
  images: z.array(z.unknown()).optional(),
  createdAt: RevisionSchema,
}).strict()
const RetryBacklinkRequestSchema = z.object({
  ...MutationBase,
  setId: z.string().min(1),
  referenceId: z.string().min(1),
}).strict()

function descriptor(
  method: string,
  parameters: InvocationDescriptor['parameters'],
  result: InvocationDescriptor['result'],
  cancellation = false,
): InvocationDescriptor {
  return {
    id: `dsh-annotation-core#annotationCore/${method}`,
    service: 'annotationCore',
    namespace: 'annotationCore',
    method,
    invocation: { kind: 'direct' },
    scope: Scope,
    parameters: [AgentParameter, ...parameters],
    ...(cancellation ? { cancellation: { parameter: 'signal' } } : {}),
    result,
  }
}

export const ANNOTATION_CORE_REMOTE_DESCRIPTORS: readonly InvocationDescriptor[] = [
  descriptor('readPending', [], unknownCodec('dsh-annotation-core#ReadPendingResult')),
  descriptor('addReference', [jsonParameter('request', AddReferenceRequestSchema)], unknownCodec('dsh-annotation-core#AddReferenceResult')),
  descriptor('fenceReferenceOperation', [jsonParameter('request', FenceRequestSchema)], unknownCodec('dsh-annotation-core#FenceResult')),
  descriptor('discardPendingOperation', [jsonParameter('request', FenceRequestSchema)], voidCodec('void')),
  descriptor('updateComment', [jsonParameter('request', UpdateCommentRequestSchema)], voidCodec('void')),
  descriptor('removeReference', [jsonParameter('request', RemoveReferenceRequestSchema)], voidCodec('void')),
  descriptor('reuseReference', [jsonParameter('request', ReuseReferenceRequestSchema)], unknownCodec('dsh-annotation-core#ReuseReferenceResult')),
  descriptor('readSentSet', [jsonParameter('setId', z.string().min(1), 'string')], unknownCodec('dsh-annotation-core#ReadSentSetResult')),
  descriptor('listSentForSession', [], unknownCodec('dsh-annotation-core#ListSentResult')),
  descriptor('waitRevision', [jsonParameter('afterRevision', RevisionSchema, 'number')], unknownCodec('dsh-annotation-core#WaitRevisionResult'), true),
  descriptor('readAdmission', [jsonParameter('clientSubmissionId', z.string().min(1), 'string')], unknownCodec('dsh-annotation-core#ReadAdmissionResult')),
  descriptor('submitAnnotated', [jsonParameter('request', SubmitAnnotatedRequestSchema)], unknownCodec('dsh-annotation-core#SubmitAnnotatedResult'), true),
  descriptor('submitPlainClaim', [jsonParameter('request', SubmitPlainClaimRequestSchema)], unknownCodec('dsh-annotation-core#SubmitPlainClaimResult'), true),
  descriptor('retryBacklink', [jsonParameter('request', RetryBacklinkRequestSchema)], unknownCodec('dsh-annotation-core#RetryBacklinkResult')),
]

export const TYPERT: TypertContribution = {
  package: 'dsh-annotation-core',
  face: 'host',
  schemas: [],
  invocations: ANNOTATION_CORE_REMOTE_DESCRIPTORS,
  model: {
    services: [{
      key: 'annotationCore',
      exportName: 'AnnotationCoreRemoteService',
      members: [],
      types: [],
      tags: [],
      description: 'Agent-scoped durable annotation boundary.',
    }],
    events: [],
    objects: [],
  },
}

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-annotation-core',
  descriptors: ANNOTATION_CORE_REMOTE_DESCRIPTORS,
}

export default TYPERT
