import { z } from 'zod'

import { documentHash, selectedTextHash } from './serialization.ts'

export const ANNOTATION_PROTOCOL_VERSION = 2 as const

const NonEmptyStringSchema = z.string().min(1)
export const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const OccurrenceSchema = z.number().int().nonnegative()

export const DshMessageCaptureSchema = z.object({
  selectedText: NonEmptyStringSchema,
  sourceSessionId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema.optional(),
  anchorId: NonEmptyStringSchema,
  role: z.enum(['user', 'assistant']),
  occurrence: OccurrenceSchema,
}).strict()

export const DshMessageLocatorSchema = z.object({
  profileId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  messageId: NonEmptyStringSchema.optional(),
  anchorId: NonEmptyStringSchema,
  role: z.enum(['user', 'assistant']),
  occurrence: OccurrenceSchema,
  selectedTextHash: Sha256DigestSchema,
}).strict()

export const ObsidianNoteLocatorSchema = z.object({
  vaultId: NonEmptyStringSchema,
  notePath: NonEmptyStringSchema,
  heading: NonEmptyStringSchema.optional(),
  blockId: NonEmptyStringSchema,
  occurrence: OccurrenceSchema,
  selectedTextHash: Sha256DigestSchema,
}).strict()

export const SourceSnapshotSchema = z.object({
  markdown: z.string(),
  documentHash: Sha256DigestSchema,
  capturedAt: z.number().int().nonnegative(),
  freshness: z.enum(['captured', 'refreshed', 'offline']),
}).strict()

export const DshMessageReferenceSourceSchema = z.object({
  sourceType: z.literal('dsh-message'),
  selectedText: NonEmptyStringSchema,
  locator: DshMessageLocatorSchema,
}).strict().superRefine((source, context) => {
  if (source.locator.selectedTextHash !== selectedTextHash(source.selectedText)) {
    context.addIssue({ code: 'custom', path: ['locator', 'selectedTextHash'], message: 'selectedTextHash must hash the normalized selectedText' })
  }
})

export const ObsidianNoteReferenceSourceSchema = z.object({
  sourceType: z.literal('obsidian-note'),
  selectedText: NonEmptyStringSchema,
  locator: ObsidianNoteLocatorSchema,
  snapshot: SourceSnapshotSchema,
}).strict().superRefine((source, context) => {
  if (source.locator.selectedTextHash !== selectedTextHash(source.selectedText)) {
    context.addIssue({ code: 'custom', path: ['locator', 'selectedTextHash'], message: 'selectedTextHash must hash the normalized selectedText' })
  }
  if (source.snapshot.documentHash !== documentHash(source.snapshot.markdown)) {
    context.addIssue({ code: 'custom', path: ['snapshot', 'documentHash'], message: 'documentHash must hash the complete normalized Markdown' })
  }
})

export const ReferenceSourceSchema = z.union([
  DshMessageReferenceSourceSchema,
  ObsidianNoteReferenceSourceSchema,
])

const ProtocolEnvelopeSchema = { annotationProtocolVersion: z.literal(ANNOTATION_PROTOCOL_VERSION) }

export const ObsidianReferenceCaptureV2Schema = z.object({
  ...ProtocolEnvelopeSchema,
  type: z.literal('reference-capture'),
  actionId: NonEmptyStringSchema,
  referenceId: NonEmptyStringSchema,
  source: ObsidianNoteReferenceSourceSchema,
}).strict()

export const ReferenceClaimV2Schema = z.object({
  ...ProtocolEnvelopeSchema,
  type: z.literal('reference-claim'),
  referenceId: NonEmptyStringSchema,
  profileId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  setId: NonEmptyStringSchema,
}).strict()

export const ReferenceRefreshRequestV2Schema = z.object({
  ...ProtocolEnvelopeSchema,
  type: z.literal('reference-refresh'),
  referenceId: NonEmptyStringSchema,
  knownDocumentHash: Sha256DigestSchema,
}).strict()

export const ReferenceRefreshResultV2Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unchanged'), source: ObsidianNoteReferenceSourceSchema }).strict(),
  z.object({ kind: z.literal('refreshed'), source: ObsidianNoteReferenceSourceSchema }).strict(),
  z.object({ kind: z.literal('offline') }).strict(),
  z.object({ kind: z.literal('blocked'), reason: z.enum(['note-missing', 'block-missing', 'selection-changed', 'ambiguous']) }).strict(),
])

export const ReferenceDiscardV2Schema = z.object({
  ...ProtocolEnvelopeSchema,
  type: z.literal('reference-discard'),
  referenceId: NonEmptyStringSchema,
}).strict()

export const BacklinkCommitV2Schema = z.object({
  ...ProtocolEnvelopeSchema,
  type: z.literal('backlink-commit'),
  referenceId: NonEmptyStringSchema,
  setId: NonEmptyStringSchema,
  profileId: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema,
  userMessageId: NonEmptyStringSchema,
  userAnchorId: NonEmptyStringSchema,
  userTextHash: Sha256DigestSchema,
}).strict()

export const BacklinkReceiptV2Schema = z.object({
  referenceId: NonEmptyStringSchema,
  commitDigest: Sha256DigestSchema,
  notePath: NonEmptyStringSchema,
  blockId: NonEmptyStringSchema,
  revision: NonEmptyStringSchema,
  writtenAt: z.number().int().nonnegative(),
}).strict()

export type SourceType = 'dsh-message' | 'obsidian-note'
export type DshMessageCapture = z.infer<typeof DshMessageCaptureSchema>
export type DshMessageLocator = z.infer<typeof DshMessageLocatorSchema>
export type ObsidianNoteLocator = z.infer<typeof ObsidianNoteLocatorSchema>
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>
export type DshMessageReferenceSource = z.infer<typeof DshMessageReferenceSourceSchema>
export type ObsidianNoteReferenceSource = z.infer<typeof ObsidianNoteReferenceSourceSchema>
export type ReferenceSource = z.infer<typeof ReferenceSourceSchema>
export type ObsidianReferenceCaptureV2 = z.infer<typeof ObsidianReferenceCaptureV2Schema>
export type ReferenceClaimV2 = z.infer<typeof ReferenceClaimV2Schema>
export type ReferenceRefreshRequestV2 = z.infer<typeof ReferenceRefreshRequestV2Schema>
export type ReferenceRefreshResultV2 = z.infer<typeof ReferenceRefreshResultV2Schema>
export type ReferenceDiscardV2 = z.infer<typeof ReferenceDiscardV2Schema>
export type BacklinkCommitV2 = z.infer<typeof BacklinkCommitV2Schema>
export type BacklinkReceiptV2 = z.infer<typeof BacklinkReceiptV2Schema>
