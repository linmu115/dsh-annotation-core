import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Optional versioned Host contract; credentials and execution scope never enter model arguments. */
export interface NativeContextHost {
  readonly protocolVersion: 1
  readonly capabilities: { readonly nativeSurface: true; readonly tools: true }
  request<T = unknown>(nativeSessionId: string, operation: string, input: object, signal?: AbortSignal): Promise<T>
}
export interface NativeMaterial {
  materialId: string
  eventSeq: number
  referenceIds: string[]
  kind: 'initial' | 'read' | 'search' | 'requests'
  bytes: number
  contentHash: string
  ranges: { referenceId: string; eventId: string; start: number; end: number }[]
  sourceEventSeqs?: number[]
}
export interface NativeReleasePlan {
  operationId: string
  materialIds: string[]
  state: string
}
export function nativeContextHost(ctx: Context): NativeContextHost | undefined {
  const host = ctx.get('sessionNativeContext' as never) as unknown as NativeContextHost | undefined
  return host?.protocolVersion === 1 && host.capabilities?.nativeSurface === true && host.capabilities.tools === true ? host : undefined
}
export function isNativeContextAgent(agent: Agent): boolean {
  const provider = agent.options?.provider ?? agent.session.requestContext()?.provider
  // The deployed managed route is codex. An unresolved provider is not evidence of a native request.
  return typeof provider === 'string' && provider.length > 0 && provider !== 'codex'
}
export function requireNativeContextAgent(agent: Agent | undefined): Agent {
  if (!agent || !isNativeContextAgent(agent)) throw new Error('Native DSH execution is required; managed context release is unsupported')
  return agent
}
