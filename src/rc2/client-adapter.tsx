import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CommandClaim, SubmitImageAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

import type { Context } from '../context-types.ts'
import type { AnnotationCoreClientService } from '../client/service.tsx'
import type { ComposerBinding } from '../client/composer-binding.tsx'
import { annotationConversationDefinition } from './conversation-projection.tsx'

interface NativeInput {
  beginCommand(claim: CommandClaim, span: { readonly start: number; readonly end: number; readonly draftRev: number }): boolean
}

interface NativeRailInjected {
  readonly core: AnnotationCoreClientService
  readonly nativeInput: NativeInput
}

type NativeRailProps = PropsRuntime<'conversation.input.dock'> & NativeRailInjected

function NativeAnnotationRail(props: NativeRailProps) {
  const handle = useMemo<ComposerBinding>(
    () => props.core.bindComposer({ sessionId: String(props.sessionId), layout: 'default' }),
    [props.core, props.sessionId],
  )
  const snapshot = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot)

  useEffect(() => () => handle.dispose(), [handle])
  useEffect(() => {
    if (snapshot.pendingCount === 0 || snapshot.transport !== 'native-command-claim' || props.input.phase !== 'plain') return
    const claim: CommandClaim = {
      token: '',
      images: true,
      submit: (text: string, _actx: unknown, images: readonly SubmitImageAttachment[]) => handle.submitClaim(text, images),
    }
    props.nativeInput.beginCommand(claim, { start: 0, end: 0, draftRev: props.input.draftRev })
  }, [handle, props.input.draftRev, props.input.phase, props.nativeInput, snapshot.pendingCount, snapshot.transport])

  return <>
    {handle.renderReferenceRail()}
    {snapshot.pendingCount > 0 && props.input.imageIds.length > 0 && props.input.draft.trim().length === 0
      ? <div className="dshAnnotationBlocked" role="status">先输入正文</div>
      : null}
  </>
}

interface AnnotationNodeProps {
  readonly core: AnnotationCoreClientService
  readonly sessionId: SessionId
  readonly node: unknown
}

function AnnotationNodeView(props: AnnotationNodeProps) {
  const rendered = props.core.renderConversationNode({ sessionId: String(props.sessionId), node: props.node, layout: 'default' })
  return rendered?.node ?? null
}

function clientSessions(ctx: Context): ISessions {
  return (ctx as unknown as { sessions: ISessions }).sessions
}

function clientConversation(ctx: Context): IConversation {
  return (ctx as unknown as { conversation: IConversation }).conversation
}

function requireBinding(ctx: Context, sessionId: SessionId) {
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

/** Official DSH 0.1.1-rc.2 adapter. All version-specific seams stay in this module. */
export function applyRc2ClientAdapter(ctx: Context): void {
  ctx.conversationEvents.register(annotationConversationDefinition)

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-annotation-core',
    order: 20,
    inject: (sessionId) => {
      const binding = requireBinding(ctx, sessionId)
      return {
        core: binding.ctx.get('annotationCore') as AnnotationCoreClientService,
        nativeInput: clientConversation(ctx).input.for(binding.ctx),
      }
    },
  }, NativeAnnotationRail))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'dsh-annotation',
    inject: (sessionId) => ({
      core: requireBinding(ctx, sessionId).ctx.get('annotationCore') as AnnotationCoreClientService,
    }),
  }, AnnotationNodeView))

  installFragmentCapture(ctx)
}
