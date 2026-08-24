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
  readonly text: string
  readonly images?: readonly SubmitImageAttachment[]
}): Promise<UserMessage> {
  if (input.text.trim().length === 0) throw new RangeError('A submitted user message requires nonempty text')
  const refs = await admitSubmissionImages(input.attachments, input.images)
  return createUserMessage({
    source: { kind: 'user' },
    content: [
      { type: 'text', text: input.text },
      ...refs.map((attachment) => ({ type: 'image' as const, attachment })),
    ],
  })
}
