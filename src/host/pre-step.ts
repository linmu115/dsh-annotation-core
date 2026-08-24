import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

import { createAnnotationContextMessage, journalForDirectUser } from './commit-journal.ts'
import type { AnnotationStore } from './store.ts'

export interface AnnotationPreStepPayload {
  readonly agent: Agent
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** ID-bound transformation; pending state alone can never inject or consume context. */
export async function annotationPreStep(
  store: AnnotationStore,
  payload: AnnotationPreStepPayload,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  const knownIds = new Set(decision.messages.map((message) => message.id))
  const messages: UserMessage[] = []
  let changed = false
  for (const message of decision.messages) {
    messages.push(message)
    const journal = journalForDirectUser(store, payload.agent.id, message)
    if (journal === undefined) continue
    const context = createAnnotationContextMessage(payload.agent.id, journal)
    if (knownIds.has(context.id)) continue
    messages.push(context)
    knownIds.add(context.id)
    changed = true
  }
  return changed ? { kind: 'enter', messages } : decision
}

export function registerAnnotationPreStep(ctx: Context, store: AnnotationStore): () => boolean {
  return ctx.on('agent/pre-step', (payload, next) => annotationPreStep(store, payload, next))
}
