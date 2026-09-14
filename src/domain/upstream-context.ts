import { z } from 'zod'

/** Only the bounded material used by this submission, not another source-session snapshot. */
export const PreparedUpstreamContextSchema = z.object({
  kind: z.literal('selected-turn'),
  sourceVersionId: z.string().min(1),
  cutoffEventId: z.string().min(1),
  items: z.array(z.object({
    eventId: z.string().min(1), role: z.string(), text: z.string(),
    offset: z.number().int().nonnegative(), complete: z.boolean(),
  }).strict()).max(20),
  turnComplete: z.boolean(),
  omittedIntermediateItems: z.number().int().nonnegative().optional(),
  detailsCursor: z.string().max(2048).optional(),
  nextCursor: z.string().max(2048).nullable(),
  hasMore: z.boolean(),
  disclosureRequestId: z.string().min(1).max(256).optional(),
}).strict()

export type PreparedUpstreamContext = z.infer<typeof PreparedUpstreamContextSchema>
