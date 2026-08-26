import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('annotation core client bundle contract', () => {
  it('publishes the complete 0.1.2 core API with official rc.2 peers', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
      exports: Record<string, { types?: string; default?: string } | string>
      files: string[]
      peerDependencies: Record<string, string>
      dependencies: Record<string, string>
      dsh: { bundle: { patch: string }; client: { inject: string[]; platform: string } }
      dshKnowledge: { annotationProtocolVersion: number }
    }
    expect(pkg.version).toBe('0.1.2')
    expect(Object.keys(pkg.exports)).toEqual(expect.arrayContaining([
      '.', './client', './protocol', './client-api', './host-api', './typert', './remote', './package.json',
    ]))
    for (const key of ['.', './client', './protocol', './client-api', './host-api', './typert', './remote']) {
      const entry = pkg.exports[key]
      expect(typeof entry).toBe('object')
      if (typeof entry === 'object') {
        await expect(access(join(process.cwd(), entry.types?.replace(/^\.\//, '') ?? 'missing'))).resolves.toBeUndefined()
        await expect(access(join(process.cwd(), entry.default?.replace(/^\.\//, '') ?? 'missing'))).resolves.toBeUndefined()
      }
    }
    for (const name of [
      '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-input-trigger', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session',
    ]) expect(pkg.peerDependencies[name]).toBe('0.1.1-rc.2')
    expect(pkg.files).toContain('README_EN.md')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-input-trigger',
      ],
      platform: 'web',
    })
    expect(pkg.dshKnowledge).toEqual({ annotationProtocolVersion: 2 })
    expect(JSON.stringify({ peers: pkg.peerDependencies, dependencies: pkg.dependencies })).not.toMatch(/better-sidebar|obsidian/i)
  })

  it('declares one Host patch row and no second core instance', async () => {
    const patch = await readFile(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
    expect(patch.match(/name:\s*['"]?dsh-annotation-core['"]?/g)).toHaveLength(1)
    expect(patch.match(/^\s*- insert:/gm)).toHaveLength(1)
  })

  it('depends only on frozen platform module-table entries and injects its own style', async () => {
    const source = await readFile(join(process.cwd(), 'lib', 'client.js'), 'utf8')
    const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
    expect(new Set(required)).toEqual(new Set([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-runtime/client',
      'react',
      'react-dom',
      'react/jsx-runtime',
    ]))
    expect(source).toContain('data-plugin-css')
    expect(source).toContain('dsh-annotation-core/styles')
    expect(source).not.toContain('\\u2063')
    expect(source).not.toContain('tests/fixtures/codex-annotation-visual.html')
  })

  it('loads the protocol entry in an ordinary Node process', async () => {
    const protocol = await import(new URL('../lib/protocol.js', import.meta.url).href)
    expect(protocol.ANNOTATION_PROTOCOL_VERSION).toBe(2)
  })
})
