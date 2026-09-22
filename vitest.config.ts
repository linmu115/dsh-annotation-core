import { defineConfig } from 'vitest/config'
import ts from 'typescript'

// Tests consume the pinned public DSH packages, never a sibling host checkout.
export default defineConfig({
  plugins: [{
    name: 'standard-decorators', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !/^\s*@[A-Za-z_$]/m.test(code)) return
      const result = ts.transpileModule(code, { fileName: file, compilerOptions: {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX, sourceMap: true,
      } })
      return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
    },
  }],
  test: { include: ['tests/**/*.test.{ts,tsx}'], exclude: ['tests/native-context-loop.test.ts'], testTimeout: 10000,
    execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [],
  },
})
