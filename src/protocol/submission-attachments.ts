import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Ordered RC2 command attachments. Receipts are resolved only by their receiving Agent. */
export type SubmissionAttachment =
  | ({ readonly type: 'image' } & EncodedImageAttachment)
  | { readonly type: 'file'; readonly receiptId: string }

/** Legacy callers retain their original digest; native RC2 callers use the ordered contract. */
export function submissionAttachmentFields(items: readonly (SubmissionAttachment | EncodedImageAttachment)[]):
  { images?: readonly EncodedImageAttachment[]; attachments?: readonly SubmissionAttachment[] } {
  if (items.length === 0) return {}
  const ordered = items.some(item => 'type' in item)
  if (!ordered) return { images: items as readonly EncodedImageAttachment[] }
  if (items.some(item => !('type' in item))) throw new TypeError('Mixed legacy and ordered attachments')
  return { attachments: items as readonly SubmissionAttachment[] }
}
