import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'
export default defineConfig({ ...base, test: { ...base.test, include: ['tests/native-context-loop.test.ts'], exclude: [] } })
