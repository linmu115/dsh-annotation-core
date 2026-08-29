import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('annotation core client bundle contract', () => {
  it('publishes the complete 0.3.1 core API with version-open peers', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string
      exports: Record<string, { types?: string; default?: string } | string>
      files: string[]
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional?: boolean }>
      dependencies: Record<string, string>
      dsh: { bundle: { patch: string }; client: { inject: string[]; platform: string } }
      dshKnowledge: { annotationProtocolVersion: number }
      dshWorkshop: { compatibility?: unknown }
    }
    expect(pkg.version).toBe('0.3.1')
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
    expect(new Set(Object.values(pkg.peerDependencies))).toEqual(new Set(['*']))
    expect(Object.keys(pkg.peerDependenciesMeta).sort()).toEqual(Object.keys(pkg.peerDependencies).sort())
    expect(Object.values(pkg.peerDependenciesMeta).every((value) => value.optional === true)).toBe(true)
    expect(pkg.dshWorkshop.compatibility).toBeUndefined()
    expect(pkg.files).toContain('README_EN.md')
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client).toEqual({
      inject: [
        '@deepseek-ai/dsh-api-session-controller',
        '@deepseek-ai/dsh-client-ui-chat',
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
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
    ]))
    expect(source).toContain('data-plugin-css')
    expect(source).toContain('dsh-annotation-core/styles')
    expect(source).not.toContain('\\u2063')
    expect(source).not.toContain('tests/fixtures/codex-annotation-visual.html')
  })

  it('owns exactly one global annotation dialog instead of one per composer', async () => {
    const entry = await readFile(join(process.cwd(), 'src', 'client.tsx'), 'utf8')
    const service = await readFile(join(process.cwd(), 'src', 'client', 'service.tsx'), 'utf8')
    const composer = await readFile(join(process.cwd(), 'src', 'client', 'composer-binding.tsx'), 'utf8')
    expect(entry).toContain('service.renderGlobalDialog()')
    expect(service.match(/renderGlobalDialog\(\)/g)).toHaveLength(1)
    expect(composer).not.toContain('renderDialog')
  })

  it('loads the protocol entry in an ordinary Node process', async () => {
    const protocol = await import(new URL('../lib/protocol.js', import.meta.url).href)
    expect(protocol.ANNOTATION_PROTOCOL_VERSION).toBe(2)
  })
})
