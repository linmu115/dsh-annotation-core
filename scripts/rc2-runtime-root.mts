import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const RC2_VERSION = '0.1.1-rc.2'

interface RuntimePackage {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export function resolveRc2RuntimeRoot(): string {
  const configured = process.env.DSH_RC2_RUNTIME_ROOT?.trim()
  return configured ? resolve(configured) : resolve(import.meta.dirname, '..')
}

export async function assertRc2RuntimeRoot(
  runtimeRootInput: string,
  probeName: string,
): Promise<{ runtimeRoot: string; runtimePackage: RuntimePackage; runtimeVersion: string }> {
  const runtimeRoot = resolve(runtimeRootInput)
  const runtimePackage = JSON.parse(
    await readFile(join(runtimeRoot, 'package.json'), 'utf8'),
  ) as RuntimePackage
  const declaredVersion = runtimePackage.dependencies?.['@deepseek-ai/dsh']
    ?? runtimePackage.devDependencies?.['@deepseek-ai/dsh-agent']
  if (declaredVersion !== RC2_VERSION) {
    throw new Error(`${probeName}: expected the DSH ${RC2_VERSION} package set, received ${String(declaredVersion)}`)
  }

  const installedPackage = JSON.parse(
    await readFile(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), 'utf8'),
  ) as { version?: string }
  if (installedPackage.version !== RC2_VERSION) {
    throw new Error(`${probeName}: installed @deepseek-ai/dsh-agent is ${String(installedPackage.version)}`)
  }

  return { runtimeRoot, runtimePackage, runtimeVersion: RC2_VERSION }
}
