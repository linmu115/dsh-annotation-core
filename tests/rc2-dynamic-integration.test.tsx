import { describe, expect, it } from 'vitest'
import { probeRc2Dynamic } from '../scripts/probe-rc2-dynamic.mts'

const runtimeRoot = 'D:\\AI\\DeepSeek-Harness\\runtime-0.1.1-rc.2'

describe('official DSH rc.2 dynamic integration boundary', () => {
  it('mounts the real conversation projection and restores the exact generic row', async () => {
    const result = await probeRc2Dynamic(runtimeRoot)

    expect(result.projection.builtInAndCoreDefinitionsMounted).toBe(true)
    expect(result.projection.contextKeyMatchesExactGenericRow).toBe(true)
    expect(result.projection.onlyExactGenericRowHidden).toBe(true)
    expect(result.projection.coreNodeKeepsContextSeq).toBe(true)
    expect(result.projection.disposeRestoresGenericRow).toBe(true)
  }, 120_000)

  it('uses the real Agent inbox and pre-step waterfall with an ID journal', async () => {
    const result = await probeRc2Dynamic(runtimeRoot)

    expect(result.agent.hostMessageIdReachedPreStep).toBe(true)
    expect(result.agent.unrelatedMessageDidNotMatch).toBe(true)
    expect(result.agent.rejectDecisionWasPreserved).toBe(true)
    expect(result.agent.deliveryWasNextTurnWakeup).toBe(true)
  }, 120_000)

  it('opens real temporary storage, attachment, and Typert transports', async () => {
    const result = await probeRc2Dynamic(runtimeRoot)

    expect(result.host.storageRoundTripSurvivedCloseAndReopen).toBe(true)
    expect(result.host.attachmentRoundTripWasDurable).toBe(true)
    expect(result.host.invalidBase64WasRejectedBeforeWrite).toBe(true)
    expect(result.host.typertLoaderRegisteredFixture).toBe(true)
    expect(result.host.clientMountedFixtureAndUnwrappedRoundTrip).toBe(true)
  }, 120_000)

  it('submits through the public SessionInput facade without visible pollution', async () => {
    const result = await probeRc2Dynamic(runtimeRoot)

    expect(result.input.zeroLengthClaimPreservedDraftDomCopyAndA11y).toBe(true)
    expect(result.input.imeDraftWasNotPolluted).toBe(true)
    expect(result.input.errorKeptDraftAndRealImages).toBe(true)
    expect(result.input.nativeReferenceStillProducedVisibleMention).toBe(true)
    expect(result.input.plainPassThroughLatchScope).toBe('not-implemented-until-task-4')
  }, 120_000)

  it('leaves the official runtime and live web surfaces unchanged', async () => {
    const result = await probeRc2Dynamic(runtimeRoot)

    expect(result.safety.runtimeTreeChanges).toEqual([])
    expect(result.safety.liveWebChanges).toEqual([])
    expect(result.safety.temporaryRootsAfterCleanup).toEqual([])
  }, 120_000)
})
