import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('annotation core client bundle contract', () => {
  it('depends only on frozen platform module-table entries and injects its own style', async () => {
    const source = await readFile(join(process.cwd(), 'lib', 'client.js'), 'utf8')
    const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
    expect(new Set(required)).toEqual(new Set([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-runtime/client',
      'react',
      'react/jsx-runtime',
    ]))
    expect(source).toContain('data-plugin-css')
    expect(source).toContain('dsh-annotation-core/styles')
    expect(source).not.toContain('\\u2063')
    expect(source).not.toContain('tests/fixtures/codex-annotation-visual.html')
  })
})
