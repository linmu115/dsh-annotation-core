import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertRc2RuntimeRoot } from './rc2-runtime-root.mts'

export interface Rc2ProbeResult {
  preStepCanAppendUserContext: boolean
  preStepRejectIsPreserved: boolean
  emptyCommandClaimPreservesDraft: boolean
  emptyCommandClaimHasNoPublicImmediateRelease: boolean
  commandSubmitErrorRetainsDraftAndImages: boolean
  encodedImagesCanBeAdmittedDurably: boolean
  hostCreatedUserIdReachesPreStep: boolean
  unrelatedPromptDoesNotMatchJournal: boolean
  fixedDeliveryIsNextTurnWakeup: boolean
  clientRemoteRequiresExplicitMount: boolean
  remoteResultMustBeUnwrapped: boolean
  storageDomainHasOwnedOpenClose: boolean
  customConversationProjectionIsAvailable: boolean
  nativeReferenceProducesVisibleMention: boolean
  genericContextKeyIsDeterministic: boolean
  genericContextRowIsExactlyAddressable: boolean
  unknownContextFormIsOpaque: boolean
  runtimeWritesOutsideTemporaryProfile: string[]
  observed: {
    runtimeVersion: string
    packageVersions: Record<string, string>
    userMessageId: string
    contextKey: string
    commandArgs: string
    temporaryProfileRemoved: boolean
    publicSymbols: string[]
  }
}

interface InputMachineState {
  readonly draft: string
  readonly draftRev: number
  readonly phase: string
  readonly claim?: { readonly token: string; readonly images?: boolean }
  readonly occurrences: readonly unknown[]
}

interface InputMachineLike {
  readonly state: InputMachineState
  dispatch(event: Record<string, unknown>): Array<Record<string, unknown>>
}

interface InputMachineConstructor {
  new (options?: { now?: () => number }): InputMachineLike
}

interface ActualDshLlmModule {
  createUserMessage(input: {
    content: Array<{ type: 'text'; text: string }>
    source:
      | { kind: 'user' }
      | { kind: 'plugin'; plugin: string; form: 'notice'; summary: string }
  }): {
    readonly id: string
    readonly role: 'user'
    readonly content: Array<{ type: 'text'; text: string }>
    readonly source: unknown
  }
}

interface ActualAttachmentModule {
  admitEncodedImages(
    store: { saveImages(inputs: readonly SaveImageInput[]): Promise<readonly ImageRef[]> },
    images: readonly EncodedImage[],
  ): Promise<readonly ImageRef[]>
}

interface SaveImageInput {
  readonly data: Uint8Array
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly name?: string
}

interface EncodedImage {
  readonly data: string
  readonly mediaType: SaveImageInput['mediaType']
  readonly name?: string
}

interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: SaveImageInput['mediaType']
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

const REQUIRED_PACKAGES = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-typert-loader',
  '@deepseek-ai/dsh-typert-protocol',
] as const

function packageRoot(runtimeRoot: string, packageName: string): string {
  return join(runtimeRoot, 'node_modules', ...packageName.split('/'))
}

async function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readUtf8(path)) as Record<string, unknown>
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sourceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`rc.2 probe: function ${name} was not found`)
  const end = source.indexOf('\n\t\t}', start)
  if (end < 0) throw new Error(`rc.2 probe: function ${name} has no stable bundle boundary`)
  return source.slice(start, end + '\n\t\t}'.length)
}

function evaluateFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown> = {},
): T {
  const names = Object.keys(dependencies)
  const values = Object.values(dependencies)
  const factory = new Function(...names, `'use strict'; return (${source});`)
  return factory(...values) as T
}

function inputMachineClass(source: string): string {
  const prefix = 'var InputMachine = class {'
  const start = source.indexOf(prefix)
  if (start < 0) throw new Error('rc.2 probe: InputMachine implementation was not found')
  const endMarker = '\n\t\t};\n\t\t//#endregion'
  const end = source.indexOf(endMarker, start)
  if (end < 0) throw new Error('rc.2 probe: InputMachine bundle boundary changed')
  return source.slice(start + 'var InputMachine = '.length, end + '\n\t\t}'.length)
}

function instantiateActualInputMachine(conversationClientSource: string): InputMachineLike {
  const diffEdit = evaluateFunction(sourceFunction(conversationClientSource, 'diffEdit'))
  const argsAfter = evaluateFunction(sourceFunction(conversationClientSource, 'argsAfter'))
  const referenceDraftText = evaluateFunction(sourceFunction(conversationClientSource, 'referenceDraftText'))
  const expression = inputMachineClass(conversationClientSource)
  const create = new Function(
    'EMPTY_QUEUE$1',
    'unreachable',
    'diffEdit',
    'argsAfter',
    'referenceDraftText',
    'REFERENCE_PLACEHOLDER_RE',
    'LOG_LIMIT',
    `'use strict'; return (${expression});`,
  )
  const InputMachine = create(
    [],
    (value: unknown) => {
      throw new Error(`unreachable input event: ${JSON.stringify(value)}`)
    },
    diffEdit,
    argsAfter,
    referenceDraftText,
    /\uFFFC/g,
    100,
  ) as InputMachineConstructor
  return new InputMachine({ now: () => 1 })
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function importActual<T>(path: string): Promise<T> {
  const moduleUrl = pathToFileURL(path).href
  return import(/* @vite-ignore */ moduleUrl) as Promise<T>
}

function includesAll(source: string, fragments: readonly string[]): boolean {
  return fragments.every((fragment) => source.includes(fragment))
}

/**
 * Read and execute the public/compiled rc.2 seams without installing a plugin
 * or mutating the official profile. The only writes are a disposable profile
 * below the operating-system temporary directory; it is removed before return.
 */
export async function probeRc2(runtimeRootInput: string): Promise<Rc2ProbeResult> {
  const { runtimeRoot, runtimePackage, runtimeVersion } = await assertRc2RuntimeRoot(
    runtimeRootInput,
    'rc.2 probe',
  )
  const runtimePackagePath = join(runtimeRoot, 'package.json')

  const packageVersions: Record<string, string> = {}
  for (const packageName of REQUIRED_PACKAGES) {
    const manifest = await readJson(join(packageRoot(runtimeRoot, packageName), 'package.json'))
    if (typeof manifest.version !== 'string') {
      throw new TypeError(`rc.2 probe: ${packageName} has no string version`)
    }
    packageVersions[packageName] = manifest.version
  }

  const conversationRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-client-ui-conversation')
  const runtimeClientRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-client-runtime')
  const agentRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-agent')
  const agentLoopRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-agent-loop')
  const attachmentRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-attachment')
  const llmRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-llm')
  const storageDomainRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-storage-domain')
  const typertLoaderRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-typert-loader')
  const typertRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-typert-protocol')
  const apiRemotesRoot = packageRoot(runtimeRoot, '@deepseek-ai/dsh-api-remotes')

  const observedFiles = [
    runtimePackagePath,
    join(conversationRoot, 'lib', 'client.js'),
    join(runtimeClientRoot, 'lib', 'client.js'),
    join(agentLoopRoot, 'lib', 'index.js'),
    join(attachmentRoot, 'lib', 'index.js'),
    join(storageDomainRoot, 'lib', 'index.js'),
  ]
  const hashesBefore = new Map<string, string>()
  for (const path of observedFiles) hashesBefore.set(path, sha256(await readFile(path)))

  const conversationClientSource = await readUtf8(join(conversationRoot, 'lib', 'client.js'))
  const conversationContract = await readUtf8(
    join(conversationRoot, 'lib', 'types', 'client', 'input', 'contract.d.ts'),
  )
  const conversationFacade = await readUtf8(
    join(conversationRoot, 'lib', 'types', 'client', 'input', 'facade.d.ts'),
  )
  const inputTriggerTypes = await readUtf8(
    join(packageRoot(runtimeRoot, '@deepseek-ai/dsh-client-ui-input-trigger'), 'lib', 'types', 'types.d.ts'),
  )
  const runtimeClientSource = await readUtf8(join(runtimeClientRoot, 'lib', 'client.js'))
  const conversationTypes = await readUtf8(
    join(runtimeClientRoot, 'lib', 'types', 'client', 'contract', 'conversation.d.ts'),
  )
  const agentRuntimeTypes = await readUtf8(join(agentRoot, 'lib', 'types', 'runtime-types.d.ts'))
  const agentLoopSource = await readUtf8(join(agentLoopRoot, 'lib', 'index.js'))
  const attachmentTypes = await readUtf8(join(attachmentRoot, 'lib', 'types', 'index.d.ts'))
  const storageDomainTypes = await readUtf8(join(storageDomainRoot, 'lib', 'types', 'index.d.ts'))
  const storageDomainHandleTypes = await readUtf8(join(storageDomainRoot, 'lib', 'types', 'domain.d.ts'))
  const storageDomainSource = await readUtf8(join(storageDomainRoot, 'lib', 'index.js'))
  const typertTypes = await readUtf8(join(typertRoot, 'lib', 'types', 'types.d.ts'))
  const typertLoaderSource = await readUtf8(join(typertLoaderRoot, 'lib', 'index.js'))
  const apiRemotesClientSource = await readUtf8(join(apiRemotesRoot, 'lib', 'types', 'client', 'index.js'))

  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-annotation-core-rc2-probe-'))
  const tempProfile = join(tempRoot, 'profile-web')
  const recordedWrites: string[] = []
  let temporaryProfileRemoved = false
  let result: Rc2ProbeResult | undefined

  const writeInsideTemporaryProfile = async (path: string, body: string): Promise<void> => {
    if (!isWithin(tempRoot, path)) throw new Error(`rc.2 probe attempted an out-of-profile write: ${path}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body, 'utf8')
    recordedWrites.push(resolve(path))
  }

  try {
    await mkdir(tempProfile, { recursive: true })

    // Execute the actual compiled rc.2 InputMachine extracted in memory. No
    // source file is patched and no browser/profile process is started.
    const input = instantiateActualInputMachine(conversationClientSource)
    input.dispatch({ type: 'draft-changed', draft: 'Explain this reference.' })
    const beforeClaim = input.state
    const claim = {
      token: '',
      images: true,
      submit: async () => ({ kind: 'error' as const, text: 'probe rejection' }),
    }
    input.dispatch({
      type: 'begin-command',
      claim,
      span: { start: 0, end: 0, draftRev: beforeClaim.draftRev },
    })
    const claimed = input.state
    const enterEffects = input.dispatch({ type: 'enter', mode: 'queue' })
    const beginSubmit = enterEffects.find((effect) => effect.type === 'begin-submit')
    if (beginSubmit === undefined) throw new Error('rc.2 probe: zero-length claim did not begin submit')
    input.dispatch({
      type: 'submit-settled',
      attempt: beginSubmit.attempt,
      ok: false,
      outcome: { kind: 'error', text: 'probe rejection' },
    })
    const afterError = input.state

    const projectClipboard = evaluateFunction<(state: InputMachineState) => string>(
      sourceFunction(conversationClientSource, 'projectClipboard'),
    )
    const referenceDraftText = evaluateFunction<(reference: { label: string }) => string>(
      sourceFunction(conversationClientSource, 'referenceDraftText'),
    )
    const argsAfter = evaluateFunction<(draft: string, token: string) => string>(
      sourceFunction(conversationClientSource, 'argsAfter'),
    )

    const llm = await importActual<ActualDshLlmModule>(join(llmRoot, 'lib', 'index.js'))
    const userMessage = llm.createUserMessage({
      content: [{ type: 'text', text: 'Explain this reference.' }],
      source: { kind: 'user' },
    })
    const contextMessage = llm.createUserMessage({
      content: [{ type: 'text', text: '<dsh-annotations>probe</dsh-annotations>' }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-annotation-core',
        form: 'notice',
        summary: '1 annotation',
      },
    })
    const journal = new Map([[userMessage.id, contextMessage]])
    const enterDecision = { kind: 'enter' as const, messages: [userMessage] }
    const matched = journal.get(enterDecision.messages[0]?.id ?? '')
    const projectedDecision = matched === undefined
      ? enterDecision
      : { ...enterDecision, messages: [...enterDecision.messages, matched] }
    const unrelated = llm.createUserMessage({
      content: [{ type: 'text', text: 'Unrelated prompt.' }],
      source: { kind: 'user' },
    })
    const rejectDecision = { kind: 'reject' as const }

    const deliveries: Array<{ id: string; target: string; wakeup: boolean }> = []
    const deliveryHarness = {
      send(message: { id: string }, target: string, wakeup: boolean): void {
        deliveries.push({ id: message.id, target, wakeup })
      },
    }
    deliveryHarness.send(userMessage, 'next-turn', true)

    const attachment = await importActual<ActualAttachmentModule>(join(attachmentRoot, 'lib', 'index.js'))
    const attachmentLedger = join(tempProfile, 'attachments', 'ledger.json')
    const durableStore = {
      async saveImages(inputs: readonly SaveImageInput[]): Promise<readonly ImageRef[]> {
        const refs = inputs.map((image) => ({
          attachmentId: `sha256:${sha256(image.data)}`,
          mediaType: image.mediaType,
          bytes: image.data.byteLength,
          width: 1,
          height: 1,
          ...(image.name === undefined ? {} : { name: image.name }),
        }))
        await writeInsideTemporaryProfile(
          attachmentLedger,
          JSON.stringify(refs.map((ref) => ({ ...ref })), null, 2),
        )
        return refs
      },
    }
    const encodedImage: EncodedImage = {
      mediaType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlI8AAAAASUVORK5CYII=',
      name: 'probe.png',
    }
    const attachmentRefs = await attachment.admitEncodedImages(durableStore, [encodedImage])
    const ledger = JSON.parse(await readUtf8(attachmentLedger)) as ImageRef[]

    const remoteSuccess = { ok: true as const, value: { revision: 2 } }
    const remoteFailure = {
      ok: false as const,
      error: { code: 'probe', message: 'failure', details: {} },
    }
    const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    let remoteFailureWasUnwrapped = false
    try {
      unwrap(remoteFailure)
    } catch {
      remoteFailureWasUnwrapped = true
    }

    const conversationContextKey = evaluateFunction<(kind: string, id: string) => string>(
      sourceFunction(runtimeClientSource, 'conversationContextKey'),
    )
    const contextKey = conversationContextKey('input-message', contextMessage.id)
    const contextForm = evaluateFunction<(source: unknown) => string | null>(
      sourceFunction(runtimeClientSource, 'contextForm'),
      {
        KNOWN_FORMS: ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'],
        asRecord: (value: unknown) => value !== null && typeof value === 'object'
          ? value as Record<string, unknown>
          : null,
        readString: (record: Record<string, unknown>, key: string) =>
          typeof record[key] === 'string' ? record[key] : null,
      },
    )

    const hashesAfter = new Map<string, string>()
    for (const path of observedFiles) hashesAfter.set(path, sha256(await readFile(path)))
    const changedRuntimeFiles = observedFiles.filter((path) => hashesBefore.get(path) !== hashesAfter.get(path))
    const outOfProfileWrites = recordedWrites.filter((path) => !isWithin(tempRoot, path))

    const preStepShape = includesAll(agentRuntimeTypes, [
      "'agent/pre-step'",
      'messages: UserMessage[]',
      "kind: 'enter'",
    ]) && includesAll(agentLoopSource, [
      'this.dispatch.waterfall("agent/pre-step"',
      'messages: claimed',
      'messages: context === void 0 ? claimed : [...claimed, context]',
    ])
    const emptyClaimShape = includesAll(inputTriggerTypes, [
      'readonly token: string',
      'submit(args: string',
    ]) && includesAll(conversationClientSource, [
      'this.adopt(claim.token + this.draft.slice(span.end))',
      'args: argsAfter(this.draft, this.claim.token)',
    ])
    const noPublicRelease = conversationContract.includes('export interface SessionInput extends InputTarget')
      && !/export interface SessionInput extends InputTarget[\s\S]*?\n}\n[\s\S]*?\brelease\s*\(/.test(
        conversationContract,
      )
      && conversationFacade.includes('dispose(): void;')
    const errorRetentionShape = includesAll(conversationClientSource, [
      'if (ev.ok)',
      'this.phase = "claimed"',
      'if (outcome.kind === "success" && imageIds.length > 0)',
    ])
    const storageLifecycle = includesAll(storageDomainTypes, [
      'class DomainFacility',
      'open<S extends DomainSpec>(spec: S): Promise<Domain<S>>',
    ]) && storageDomainHandleTypes.includes('close(): Promise<void>')
      && includesAll(storageDomainSource, ['async open(spec)', 'close() {', 'await this.unit.close()'])
    const explicitRemoteMount = typertTypes.includes('$mount(contribution: TypertRemoteContribution)')
      && apiRemotesClientSource.includes('await ctx.remote.$mount(contribution)')
      && includesAll(typertLoaderSource, [
        'const TYPERT_HOST_EXPORT = "./typert"',
        'ctx.typert.register(manifest)',
      ])
    const remoteResultShape = includesAll(typertTypes, [
      'export type RemoteResult<T>',
      "readonly ok: true",
      "readonly ok: false",
    ])
    const projectionSurface = includesAll(conversationTypes, [
      'interface ConversationNodeDefinition',
      'function conversationContextKey',
    ]) && includesAll(conversationClientSource, [
      'ctx.conversationEvents.register(',
      'ctx.slots.inject("conversation.chat.node"',
    ])
    const exactRowSurface = includesAll(conversationClientSource, [
      '"data-chat-anchor-key": routedNode.key',
      '"data-chat-flow-kind": routedNode.kind',
      'list.querySelectorAll("[data-chat-anchor-key]")',
      'row.dataset.chatAnchorKey === key',
    ])

    result = {
      preStepCanAppendUserContext: preStepShape
        && projectedDecision.kind === 'enter'
        && projectedDecision.messages.at(-1)?.id === contextMessage.id,
      preStepRejectIsPreserved: preStepShape && rejectDecision.kind === 'reject',
      emptyCommandClaimPreservesDraft: emptyClaimShape
        && claimed.phase === 'claimed'
        && claimed.claim?.token === ''
        && claimed.draft === beforeClaim.draft
        && projectClipboard(claimed) === beforeClaim.draft,
      emptyCommandClaimHasNoPublicImmediateRelease: noPublicRelease,
      commandSubmitErrorRetainsDraftAndImages: errorRetentionShape
        && afterError.phase === 'claimed'
        && afterError.draft === beforeClaim.draft
        && claimed.claim?.images === true,
      encodedImagesCanBeAdmittedDurably: attachmentTypes.includes('admitEncodedImages')
        && attachmentRefs.length === 1
        && ledger[0]?.attachmentId === attachmentRefs[0]?.attachmentId
        && ledger[0]?.bytes === Buffer.from(encodedImage.data, 'base64').byteLength,
      hostCreatedUserIdReachesPreStep: typeof userMessage.id === 'string'
        && userMessage.id.length > 0
        && journal.get(userMessage.id)?.id === contextMessage.id
        && projectedDecision.messages[0]?.id === userMessage.id,
      unrelatedPromptDoesNotMatchJournal: unrelated.id !== userMessage.id
        && journal.has(unrelated.id) === false,
      fixedDeliveryIsNextTurnWakeup: agentRuntimeTypes.includes(
        'send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;',
      ) && deliveries.length === 1
        && deliveries[0]?.target === 'next-turn'
        && deliveries[0]?.wakeup === true,
      clientRemoteRequiresExplicitMount: explicitRemoteMount,
      remoteResultMustBeUnwrapped: remoteResultShape
        && unwrap(remoteSuccess).revision === 2
        && remoteFailureWasUnwrapped,
      storageDomainHasOwnedOpenClose: storageLifecycle,
      customConversationProjectionIsAvailable: projectionSurface,
      nativeReferenceProducesVisibleMention: referenceDraftText({ label: 'probe' }) === '@probe',
      genericContextKeyIsDeterministic: contextKey === `13:input-message${contextMessage.id}`
        && conversationContextKey('input-message', contextMessage.id) === contextKey,
      genericContextRowIsExactlyAddressable: exactRowSurface,
      unknownContextFormIsOpaque: contextForm({
        kind: 'plugin',
        plugin: 'dsh-annotation-core',
        form: 'future-annotation-form',
      }) === null,
      runtimeWritesOutsideTemporaryProfile: [...outOfProfileWrites, ...changedRuntimeFiles],
      observed: {
        runtimeVersion,
        packageVersions,
        userMessageId: userMessage.id,
        contextKey,
        commandArgs: argsAfter(beforeClaim.draft, ''),
        temporaryProfileRemoved,
        publicSymbols: [
          'SessionInput.beginCommand',
          'CommandClaim.submit',
          'createUserMessage',
          'Agent.send',
          'agent/pre-step',
          'admitEncodedImages',
          'DomainFacility.open',
          'Domain.close',
          'TypertClientRemote.$mount',
          'typert-loader ./typert registration',
          'RemoteResult',
          'ConversationNodeDefinition',
          'conversationContextKey',
        ],
      },
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
    temporaryProfileRemoved = true
  }

  if (result === undefined) throw new Error('rc.2 probe did not produce a result')
  return {
    ...result,
    observed: {
      ...result.observed,
      temporaryProfileRemoved,
    },
  }
}
