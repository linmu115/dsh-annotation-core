import { expect, it, vi } from 'vitest'
import { withSubmissionProgress } from '../src/host/submission-progress.ts'
it('notifies before submission and reports the real outcome without changing it', async () => {
  const order: string[] = [], finish = vi.fn(() => order.push('finish'))
  const ctx = { get: () => ({ begin: () => { order.push('begin'); return { finish } } }) } as any
  const result = { kind: 'success' as const, clientSubmissionId: 'one', userMessageId: 'message' }
  expect(await withSubmissionProgress(ctx, {} as any, { clientSubmissionId: 'one', text: 'draft' }, new AbortController().signal,
    async () => { order.push('submit'); return result })).toBe(result)
  expect(order).toEqual(['begin', 'submit', 'finish']); expect(finish).toHaveBeenCalledWith(result)
})
it('preserves failures and works without the optional GPT owner', async () => {
  const finish = vi.fn(), error = new Error('failed'), input = { clientSubmissionId: 'one', text: 'draft' }
  await expect(withSubmissionProgress({ get: () => ({ begin: () => ({ finish }) }) } as any, {} as any, input,
    new AbortController().signal, async () => { throw error })).rejects.toBe(error)
  expect(finish).toHaveBeenCalledWith({ kind: 'error', message: 'failed' })
  const result = { kind: 'error' as const, code: 'delivery' as const, message: 'kept' }
  expect(await withSubmissionProgress({ get: () => undefined } as any, {} as any, input, new AbortController().signal, async () => result)).toBe(result)
})
