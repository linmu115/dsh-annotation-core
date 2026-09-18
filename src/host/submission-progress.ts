import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubmissionResult } from './submit-annotated.ts'

/** Optional presentation owner. Never changes admission, budget or reference ordering. */
export async function withSubmissionProgress(ctx: Context, agent: Agent,
  input: { clientSubmissionId: string; text: string }, signal: AbortSignal,
  submit: () => Promise<SubmissionResult>): Promise<SubmissionResult> {
  const owner = ctx.get('gptSubmissionProgress' as never) as undefined | {
    begin(agent: Agent, input: { clientSubmissionId: string; text: string }): undefined | { finish(result: { kind: string; message?: string; userMessageId?: string }): void }
  }
  let progress: ReturnType<NonNullable<typeof owner>['begin']>
  try { progress = owner?.begin(agent, input) } catch { /* Optional UI cannot reject a submission. */ }
  const finish = (result: { kind: string; message?: string; userMessageId?: string }) => {
    try { progress?.finish(result) } catch { /* Preserve the authoritative admission outcome. */ }
  }
  try {
    const result = await submit()
    finish(result)
    return result
  } catch (error) {
    finish({ kind: signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
