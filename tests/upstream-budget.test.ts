import { describe, expect, it } from 'vitest'
import { upstreamHeadroom } from '../src/host/upstream-budget.ts'

/** A request shaped like the real one: deriveMessages() plus the request tool catalogue. */
function conversation(characters: number) {
  return { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(characters) }] }], tools: [] }
}

describe('upstream read headroom', () => {
  it('prices the request in tokens rather than raw bytes', () => {
    const contextWindow = 100_000
    const request = conversation(160_000)
    const inputBytes = Buffer.byteLength(JSON.stringify(request))
    // The request is larger than the window when measured in bytes, which is what
    // used to zero the allowance; priced as tokens it still leaves room.
    expect(inputBytes).toBeGreaterThan(contextWindow)
    expect(upstreamHeadroom(contextWindow, request)).toBeGreaterThan(0)
  })

  it('still reports no headroom when the conversation cannot fit in tokens', () => {
    expect(upstreamHeadroom(8_000, conversation(200_000), 4_096)).toBe(0)
  })

  it('caps headroom at 24000 bytes and at a fifth of the window', () => {
    expect(upstreamHeadroom(1_000_000, conversation(1_000), 4_096)).toBe(24_000)
    expect(upstreamHeadroom(100_000, conversation(1_000), 4_096)).toBe(20_000)
  })

  it('rejects an unusable window', () => {
    for (const value of [undefined, 0, -1, Number.NaN, 1.5]) {
      expect(upstreamHeadroom(value as number | undefined, conversation(10))).toBe(0)
    }
  })
})
