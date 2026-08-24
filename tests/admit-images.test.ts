import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'

import { createDirectUserMessage } from '../src/host/admit-images.ts'

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nLkAAAAASUVORK5CYII='

function ref(id: string): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png', bytes: 68, width: 1, height: 1,
  }
}

describe('official image admission', () => {
  it('admits the complete ordered batch before constructing durable image blocks', async () => {
    const saveImages = vi.fn(async () => [ref('first'), ref('second')])
    const attachments = { saveImages } as unknown as AttachmentStore
    const message = await createDirectUserMessage({
      attachments,
      text: 'caption',
      images: [
        { mediaType: 'image/png', data: pixel, name: 'one.png' },
        { mediaType: 'image/png', data: pixel, name: 'two.png' },
      ],
    })
    expect(saveImages).toHaveBeenCalledTimes(1)
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content.map((block) => block.type)).toEqual(['text', 'image', 'image'])
    expect(message.content.slice(1).map((block) => block.type === 'image' ? block.attachment.attachmentId : '')).toEqual(['first', 'second'])
  })

  it('rejects invalid or partial admission without constructing a user message', async () => {
    const saveImages = vi.fn(async () => { throw new Error('batch failed') })
    const attachments = { saveImages } as unknown as AttachmentStore
    await expect(createDirectUserMessage({
      attachments,
      text: 'caption',
      images: [{ mediaType: 'image/png', data: pixel }],
    })).rejects.toThrow('batch failed')
    await expect(createDirectUserMessage({ attachments, text: '  ', images: [] })).rejects.toThrow(/nonempty/)
  })
})
