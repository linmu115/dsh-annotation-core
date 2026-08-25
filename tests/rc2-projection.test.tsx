import { describe, expect, it } from 'vitest'
import { probeRc2 } from '../scripts/probe-rc2-projection.mts'
import { resolveRc2RuntimeRoot } from '../scripts/rc2-runtime-root.mts'

const runtimeRoot = resolveRc2RuntimeRoot()

describe('official DSH rc.2 extension boundary', () => {
  it('exposes the rc.2 seams required by annotation core', async () => {
    const result = await probeRc2(runtimeRoot)

    expect(result.preStepCanAppendUserContext).toBe(true)
    expect(result.preStepRejectIsPreserved).toBe(true)
    expect(result.emptyCommandClaimPreservesDraft).toBe(true)
    expect(result.emptyCommandClaimHasNoPublicImmediateRelease).toBe(true)
    expect(result.commandSubmitErrorRetainsDraftAndImages).toBe(true)
    expect(result.encodedImagesCanBeAdmittedDurably).toBe(true)
    expect(result.hostCreatedUserIdReachesPreStep).toBe(true)
    expect(result.unrelatedPromptDoesNotMatchJournal).toBe(true)
    expect(result.fixedDeliveryIsNextTurnWakeup).toBe(true)
    expect(result.clientRemoteRequiresExplicitMount).toBe(true)
    expect(result.remoteResultMustBeUnwrapped).toBe(true)
    expect(result.storageDomainHasOwnedOpenClose).toBe(true)
    expect(result.customConversationProjectionIsAvailable).toBe(true)
    expect(result.nativeReferenceProducesVisibleMention).toBe(true)
    expect(result.genericContextKeyIsDeterministic).toBe(true)
    expect(result.genericContextRowIsExactlyAddressable).toBe(true)
    expect(result.unknownContextFormIsOpaque).toBe(true)
    expect(result.runtimeWritesOutsideTemporaryProfile).toEqual([])
    expect(result.observed.temporaryProfileRemoved).toBe(true)
  })
})
