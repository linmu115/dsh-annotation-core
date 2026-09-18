import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileUploads, FileUploadReceiptId, PromptFileBinding } from '@deepseek-ai/dsh-client-file-upload'
import type { SubmissionAttachment } from '../protocol/submission-attachments.ts'
import type {
  AttachmentStore,
  EncodedImageAttachment,
  ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

export type SubmitImageAttachment = EncodedImageAttachment

export async function admitSubmissionImages(
  attachments: AttachmentStore,
  images: readonly SubmitImageAttachment[] = [],
): Promise<readonly ImageAttachmentRef[]> {
  return admitEncodedImages(attachments, images)
}

export async function createDirectUserMessage(input: {
  readonly attachments: AttachmentStore
  readonly allowEmptyText?: boolean
  readonly text: string
  readonly images?: readonly SubmitImageAttachment[]
}): Promise<UserMessage> {
  if (!input.allowEmptyText && input.text.trim().length === 0) throw new RangeError('A submitted user message requires nonempty text')
  const refs = await admitSubmissionImages(input.attachments, input.images)
  return createUserMessage({
    source: { kind: 'user' },
    content: [
      { type: 'text', text: input.text },
      ...refs.map((attachment) => ({ type: 'image' as const, attachment })),
    ],
  })
}

/** Resolve every receipt before persisting images; the caller commits binding after Agent acceptance. */
export async function prepareSubmission(input: {
  readonly attachments: AttachmentStore
  readonly fileUploads?: Pick<FileUploads, 'resolve' | 'bindPrompt'> | undefined
  readonly agent: Agent
  readonly requestId: string
  readonly allowEmptyText?: boolean
  readonly text: string
  readonly images?: readonly SubmitImageAttachment[]
  readonly ordered?: readonly SubmissionAttachment[]
}): Promise<{ message: UserMessage; binding?: PromptFileBinding }> {
  if (input.ordered === undefined) return { message: await createDirectUserMessage(input) }
  if (input.images !== undefined) throw new TypeError('Specify images or attachments, not both')
  if (!input.allowEmptyText && input.text.trim().length === 0) throw new RangeError('A submitted user message requires nonempty text')
  const receipts: FileUploadReceiptId[] = []
  const parts = input.ordered.map(part => {
    if (part.type === 'image') return part
    const receiptId = part.receiptId as FileUploadReceiptId
    const attachment = input.fileUploads?.resolve(input.agent, receiptId)
    if (attachment === undefined) throw new Error('File receipt is unavailable in this session; upload the file again')
    receipts.push(receiptId)
    return { type: 'file' as const, attachment }
  })
  const content = await input.attachments.admitPromptContent([{ type: 'text', text: input.text }, ...parts])
  // The request identity is retained in queue/history so FileUploads retires only its own receipts.
  const message = createUserMessage({ source: { kind: 'user', rpcId: input.requestId }, content })
  const binding = receipts.length === 0 ? undefined
    : input.fileUploads!.bindPrompt(input.agent, [...new Set(receipts)], input.requestId)
  return { message, ...(binding === undefined ? {} : { binding }) }
}
