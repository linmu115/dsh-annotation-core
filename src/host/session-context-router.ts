import type { UpstreamHost } from './upstream.ts'

/** A removed managed provider never turns a running registered instance into an offline writer. */
export function sessionContextRouter(local: UpstreamHost, provider: () => UpstreamHost | undefined): UpstreamHost {
  let externalSeen = false
  return new Proxy(local, { get(target, key) {
    const external = provider()
    if (external) {
      if (external.protocolVersion !== 1) throw new Error('会话引用能力协议不兼容')
      externalSeen = true
    }
    if (!external && externalSeen) throw new Error('已接入的会话引用服务已断开；请恢复服务或正式解除注册后重启')
    const owner = external ?? target
    const value = Reflect.get(owner, key)
    return typeof value === 'function' ? value.bind(owner) : value
  } })
}
