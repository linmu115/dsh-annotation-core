import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as cordis from '@deepseek-ai/cordis'
import { Context, Service } from '@deepseek-ai/cordis'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import * as uiSlots from '@deepseek-ai/dsh-client-ui-slots'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { Storage } from '@deepseek-ai/dsh-storage'
import { apply as applyStorageDomain, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { apply as applyStorageJson } from '@deepseek-ai/dsh-storage-json'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyTypertLoader } from '@deepseek-ai/dsh-typert-loader'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { z } from 'zod'

interface ProjectionProbe {
  builtInAndCoreDefinitionsMounted: boolean
  contextKeyMatchesExactGenericRow: boolean
  onlyExactGenericRowHidden: boolean
  coreNodeKeepsContextSeq: boolean
  disposeRestoresGenericRow: boolean
}

interface AgentProbe {
  hostMessageIdReachedPreStep: boolean
  unrelatedMessageDidNotMatch: boolean
  rejectDecisionWasPreserved: boolean
  deliveryWasNextTurnWakeup: boolean
}

interface HostProbe {
  storageRoundTripSurvivedCloseAndReopen: boolean
  attachmentRoundTripWasDurable: boolean
  invalidBase64WasRejectedBeforeWrite: boolean
  typertLoaderRegisteredFixture: boolean
  clientMountedFixtureAndUnwrappedRoundTrip: boolean
}

interface InputProbe {
  zeroLengthClaimPreservedDraftDomCopyAndA11y: boolean
  imeDraftWasNotPolluted: boolean
  errorKeptDraftAndRealImages: boolean
  nativeReferenceStillProducedVisibleMention: boolean
  plainPassThroughLatchScope: 'not-implemented-until-task-4'
}

interface SafetyProbe {
  runtimeTreeChanges: string[]
  liveWebChanges: string[]
  temporaryRootsAfterCleanup: string[]
}

export interface Rc2DynamicProbeResult {
  projection: ProjectionProbe
  agent: AgentProbe
  host: HostProbe
  input: InputProbe
  safety: SafetyProbe
}

interface ClientBundleDefinition {
  id: string
  factory(require: (id: string) => unknown): Record<string, unknown>
}

interface ClientRuntimeExports {
  ConversationEventRegistry: new (ctx: Context) => {
    register(definition: Record<string, unknown>): () => void
    entries(): readonly Record<string, unknown>[]
    fallbackEntry(): Record<string, unknown> | undefined
  }
  ConversationViewRegistry: new (ctx: Context) => {
    register(definition: Record<string, unknown>): () => void
    entries(): readonly Record<string, unknown>[]
  }
  ConversationNodeAssembler: new (
    events: Record<string, unknown>,
    views: Record<string, unknown>,
  ) => {
    replaceWindow(entries: readonly unknown[], hasMore: boolean): string
    flush(): boolean
    snapshot(target: string): unknown
  }
  conversationContextKey(kind: string, id: string): string
}

interface SessionInputShellLike {
  setDraft(text: string): void
  addImages(ids: readonly string[]): boolean
  beginCommand(claim: Record<string, unknown>, span: Record<string, number>): boolean
  insertReference(reference: Record<string, unknown>, span: Record<string, number>): boolean
  submit(mode?: 'queue' | 'steer'): void
  dispose(): void
  readonly snapshot: {
    readonly draft: string
    readonly draftRev: number
    readonly phase: string
    readonly imageIds: readonly string[]
  }
}

interface ConversationProbeExports {
  __ProbeSessionInputShell: new (deps: Record<string, unknown>) => SessionInputShellLike
  __ProbeProjectClipboard(state: Record<string, unknown>): string
  __ProbeMessageDefinition: Record<string, unknown>
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const cache = new Map<string, Promise<Rc2DynamicProbeResult>>()

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function collectTreeEntries(root: string): Promise<Array<{ path: string; relativePath: string; link: boolean }>> {
  if (!(await exists(root))) return []
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  const output = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => {
      const parentPath = (entry as typeof entry & { parentPath: string }).parentPath
      const path = join(parentPath, entry.name)
      return {
        path,
        relativePath: relative(root, path).replaceAll('\\', '/'),
        link: entry.isSymbolicLink(),
      }
    })
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function needsByteHash(relativePath: string): boolean {
  return relativePath === 'package.json' ||
    /(^|\/)(package|pnpm-lock|package-lock|cordis|config)\.(json|ya?ml)$/.test(relativePath) ||
    /(^|\/)lib\/(client|index)\.js$/.test(relativePath)
}

async function hashTree(root: string): Promise<Map<string, string>> {
  const entries = await collectTreeEntries(root)
  const result = new Map<string, string>()
  const concurrency = 128
  for (let index = 0; index < entries.length; index += concurrency) {
    const slice = entries.slice(index, index + concurrency)
    const hashes = await Promise.all(
      slice.map(async (entry) => {
        if (entry.link) return [entry.relativePath, `link:${await readlink(entry.path)}`] as const
        const info = await stat(entry.path)
        const metadata = `${info.size}:${info.mtimeMs}:${info.mode}`
        if (!needsByteHash(entry.relativePath)) return [entry.relativePath, `metadata:${metadata}`] as const
        return [entry.relativePath, `content:${metadata}:${sha256(await readFile(entry.path))}`] as const
      }),
    )
    for (const [path, hash] of hashes) result.set(path, hash)
  }
  return result
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths]
    .filter((path) => before.get(path) !== after.get(path))
    .sort((left, right) => left.localeCompare(right))
}

async function evaluateClientBundle(
  file: string,
  requires: Readonly<Record<string, unknown>>,
  transform: (source: string) => string = (source) => source,
): Promise<Record<string, unknown>> {
  const source = transform(await readFile(file, 'utf8'))
  let loaded: Record<string, unknown> | undefined
  const browser = {
    __ModuleLoader__: {
      load(definition: ClientBundleDefinition): void {
        loaded = definition.factory((id) => {
          if (!(id in requires)) throw new Error(`dynamic rc.2 probe: unmapped client module ${id}`)
          return requires[id]
        })
      },
    },
  }
  const execute = new Function('window', source)
  execute(browser)
  if (loaded === undefined) throw new Error(`dynamic rc.2 probe: ${file} did not register a module`)
  return loaded
}

async function loadRuntimeClient(runtimeRoot: string): Promise<ClientRuntimeExports> {
  return (await evaluateClientBundle(
    join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-runtime', 'lib', 'client.js'),
    {
      '@deepseek-ai/cordis': cordis,
      '@deepseek-ai/dsh-client-ui-slots': uiSlots,
    },
  )) as unknown as ClientRuntimeExports
}

async function loadConversationProbe(runtimeRoot: string, runtime: ClientRuntimeExports): Promise<ConversationProbeExports> {
  const file = join(
    runtimeRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-client-ui-conversation',
    'lib',
    'client.js',
  )
  const exports = await evaluateClientBundle(
    file,
    {
      '@deepseek-ai/cordis': cordis,
      '@deepseek-ai/dsh-client-runtime/client': runtime,
      '@deepseek-ai/dsh-client-ui-primitives': {},
      '@deepseek-ai/dsh-client-ui-slots': uiSlots,
      react: React,
      'react/jsx-runtime': jsxRuntime,
    },
    (source) => {
      const marker = 'return module.exports;'
      if (!source.includes(marker)) throw new Error('dynamic rc.2 probe: conversation bundle return changed')
      return source.replace(
        marker,
        'exports.__ProbeSessionInputShell = SessionInputShell; exports.__ProbeProjectClipboard = projectClipboard; exports.__ProbeMessageDefinition = messageDefinition; return module.exports;',
      )
    },
  )
  return exports as unknown as ConversationProbeExports
}

function makeConversationDefinition(kind: 'input-message' | 'dsh-annotation') {
  return {
    kind,
    target: 'chat',
    match(event: Record<string, unknown>) {
      if (event.type !== 'user/message') return null
      const message = event.data as { id?: string; source?: { kind?: string; plugin?: string } }
      if (message.source?.kind !== 'plugin' || message.source.plugin !== 'dsh-annotation-core') return null
      return { id: message.id, role: 'start' }
    },
    start(_context: unknown, match: Record<string, unknown>) {
      const event = match.event as { seq: number }
      return { seq: event.seq }
    },
    update(context: { state: { seq: number } }) {
      return context.state
    },
    buildViewNode(context: {
      key: string
      id: string
      start?: { event: { seq: number }; location: unknown }
      state?: { seq: number }
    }) {
      if (context.start === undefined || context.state === undefined) return null
      return {
        key: context.key,
        kind,
        id: context.id,
        target: 'chat',
        data: { probe: true },
        anchorSeq: context.state.seq,
        location: context.start.location,
        visibility: 'visible',
      }
    },
  }
}

async function probeProjection(runtimeRoot: string): Promise<ProjectionProbe> {
  const runtime = await loadRuntimeClient(runtimeRoot)
  const conversation = await loadConversationProbe(runtimeRoot, runtime)
  const ctx = new Context()
  const events = new runtime.ConversationEventRegistry(ctx)
  const views = new runtime.ConversationViewRegistry(ctx)
  const disposeGeneric = events.register(conversation.__ProbeMessageDefinition)
  const disposeCore = events.register(makeConversationDefinition('dsh-annotation'))
  const disposeView = views.register({
    target: 'chat',
    create() {
      return {
        empty: [] as unknown[],
        replace(input: { nodes: readonly unknown[] }) {
          return [...input.nodes]
        },
        apply(input: { upserts: readonly unknown[] }) {
          return [...input.upserts]
        },
      }
    },
  })

  try {
    const sessionId = SessionId(`annotation-projection-${randomUUID()}`)
    const session = (await import('@deepseek-ai/dsh-session')).Session.create(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: '<dsh-annotations>{}</dsh-annotations>' }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-annotation-core',
        form: 'notice',
        summary: '1 annotation',
      },
    })
    const event = session.append('user/message', message, { surfaceOp: 'append' })
    const assembler = new runtime.ConversationNodeAssembler(
      events as unknown as Record<string, unknown>,
      views as unknown as Record<string, unknown>,
    )
    assembler.replaceWindow([{ event, view: undefined }], false)
    assembler.flush()
    const nodes = assembler.snapshot('chat') as Array<{
      key: string
      kind: string
      anchorSeq: number
    }>
    const genericKey = runtime.conversationContextKey('input-message', message.id)
    const coreKey = runtime.conversationContextKey('dsh-annotation', message.id)
    const genericNode = nodes.find((node) => node.key === genericKey)
    const coreNode = nodes.find((node) => node.key === coreKey)

    const dom = new JSDOM('<main id="rows"></main>')
    const document = dom.window.document
    const list = document.querySelector('#rows')
    if (!(list instanceof dom.window.HTMLElement)) throw new Error('dynamic rc.2 probe: no row list')
    for (const node of [genericNode, coreNode]) {
      if (node === undefined) continue
      const row = document.createElement('section')
      row.dataset.chatAnchorKey = node.key
      row.dataset.chatFlowKind = node.kind
      row.dataset.seq = String(node.anchorSeq)
      list.append(row)
    }
    const unrelated = document.createElement('section')
    unrelated.dataset.chatAnchorKey = runtime.conversationContextKey('input-message', 'unrelated')
    unrelated.dataset.chatFlowKind = 'input-message'
    list.append(unrelated)

    const exact = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')].find(
      (row) => row.dataset.chatAnchorKey === genericKey,
    )
    if (exact === undefined) {
      throw new Error(`dynamic rc.2 probe: exact generic row missing (${genericKey}; ${JSON.stringify(nodes)})`)
    }
    const previousDisplay = exact.style.display
    exact.style.display = 'none'
    const hiddenRows = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')].filter(
      (row) => row.style.display === 'none',
    )
    const contextKeyMatchesExactGenericRow = exact.dataset.chatAnchorKey === genericKey
    const onlyExactGenericRowHidden = hiddenRows.length === 1 && hiddenRows[0] === exact && unrelated.style.display === ''
    exact.style.display = previousDisplay

    return {
      builtInAndCoreDefinitionsMounted:
        events.entries().some((definition) => definition.kind === 'input-message') &&
        events.entries().some((definition) => definition.kind === 'dsh-annotation') &&
        genericNode !== undefined &&
        coreNode !== undefined,
      contextKeyMatchesExactGenericRow,
      onlyExactGenericRowHidden,
      coreNodeKeepsContextSeq:
        genericNode !== undefined && coreNode !== undefined && genericNode.anchorSeq === coreNode.anchorSeq,
      disposeRestoresGenericRow: exact.style.display === previousDisplay,
    }
  } finally {
    disposeView()
    disposeCore()
    disposeGeneric()
  }
}

async function probeAgent(): Promise<AgentProbe> {
  const ctx = new Context()
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new LlmRuntime(ctx)
  new ToolRuntime(ctx)
  const loop = new AgentLoop(ctx, { agents: [] })
  const agent = loop.create(SessionId(`annotation-agent-${randomUUID()}`), {
    provider: 'probe',
    model: 'probe',
  })
  const journal = new Map<string, ReturnType<typeof createUserMessage>>()
  let forceReject = false
  let wakeDeliveryObserved = false

  const disposeCore = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const context = payload.messages.map((message) => journal.get(message.id)).find(Boolean)
    return context === undefined ? decision : { ...decision, messages: [...decision.messages, context] }
  })
  const disposeTerminal = ctx.on('agent/pre-step', async (payload, next) => {
    if (forceReject) {
      wakeDeliveryObserved ||= payload.messages.some((message) => message.content.some(
        (block) => block.type === 'text' && block.text === 'Wake probe.',
      ))
      return { kind: 'reject' as const }
    }
    return next()
  })

  try {
    const source = createUserMessage({
      content: [{ type: 'text', text: 'Matched prompt.' }],
      source: { kind: 'user' },
    })
    const context = createUserMessage({
      content: [{ type: 'text', text: '<dsh-annotations>matched</dsh-annotations>' }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-annotation-core',
        form: 'notice',
        summary: '1 annotation',
      },
    })
    journal.set(source.id, context)
    agent.send(source, 'next-turn', false)
    const claimed = agent.inbox.claim('next-turn', 1)
    const dispatcher = agentEvents(ctx, agent)
    const accepted = await dispatcher.waterfall(
      'agent/pre-step',
      { messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed }),
    )

    const unrelated = createUserMessage({
      content: [{ type: 'text', text: 'Unrelated prompt.' }],
      source: { kind: 'user' },
    })
    agent.send(unrelated, 'next-turn', false)
    const unrelatedClaim = agent.inbox.claim('next-turn', 2)
    const unrelatedDecision = await dispatcher.waterfall(
      'agent/pre-step',
      { messages: unrelatedClaim, turn: 2, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: unrelatedClaim }),
    )

    forceReject = true
    const rejected = await dispatcher.waterfall(
      'agent/pre-step',
      { messages: [source], turn: 3, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [source] }),
    )

    const wake = createUserMessage({
      content: [{ type: 'text', text: 'Wake probe.' }],
      source: { kind: 'user' },
    })
    agent.send(wake, 'next-turn', true)
    await agent.whenIdle()

    return {
      hostMessageIdReachedPreStep:
        accepted.kind === 'enter' &&
        accepted.messages[0]?.id === source.id &&
        accepted.messages.at(-1)?.id === context.id,
      unrelatedMessageDidNotMatch:
        unrelatedDecision.kind === 'enter' &&
        unrelatedDecision.messages.length === 1 &&
        unrelatedDecision.messages[0]?.id === unrelated.id,
      rejectDecisionWasPreserved: rejected.kind === 'reject',
      deliveryWasNextTurnWakeup: wakeDeliveryObserved && agent.status === 'idle',
    }
  } finally {
    disposeTerminal()
    disposeCore()
    agent.cancel({ kind: 'disposed' })
    await agent.whenIdle()
  }
}

async function probeStorageAndAttachment(tempRoot: string): Promise<Pick<HostProbe,
  | 'storageRoundTripSurvivedCloseAndReopen'
  | 'attachmentRoundTripWasDurable'
  | 'invalidBase64WasRejectedBeforeWrite'>> {
  const storageRoot = join(tempRoot, 'profile-web', 'storage')
  const storageCtx = new Context()
  new Storage(storageCtx)
  applyStorageJson(storageCtx, { root: storageRoot })
  await applyStorageDomain(storageCtx, { backend: 'json' })
  const spec = defineDomain({
    name: 'annotation_probe',
    version: 1,
    tables: { records: domainTable<string, { value: string }>(z.object({ value: z.string() })) },
  })
  const first = await storageCtx.storage.domain.open(spec)
  await first.table('records').put('probe', { value: 'durable' })
  await first.close()
  const second = await storageCtx.storage.domain.open(spec)
  const reopened = second.table('records').get('probe')
  await second.close()

  const attachmentCtx = new Context()
  const store = new LocalAttachmentStore(attachmentCtx, { dshHome: join(tempRoot, 'profile-web') })
  const refs = await admitEncodedImages(store, [{ mediaType: 'image/png', data: PNG_BASE64, name: 'probe.png' }])
  const stored = refs[0] === undefined ? undefined : await store.readImage(refs[0])
  const filesBeforeInvalid = await collectTreeEntries(join(tempRoot, 'profile-web', 'attachments'))
  let invalidRejected = false
  try {
    await admitEncodedImages(store, [{ mediaType: 'image/png', data: 'not-valid-base64***', name: 'invalid.png' }])
  } catch {
    invalidRejected = true
  }
  const filesAfterInvalid = await collectTreeEntries(join(tempRoot, 'profile-web', 'attachments'))

  return {
    storageRoundTripSurvivedCloseAndReopen: reopened?.value === 'durable',
    attachmentRoundTripWasDurable:
      refs.length === 1 && stored !== undefined && stored.data.byteLength > 0 && refs[0]?.bytes === stored.data.byteLength,
    invalidBase64WasRejectedBeforeWrite:
      invalidRejected && filesAfterInvalid.length === filesBeforeInvalid.length,
  }
}

function typertFixtureSource(zodUrl: string): string {
  return `import { z } from ${JSON.stringify(zodUrl)}\n\n` +
    `const stringCodec = { mode: 'strict', typeSymbol: 'string', schema: z.string() }\n` +
    `export const TYPERT = {\n` +
    `  package: 'dsh-annotation-core-rc2-probe-fixture',\n` +
    `  face: 'host',\n` +
    `  schemas: [],\n` +
    `  model: { services: [], events: [], objects: [] },\n` +
    `  invocations: [{\n` +
    `    id: 'probe-echo', service: 'probeEcho', namespace: 'probe', method: 'echo',\n` +
    `    invocation: { kind: 'direct' },\n` +
    `    parameters: [{ name: 'value', wire: 'value', source: 'json', codec: stringCodec }],\n` +
    `    result: stringCodec,\n` +
    `  }],\n` +
    `}\n`
}

async function probeTypert(tempRoot: string, runtimeRoot: string): Promise<Pick<HostProbe,
  'typertLoaderRegisteredFixture' | 'clientMountedFixtureAndUnwrappedRoundTrip'>> {
  const fixtureName = 'dsh-annotation-core-rc2-probe-fixture'
  const fixtureRoot = join(tempRoot, 'typert-composition', 'node_modules', fixtureName)
  await mkdir(fixtureRoot, { recursive: true })
  const zodUrl = import.meta.resolve('zod')
  await writeFile(
    join(fixtureRoot, 'package.json'),
    JSON.stringify({
      name: fixtureName,
      version: '0.0.0-probe',
      type: 'module',
      exports: { './typert': './typert.mjs', './package.json': './package.json' },
    }, null, 2),
    'utf8',
  )
  await writeFile(join(fixtureRoot, 'typert.mjs'), typertFixtureSource(zodUrl), 'utf8')

  const hostCtx = new Context()
  hostCtx.baseUrl = pathToFileURL(join(tempRoot, 'typert-composition', 'composition.mjs')).href
  new TypertRegistry(hostCtx)
  hostCtx.provide('loader', { entries: () => [] })
  class ProbeEchoService extends TypertRemoteService {
    constructor(ctx: Context) {
      super(ctx, 'probeEcho', { namespace: 'probe' })
    }

    echo(value: string): string {
      return `echo:${value}`
    }
  }
  new ProbeEchoService(hostCtx)
  await applyTypertLoader(hostCtx, { packages: [fixtureName] })
  const descriptor = hostCtx.typert.local.get('probe/echo')
  const loaderRegistered = descriptor !== undefined && hostCtx.typert.getPackage(fixtureName, 'host') !== undefined
  const gateway = new TypertGatewayService(hostCtx)

  const clientCtx = new Context()
  new TypertRegistry(clientCtx)
  clientCtx.provide('connection', {
    rpc: {
      async call(_route: string, endpoint: string, body: { args: Record<string, unknown> }, signal: AbortSignal) {
        const split = endpoint.indexOf('/')
        try {
          const value = await gateway.invoke({
            namespace: endpoint.slice(0, split),
            method: endpoint.slice(split + 1),
            args: body.args,
            signal,
          })
          return { ok: true, value }
        } catch (error) {
          return {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
          }
        }
      },
    },
  })
  const gatewayClient = await evaluateClientBundle(
    join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-api-gateway', 'lib', 'client.js'),
    { '@deepseek-ai/cordis': cordis },
  )
  const applyClient = gatewayClient.apply as (ctx: Context) => void
  applyClient(clientCtx)
  if (descriptor === undefined) throw new Error('dynamic rc.2 probe: loader did not register descriptor')
  const remote = (clientCtx as Context & {
    remote: {
      $mount(contribution: { package: string; descriptors: readonly unknown[] }): Promise<() => Promise<void>>
    }
  }).remote
  const dispose = await remote.$mount({ package: fixtureName, descriptors: [descriptor] })
  try {
    const namespace = clientCtx.get('remote.probe') as { echo(value: string): Promise<
      | { ok: true; value: string }
      | { ok: false; error: { message: string } }
    > } | undefined
    if (namespace === undefined) throw new Error('dynamic rc.2 probe: client namespace did not mount')
    const result = await namespace.echo('round-trip')
    const value = result.ok ? result.value : undefined
    if (value !== 'echo:round-trip') {
      throw new Error(`dynamic rc.2 probe: client round trip failed: ${JSON.stringify(result)}`)
    }
    return {
      typertLoaderRegisteredFixture: loaderRegistered,
      clientMountedFixtureAndUnwrappedRoundTrip: true,
    }
  } finally {
    await dispose()
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  }
  throw new Error(`dynamic rc.2 probe timed out: ${label}`)
}

async function probeInput(runtimeRoot: string): Promise<InputProbe> {
  const runtime = await loadRuntimeClient(runtimeRoot)
  const conversation = await loadConversationProbe(runtimeRoot, runtime)
  const ctx = new Context()
  const submitted: Array<{ args: string; images: readonly unknown[] }> = []
  let released = false
  const shell = new conversation.__ProbeSessionInputShell({
    actx: ctx,
    defaultSink: async () => ({ kind: 'success' }),
    commandImages: {
      serialize: async (ids: readonly string[]) => ids.map(() => ({
        mediaType: 'image/png',
        data: PNG_BASE64,
        name: 'probe.png',
      })),
      release: () => {
        released = true
      },
      unsupportedNotice: () => 'unsupported',
    },
  })
  shell.setDraft('Explain this reference.')
  shell.addImages(['probe-image'])
  const draftBefore = shell.snapshot.draft
  const accepted = shell.beginCommand(
    {
      token: '',
      images: true,
      async submit(args: string, _actx: Context, images: readonly unknown[]) {
        submitted.push({ args, images })
        return { kind: 'error', text: 'probe rejection' }
      },
    },
    { start: 0, end: 0, draftRev: shell.snapshot.draftRev },
  )
  shell.submit('queue')
  await waitFor(() => submitted.length === 1 && shell.snapshot.phase === 'claimed', 'command error settlement')

  const dom = new JSDOM('<label for="prompt">Prompt</label><textarea id="prompt" aria-label="Prompt"></textarea>')
  const textarea = dom.window.document.querySelector('textarea')
  if (!(textarea instanceof dom.window.HTMLTextAreaElement)) throw new Error('dynamic rc.2 probe: textarea missing')
  textarea.value = shell.snapshot.draft
  const clipboard = conversation.__ProbeProjectClipboard(shell.snapshot as unknown as Record<string, unknown>)
  const a11y = `${textarea.getAttribute('aria-label') ?? ''} ${textarea.value}`
  textarea.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { data: '注' }))
  shell.setDraft(`${shell.snapshot.draft} 注释`)
  textarea.value = shell.snapshot.draft
  textarea.dispatchEvent(new dom.window.CompositionEvent('compositionend', { data: '注释' }))

  const nativeShell = new conversation.__ProbeSessionInputShell({
    actx: ctx,
    defaultSink: async () => ({ kind: 'success' }),
    commandImages: {
      serialize: async () => [],
      release: () => {},
      unsupportedNotice: () => 'unsupported',
    },
  })
  nativeShell.setDraft('')
  const inserted = nativeShell.insertReference(
    { source: 'probe', ref: 'probe', label: 'probe', clipboardText: '@probe' },
    { start: 0, end: 0, draftRev: nativeShell.snapshot.draftRev },
  )

  const result: InputProbe = {
    zeroLengthClaimPreservedDraftDomCopyAndA11y:
      accepted &&
      draftBefore === 'Explain this reference.' &&
      submitted[0]?.args === draftBefore &&
      clipboard === draftBefore &&
      !a11y.includes('@') &&
      !textarea.defaultValue.includes('@'),
    imeDraftWasNotPolluted:
      shell.snapshot.draft === 'Explain this reference. 注释' && !shell.snapshot.draft.includes('@'),
    errorKeptDraftAndRealImages:
      submitted[0]?.images.length === 1 &&
      shell.snapshot.imageIds.length === 1 &&
      shell.snapshot.imageIds[0] === 'probe-image' &&
      released === false,
    nativeReferenceStillProducedVisibleMention:
      inserted && nativeShell.snapshot.draft.startsWith('@probe'),
    plainPassThroughLatchScope: 'not-implemented-until-task-4',
  }
  nativeShell.dispose()
  shell.dispose()
  return result
}

async function runProbe(runtimeRootInput: string): Promise<Rc2DynamicProbeResult> {
  const runtimeRoot = resolve(runtimeRootInput)
  const runtimePackage = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8')) as { name?: string }
  if (runtimePackage.name !== 'dsh-official-runtime-0.1.1-rc.2') {
    throw new Error(`dynamic rc.2 probe: unexpected runtime package ${String(runtimePackage.name)}`)
  }
  const harnessRoot = dirname(runtimeRoot)
  const liveWebRoot = join(harnessRoot, 'home', 'profiles', 'web')
  const runtimeBefore = await hashTree(runtimeRoot)
  const liveBefore = await hashTree(liveWebRoot)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-annotation-core-rc2-dynamic-'))

  let projection: ProjectionProbe | undefined
  let agent: AgentProbe | undefined
  let host: HostProbe | undefined
  let input: InputProbe | undefined
  try {
    projection = await probeProjection(runtimeRoot)
    agent = await probeAgent()
    const persistence = await probeStorageAndAttachment(tempRoot)
    const typert = await probeTypert(tempRoot, runtimeRoot)
    host = { ...persistence, ...typert }
    input = await probeInput(runtimeRoot)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }

  const runtimeAfter = await hashTree(runtimeRoot)
  const liveAfter = await hashTree(liveWebRoot)
  const temporaryRootsAfterCleanup = (await exists(tempRoot)) ? [tempRoot] : []
  if (projection === undefined || agent === undefined || host === undefined || input === undefined) {
    throw new Error('dynamic rc.2 probe did not finish')
  }
  return {
    projection,
    agent,
    host,
    input,
    safety: {
      runtimeTreeChanges: changedPaths(runtimeBefore, runtimeAfter),
      liveWebChanges: changedPaths(liveBefore, liveAfter),
      temporaryRootsAfterCleanup,
    },
  }
}

export function probeRc2Dynamic(runtimeRoot: string): Promise<Rc2DynamicProbeResult> {
  const key = resolve(runtimeRoot)
  let pending = cache.get(key)
  if (pending === undefined) {
    pending = runProbe(key)
    cache.set(key, pending)
  }
  return pending
}
