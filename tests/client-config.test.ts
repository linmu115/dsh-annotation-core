// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { normalizeClientConfig } from '../src/client/config.ts'

describe('annotation core client profile config', () => {
  it('defaults to the official web profile when rc.2 supplies no client config', () => {
    expect(normalizeClientConfig()).toEqual({ profileId: 'web' })
    expect(normalizeClientConfig({ profileId: '   ' })).toEqual({ profileId: 'web' })
  })

  it('preserves an explicit future web-profile id', () => {
    expect(normalizeClientConfig({ profileId: 'research-web' })).toEqual({ profileId: 'research-web' })
  })
})
