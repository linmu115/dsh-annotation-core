import type { ComposerBinding } from './composer-binding.tsx'

/** Native command claims may outlive the React rail that first installed them. */
export class NativeClaimBindings {
  private readonly bindings = new WeakMap<object, { sessionId: string; handle: ComposerBinding }>()

  register(input: object, sessionId: string, handle: ComposerBinding): () => void {
    const entry = { sessionId, handle }
    this.bindings.set(input, entry)
    return () => { if (this.bindings.get(input) === entry) this.bindings.delete(input) }
  }

  submit(input: object, sessionId: string, ...args: Parameters<ComposerBinding['submitClaim']>): ReturnType<ComposerBinding['submitClaim']> {
    const current = this.bindings.get(input)
    if (!current || current.sessionId !== sessionId) {
      return Promise.resolve({ kind: 'error', text: '会话输入框已切换，请在当前会话重新发送' })
    }
    return current.handle.submitClaim(...args)
  }
}
