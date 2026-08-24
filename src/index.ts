import type { Context } from './context-types.ts'

export const name = 'dsh-annotation-core'

export interface Config {
  profileId: string
}

export function apply(_ctx: Context, _config: Config): void {
  // Task 1 establishes only the verified rc.2 adapter boundary.
}
