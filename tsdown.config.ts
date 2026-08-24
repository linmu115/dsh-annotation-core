import type { UserConfig } from 'tsdown'

const pluginId = 'dsh-annotation-core'

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
      neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
