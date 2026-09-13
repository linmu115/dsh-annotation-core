import { z } from 'zod'
import { BacklinkReceiptV2Schema } from '../protocol/index.ts'

/** Internal outbox acknowledgements; the external Obsidian protocol is unchanged. */
export const ReferenceCommitReceiptSchema = z.union([
  BacklinkReceiptV2Schema,
  z.object({
    kind: z.literal('maintenance-reference'),
    referenceId: z.string().min(1),
    targetMessageId: z.string().min(1),
    writtenAt: z.number().int().nonnegative(),
  }).strict(),
])
export type ReferenceCommitReceipt = z.infer<typeof ReferenceCommitReceiptSchema>
