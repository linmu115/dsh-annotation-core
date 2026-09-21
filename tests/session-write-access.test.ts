import { expect, it } from 'vitest'
import { assertSessionWritable, observeSessionWriteAccess } from '../src/host/write-access.ts'

it('allows independent writes but never turns an observed managed session into an offline writer', async () => {
  let provider: { assertWritable(): Promise<void> } | undefined
  let onRegistered: (() => void) | undefined
  const ctx = { get: () => provider, inject: (_names: string[], callback: () => void) => { onRegistered = callback } }
  observeSessionWriteAccess(ctx)
  await expect(assertSessionWritable(ctx)).resolves.toBeUndefined()
  provider = { assertWritable: async () => { throw new Error('Maintenance unavailable') } }
  onRegistered!()
  await expect(assertSessionWritable(ctx)).rejects.toThrow('Maintenance unavailable')
  provider = undefined
  await expect(assertSessionWritable(ctx)).rejects.toThrow('已注册')
  provider = { assertWritable: async () => {} }
  await expect(assertSessionWritable(ctx)).resolves.toBeUndefined()
})
