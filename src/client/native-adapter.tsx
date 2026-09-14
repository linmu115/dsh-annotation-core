import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SubmitAttachment, CommandClaim } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

import type { Context } from '../context-types.ts'
import type { AnnotationCoreClientService } from './service.tsx'
import type { ComposerBinding } from './composer-binding.tsx'
import { annotationConversationDefinition } from './conversation-projection.tsx'
import { NativeClaimBindings } from './native-claim-bindings.ts'

const nativeClaims = new NativeClaimBindings()

interface NativeInput {
  beginCommand(claim: CommandClaim, span: { readonly start: number; readonly end: number; readonly draftRev: number }): boolean
}

interface NativeRailInjected {
  readonly core: AnnotationCoreClientService
  readonly nativeInput: NativeInput
}

type NativeRailProps = NativeRailInjected & {
  readonly sessionId: string
  readonly input: {
    readonly phase: string
    readonly draftRev: number
    readonly attachmentIds: readonly string[]
    readonly draft: string
  }
}

function NativeAnnotationRail(props: NativeRailProps) {
  const handle = useMemo<ComposerBinding>(
    () => props.core.bindComposer({ sessionId: String(props.sessionId), layout: 'default' }),
    [props.core, props.sessionId],
  )
  const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot)

  useEffect(() => () => handle.dispose(), [handle])
  useEffect(() => nativeClaims.register(props.nativeInput, String(props.sessionId), handle), [props.nativeInput, props.sessionId, handle])
  useEffect(()=>props.core.registerNativeComposer(String(props.sessionId)),[props.core,props.sessionId])
  useEffect(() => {
    if (snapshot.pendingCount === 0 || snapshot.transport !== 'native-command-claim' || props.input.phase !== 'plain') return
    const claim: CommandClaim = {
      token: '',
      attachments: true,
      submit: (text: string, _actx: unknown, attachments: readonly SubmitAttachment[]) => nativeClaims.submit(props.nativeInput, String(props.sessionId), text, attachments),
    }
    props.nativeInput.beginCommand(claim, { start: 0, end: 0, draftRev: props.input.draftRev })
  }, [handle, props.input.draftRev, props.input.phase, props.nativeInput, snapshot.pendingCount, snapshot.transport])

  return <>
    {handle.renderReferenceRail()}
    {snapshot.pendingCount > 0 && props.input.attachmentIds.length > 0 && props.input.draft.trim().length === 0
      ? <div className="dshAnnotationBlocked" role="status">先输入正文</div>
      : null}
  </>
}

interface AnnotationNodeProps {
  readonly core: AnnotationCoreClientService
  readonly sessionId: string
  readonly node: unknown
}

function AnnotationNodeView(props: AnnotationNodeProps) {
  const rendered = props.core.renderConversationNode({ sessionId: String(props.sessionId), node: props.node, layout: 'default' })
  return rendered?.node ?? null
}

interface AlphaClientContext {
  readonly sessions: {
    readonly list: { getSnapshot(): { readonly current?: string } }
    binding(id: string): { readonly ctx: { get(name: string): unknown } } | undefined
  }
  readonly conversation: { readonly input: { for(ctx: unknown): NativeInput } }
  readonly uiConversation: { readonly events: { register(definition: unknown): () => void } }
  readonly slots: {
    inject(name: string, register: () => (() => void) | void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

function alphaClient(ctx: Context): AlphaClientContext {
  return ctx as unknown as AlphaClientContext
}

function clientSessions(ctx: Context): AlphaClientContext['sessions'] {
  return alphaClient(ctx).sessions
}

function clientConversation(ctx: Context): AlphaClientContext['conversation'] {
  return alphaClient(ctx).conversation
}

function requireBinding(ctx: Context, sessionId: string) {
  const binding = clientSessions(ctx).binding(sessionId)
  if (binding === undefined) throw new Error(`Annotation core could not resolve session ${JSON.stringify(sessionId)}`)
  return binding
}

function installFragmentCapture(ctx: Context): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
      if (anchor === null) return
      const href = anchor.getAttribute('href')
      if (href === null || !href.startsWith('#dsh-annotation-')) return
      const sessions = clientSessions(ctx)
      const sessionId = sessions.list.getSnapshot().current
      if (sessionId === undefined) return
      const binding = sessions.binding(sessionId)
      const core = binding?.ctx.get('annotationCore') as AnnotationCoreClientService | undefined
      if (core === undefined || !core.handleAnswerLink(String(sessionId), href)) return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  })
}

/** Register the annotation surfaces against the native DSH Conversation services. */
export function applyNativeClient(ctx: Context): void {
  const client = alphaClient(ctx)
  client.uiConversation.events.register(annotationConversationDefinition)

  client.slots.inject('conversation.input.dock', () => client.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-annotation-core',
    order: 20,
    inject: (sessionId: string) => {
      const binding = requireBinding(ctx, sessionId)
      return {
        core: binding.ctx.get('annotationCore') as AnnotationCoreClientService,
        nativeInput: clientConversation(ctx).input.for(binding.ctx),
      }
    },
  }, NativeAnnotationRail))

  client.slots.inject('conversation.chat.node', () => client.slots.register({
    name: 'conversation.chat.node',
    key: 'dsh-annotation',
    inject: (sessionId: string) => ({
      core: requireBinding(ctx, sessionId).ctx.get('annotationCore') as AnnotationCoreClientService,
    }),
  }, AnnotationNodeView))

  installFragmentCapture(ctx)
}
