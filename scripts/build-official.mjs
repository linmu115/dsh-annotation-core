import { cp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..'), stage = join(root, '.artifacts/r2-official-build')
await mkdir(stage, { recursive: true })
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const dependencies = { ...pkg.devDependencies, ...pkg.dependencies }
if (Object.values(dependencies).some(value => /^(link:|workspace:)/.test(value))) throw new Error('Official build cannot use host workspace aliases')
const manifest = JSON.stringify({ name: 'annotation-official-build', private: true, type: 'module', dependencies })
let previous
try { previous = await readFile(join(stage, 'package.json'), 'utf8') } catch {}
const run = (command, args, shell = false) => {
  const result = spawnSync(command, args, { cwd: stage, stdio: 'inherit', shell })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (manifest !== previous) {
  await writeFile(join(stage, 'package.json'), manifest)
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'], process.platform === 'win32')
}
for (const name of Object.keys(dependencies).filter(name => name.startsWith('@deepseek-ai/'))) {
  const path = await realpath(join(stage, 'node_modules', name))
  if (relative(stage, path).startsWith('..')) throw new Error(`Dependency leaves official build directory: ${name}`)
}
await cp(join(root, 'src'), join(stage, 'src'), { recursive: true })
for (const file of ['tsconfig.json', 'tsconfig.build.json', 'tsdown.config.ts']) await cp(join(root, file), join(stage, file))
run(process.execPath, [join(stage, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'])
run(process.execPath, [join(stage, 'node_modules/tsdown/dist/run.mjs'), '--config-loader', 'unrun', '--config', 'tsdown.config.ts'])
await cp(join(stage, 'lib'), join(root, 'lib'), { recursive: true })
