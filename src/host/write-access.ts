export interface SessionWriteContext {
  get(name: never): unknown
  inject?(names: string[], callback: () => void): unknown
}
const managed = new WeakSet<object>()
const observed = new WeakSet<object>()
export function observeSessionWriteAccess(ctx: SessionWriteContext): void {
  if (observed.has(ctx)) return
  observed.add(ctx)
  if (ctx.get('sessionWriteAccess' as never)) managed.add(ctx)
  ctx.inject?.(['sessionWriteAccess'], () => { managed.add(ctx) })
}
export async function assertSessionWritable(ctx: SessionWriteContext): Promise<void> {
  observeSessionWriteAccess(ctx)
  const policy = ctx.get('sessionWriteAccess' as never) as { assertWritable(): Promise<void> } | undefined
  if (policy) { managed.add(ctx); await policy.assertWritable(); return }
  if (managed.has(ctx)) throw new Error('已注册的会话写入服务已断开；请恢复服务或正式解除注册后重启')
}
