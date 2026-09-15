import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { writeFile } from 'node:fs/promises'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { canonicalJson, canonicalSha256 } from '../src/protocol/index.ts'
import { registerNativeContextTools } from '../src/host/native-context-tools.ts'
import type { NativeMaterial, NativeReleasePlan } from '../src/host/native-context-contract.ts'
import type { UpstreamToolBudgets } from '../src/host/upstream-budget.ts'

describe('native AgentLoop execution without a live model', () => {
  it.each(['status-first', 'direct-reference'] as const)('applies native release on the next generated request (%s)', async mode => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
    const materials = new Map<string, NativeMaterial>(), plans: NativeReleasePlan[] = [], receipts: any[] = []
    ctx.provide('maintenanceNativeContext' as never, { protocolVersion: 1, capabilities: { nativeSurface: true, tools: true },
      async request(_id: string, operation: string, input: any) {
        if (operation === 'materials-register') { for (const material of input.materials) materials.set(material.materialId, material); return { recorded: true } }
        if (operation === 'release-plans') return { items: plans, materials: [...materials.values()] }
        if (operation === 'release') plans.push({ operationId: input.operationId, materialIds: input.materialIds
          ?? [...materials.values()].filter(item => item.referenceIds.includes(input.referenceId)).map(item => item.materialId), state: 'pending-next-step' })
        if (operation === 'release-receipt') { receipts.push(input); plans.find(value => value.operationId === input.operationId)!.state = input.state }
        return { ownerSessionId: 'native-loop-test', revision: 1, sources: [], materials: [...materials.values()], operations: plans }
      } })
    const budget = { reserve: () => ({ executionId: 'test-turn', bytes: 4000, totalBytes: 24000, settle: () => {} }) } as unknown as UpstreamToolBudgets
    registerNativeContextTools(ctx, budget)
    const requests: GenerateOptions[] = []
    class ScriptedAdapter extends LlmAdapter {
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, contextWindow: 131072 } }
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        if (requests.length <= (mode === 'status-first' ? 2 : 1)) {
          const selected = [...materials.values()].find(value => value.ranges[0]?.eventId === 'answer')!
          if (requests.length === 2 && !selected) throw new Error('Initial source was not registered through the native input pipeline')
          const status = mode === 'status-first' && requests.length === 1
          const name = status ? 'dsh_context_status' : 'dsh_context_release'
          const id = ToolCallId(status ? 'status-call' : 'release-call')
          const args = JSON.stringify(status ? { section: 'materials' } : { operationId: 'loop-release', expectedRevision: 1,
            ...(mode === 'direct-reference' ? { referenceId: 'reference' } : { materialIds: [selected.materialId] }) })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'done' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    ctx.llm.registerAdapter(['native-test'], new ScriptedAdapter())
    const { agent } = await ctx.agents.create({ sessionId: SessionId('native-loop-test'), meta: { delegationDepth: 0 },
      agentOptions: { provider: 'native-test', model: 'script' } })
    const annotations = [{ number: 1, referenceId: 'reference', sourceType: 'dsh-message', selectedText: 'focus phrase', userComment: 'preserve this user request',
      locator: { sessionId: 'source' }, initialContext: { kind: 'selected-turn', sourceVersionId: 'v1', cutoffEventId: 'answer',
        items: [{ eventId: 'question', role: 'user', text: 'source question', offset: 0, complete: true },
          { eventId: 'answer', role: 'assistant', text: 'distinctive upstream body '.repeat(100), offset: 0, complete: true }],
        turnComplete: true, hasMore: false, nextCursor: null } }]
    const serialized = `<dsh-annotations version="1" set-id="set">\n${canonicalJson({ items: annotations })}\n</dsh-annotations>\n<dsh-reference-documents>\n${canonicalJson({ documents: [] })}\n</dsh-reference-documents>`
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Release the used answer body and keep my request.' }] })
    const context = createUserMessage({ source: { kind: 'dsh-annotation', schemaVersion: 1, setId: 'set', targetUserMessageId: user.id, count: 1,
      digest: canonicalSha256({ schemaVersion: 1, setId: 'set', annotations, documents: [] }) }, content: [{ type: 'text', text: serialized }] })
    const idle = new Promise<void>(resolve => { const off = ctx.on('agent/status', ({ agent: current, status }) => { if (current === agent && status === 'idle') { off(); resolve() } }) })
    agent.inject(context)
    agent.followup(user)
    await idle
    expect(requests).toHaveLength(mode === 'status-first' ? 3 : 2)
    expect(requests[0]!.tools?.some(tool => tool.name === 'dsh_context_release')).toBe(true)
    expect(JSON.stringify(requests[0]!.messages)).toContain('distinctive upstream body')
    if (mode === 'status-first') {
      expect(JSON.stringify(requests[1]!.messages)).toContain([...materials.values()].find(value => value.ranges[0]?.eventId === 'answer')!.materialId)
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain('source question')
    }
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain('distinctive upstream body')
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('preserve this user request')
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('Release the used answer body and keep my request.')
    const original = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === context.id)!
    expect(original.data).toEqual(context)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ state: 'applied', operationId: 'loop-release' })
    const releaseResult = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.source.callId === 'release-call')!
    expect(JSON.stringify(releaseResult.data)).toContain('pending-next-step')
    expect(ctx.tools.schemas().some(tool => tool.name === 'dsh_context_release')).toBe(false)
    if (mode === 'status-first' && process.env.DSH_NATIVE_CONTEXT_TEST_ARTIFACT) await writeFile(process.env.DSH_NATIVE_CONTEXT_TEST_ARTIFACT,
      JSON.stringify({ payload: { header: agent.session.header, events: agent.session.snapshotEvents(), inheritedEventCount: Number(agent.session.inheritedEventCount) },
        materials: [...materials.values()], receipt: receipts[0], operation: plans[0] }, null, 2), 'utf8')
  })
})
