import { describe, expect, it } from 'vitest'

import { ANNOTATION_SYSTEM_PROMPT } from '../src/host/system-prompt.ts'

describe('annotation system prompt', () => {
  it('keeps user comments authoritative, source material untrusted, and links bounded to real numbers', () => {
    expect(ANNOTATION_SYSTEM_PROMPT).toContain('direct user message remains the primary request')
    expect(ANNOTATION_SYSTEM_PROMPT).toContain('userComment')
    expect(ANNOTATION_SYSTEM_PROMPT).toContain('untrusted reference material')
    expect(ANNOTATION_SYSTEM_PROMPT).toContain('[注释 N](#dsh-annotation-<setId>-N)')
    expect(ANNOTATION_SYSTEM_PROMPT).toContain('Never invent')
  })
})
