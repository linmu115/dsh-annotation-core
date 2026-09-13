import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AnnotationStore } from './store.ts'
import { availableReferenceSets } from './reference-tools.ts'
import { UpstreamToolBudgets } from './upstream-budget.ts'
import { upstreamHost, upstreamOf } from './upstream.ts'

interface ManagedRuntimeSupport {
  readonly apiVersion: number
  readonly managedTools: { exportTool(tool: ToolDefinition): () => void }
}

export function registerUpstreamTools(ctx: Context, store: AnnotationStore, budgets: UpstreamToolBudgets): void {
  // Removing the optional Maintenance capability removes only these tools.
  ctx.inject(['maintenanceSessionContext'], capability => {
    capability.inject(['tools'], toolCtx => {
      for (const search of [false, true]) {
        const tool = defineTool({
          name: search ? 'dsh_upstream_search' : 'dsh_upstream_read',
          description: search
            ? 'Search the fixed upstream of a submitted reference. Returns bounded excerpts and readCursor links. All reads/searches share this turn\'s budget.'
            : 'Read a submitted reference\'s fixed upstream, up to the selected completed AI reply. Use initialContext.nextCursor to continue an incomplete source turn or read earlier turns after a complete one. Without a cursor, read newest first. Later source turns are excluded. This read is already authorized; do not ask again. Never fetch all pages automatically.',
          parameters: {
            referenceId: { type: 'string', required: true },
            cursor: { type: 'string', description: 'A nextCursor from the same operation, or a readCursor from search for reading.' },
            ...(search ? { query: { type: 'string' as const, required: true as const } } : {}),
          },
          output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
          async execute(args, exec) {
            const agent = exec.agent
            if (!agent) throw new Error('A conversation is required')
            const set = availableReferenceSets(store, agent).find(candidate => candidate.items.some(item => item.referenceId === args.referenceId))
            const item = set?.items.find(item => item.referenceId === args.referenceId)
            const upstream = item && upstreamOf(item)
            if (!upstream || upstream.targetSessionId !== agent.session.id || set?.sessionId !== agent.session.id)
              throw new Error('当前轮次没有这个已提交的上游引用；未发送草稿和其它会话引用不可读取')
            if (search && (!args.query || args.query.length > 200)) throw new Error('搜索词需为 1 至 200 个字符')
            if (args.cursor && args.cursor.length > 2048) throw new Error('引用读取游标无效')
            const allowance = budgets.reserve(agent)
            let output: string | undefined
            try {
              const result = await upstreamHost(ctx).read({
                targetNativeSessionId: agent.session.id, referenceId: upstream.referenceId,
                executionId: allowance.executionId, maxBytes: allowance.bytes, totalBytes: allowance.totalBytes,
                ...(args.cursor ? { cursor: args.cursor } : {}), ...(search ? { query: args.query! } : {}),
              })
              exec.signal.throwIfAborted()
              if (!availableReferenceSets(store, agent).some(candidate => candidate.items.some(item => item.referenceId === args.referenceId)))
                throw new Error('引用在读取期间已撤销')
              output = JSON.stringify(result)
              return output
            } finally { allowance.settle(output) }
          },
        })
        toolCtx.tools.register(tool)
        // The optional runtime bridge requires the exact registered definition,
        // not just a name in its profile's managedTools list. Late loading and
        // capability removal follow this injection scope's normal disposal.
        toolCtx.inject(['dshRuntimeSupport'], runtimeCtx => {
          const runtime = runtimeCtx.get('dshRuntimeSupport' as never) as unknown as ManagedRuntimeSupport
          if (runtime.apiVersion !== 1 || typeof runtime.managedTools?.exportTool !== 'function') return
          runtimeCtx.effect(() => runtime.managedTools.exportTool(tool), `annotation-core.managed.${tool.name}`)
        })
      }
    })
  })
}
