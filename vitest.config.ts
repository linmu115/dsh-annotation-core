import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { standardDecoratorPlugin, vitestExecArgv } from '../deepseek-harness/vitest.shared.ts'

const host = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const paths = ts.readConfigFile(resolve(host, 'tsconfig.base.json'), ts.sys.readFile).config.compilerOptions.paths as Record<string, string[]>
// The sibling host's default include does not cover this plugin. Explicit exact
// aliases resolve both trees to one source module graph in unit tests.
const alias = Object.entries(paths).filter(([name]) => !name.includes('*')).map(([name, targets]) => ({
  find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: resolve(host, targets[0]!),
}))
export default defineConfig({
  resolve: { alias },
  plugins: [standardDecoratorPlugin()],
  test: { include: ['tests/**/*.test.ts'], execArgv: vitestExecArgv, testTimeout: 10000 },
})
