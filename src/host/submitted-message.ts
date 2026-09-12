import { z } from 'zod'

const count = z.number().int().nonnegative()
const dimensions = z.object({ width: count, height: count }).strict()
const image = z.object({
  attachmentId: z.string().min(1), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: count, width: count, height: count, name: z.string().optional(), originalDimensions: dimensions.optional(),
}).strict()
const file = z.object({ attachmentId: z.string().min(1), name: z.string(), bytes: count }).strict()

/** Durable submission evidence contains admitted refs, never browser upload receipts or encoded bytes. */
export const SubmittedMessageSchema = z.object({
  id: z.string().min(1), role: z.literal('user'),
  source: z.object({ kind: z.literal('user'), rpcId: z.string().optional() }).strict(),
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image'), attachment: image }).strict(),
    z.object({ type: z.literal('file'), attachment: file }).strict(),
  ])),
}).strict()
export type SubmittedMessage = z.infer<typeof SubmittedMessageSchema>
