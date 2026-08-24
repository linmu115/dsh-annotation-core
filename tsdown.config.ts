import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'

const pluginId = 'dsh-annotation-core'
const CSS_PREFIX = '\0dsh-annotation-css:'
const CSS_SUFFIX = '.mjs'

type BuildPlugin = NonNullable<UserConfig['plugins']>

function inlineCss(): BuildPlugin {
  return {
    name: 'dsh-annotation-inline-css',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.css')) return null
      const absolute = importer === undefined ? resolvePath(source) : resolvePath(dirname(importer), source)
      return `${CSS_PREFIX}${absolute}${CSS_SUFFIX}`
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const filename = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(filename)
      const css = await readFile(filename, 'utf8')
      const tagId = `${pluginId}/styles`
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
        `  tag.dataset.pluginCss = tagId;`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        `export default '';`,
      ].join('\n')
    },
  }
}

export default [
  {
    entry: {
      index: 'src/index.ts',
      protocol: 'src/protocol/index.ts',
      typert: 'src/remote/typert.ts',
      remote: 'src/remote/client.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
  },
  {
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      alwaysBundle: ['zod'],
      neverBundle: [
        'react',
        'react/jsx-runtime',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-runtime/client',
      ],
    },
    plugins: [inlineCss()],
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
