import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Compatibility artifact is an executable JS script.
import { patchNativeReferenceInput } from '../scripts/patch-native-reference-input.mjs'

describe('native rc.2 reference-only send compatibility', () => {
  it('patches the real native input guards idempotently and refuses unknown builds', () => {
    const source = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url), 'utf8')
    const patched = patchNativeReferenceInput(source)
    expect(patched).toContain('input.claim?.allowEmpty === true')
    expect(patched).toContain('this.snapshot.claim?.allowEmpty === true')
    expect(patchNativeReferenceInput(patched)).toBe(patched)
    expect(() => patchNativeReferenceInput('unknown')).toThrow('Unsupported')
    const expression = patched.match(/const empty = (draft.trim\(\).*?);/)?.[1]
    expect(expression).toBeTruthy()
    const empty = new Function('draft', 'attachments', 'input', `return ${expression}`)
    expect(empty('', [], { phase: 'plain' })).toBe(true)
    expect(empty('', [], { phase: 'claimed', claim: { token: '' } })).toBe(true)
    expect(empty('', [], { phase: 'claimed', claim: { allowEmpty: true } })).toBe(false)
    expect(empty('hello', [], { phase: 'plain' })).toBe(false)
  })
})
