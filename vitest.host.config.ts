import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import { resolve } from 'node:path'
import base from './vitest.config.ts'
const host = process.env.DSH_HOST_SOURCE
if (!host) throw new Error('Set DSH_HOST_SOURCE to a prepared host checkout with the native context extension')
const result = ts.readConfigFile(resolve(host, 'tsconfig.base.json'), ts.sys.readFile)
if (result.error) throw new Error('Cannot read DSH_HOST_SOURCE/tsconfig.base.json')
const paths = result.config.compilerOptions.paths as Record<string, string[]>
const alias = Object.entries(paths).filter(([name]) => !name.includes('*')).map(([find, targets]) => ({ find, replacement: resolve(host, targets[0]!) }))
export default defineConfig({ ...base, resolve: { alias }, test: { ...base.test, include: ['tests/native-context-loop.test.ts'], exclude: [] } })
