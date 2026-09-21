import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AnnotationStore } from '../src/host/store.ts'
import { AnnotationCoreRemoteService } from '../src/remote/service.ts'
import { availableReferenceSets } from '../src/host/reference-tools.ts'
import { reconcileGraphRevocations } from '../src/host/graph-reference-recovery.ts'
import { selectedTextHash } from '../src/protocol/index.ts'

function fixture() {
  const table = AnnotationStore.memoryTable(), store = new AnnotationStore(table, {profileId:'web'}), ctx = new Context()
  const source = {sourceType:'dsh-message' as const,selectedText:'quote',locator:{profileId:'web',sessionId:'source',
    messageId:'reply',anchorId:'reply',role:'assistant' as const,occurrence:0,selectedTextHash:selectedTextHash('quote'),
    upstream:{kind:'fixed-upstream' as const,referenceId:'ref',sourceTitle:'Source',sourceVersionId:'v1',cutoffEventId:'end',targetSessionId:'target'}}}
  const status = vi.fn(async()=>({referenceId:'ref',state:'sent' as 'sent'|'revoked'}))
  const bridge = {protocolVersion:1,status,bind:vi.fn(async()=>{}),describe:vi.fn(async()=>({sourceNativeSessionId:'source',record:{
    referenceId:'ref',sourceAnchorId:'reply',sourceVersionId:'v1',cutoffEventId:'end',selectedText:'quote',sourceTitle:'Source',state:'sent',targetMessageId:'original-user',
  }}))}
  ctx.provide('sessionReferenceContext' as never,bridge)
  const remote = new AnnotationCoreRemoteService(ctx,store)
  const agent = {id:'target',ctx,session:{id:'target',inheritedEventCount:0,snapshotEvents:()=>[]}} as any
  return {ctx,table,store,source,bridge,remote,agent}
}

describe('restored graph read grants and external revocation',()=>{
  it('restores fixed reads across restart without fabricating sends or rebinding the original message',async()=>{
    const f=fixture()
    await f.remote.restoreGraphReference(f.agent,'ref')
    await f.remote.restoreGraphReference(f.agent,'ref')
    const reopened=new AnnotationStore(f.table,{profileId:'web'})
    expect(availableReferenceSets(reopened,f.agent)).toHaveLength(1)
    expect(availableReferenceSets(reopened,f.agent)[0]?.items[0]).toMatchObject({locator:{upstream:{sourceVersionId:'v1',cutoffEventId:'end'}}})
    expect(reopened.read('target').revision).toBe(1)
    expect(reopened.read('target').admissions).toEqual({})
    expect(reopened.read('target').submissionJournal).toEqual({})
    expect(reopened.read('target').sentSets).toEqual([])
    expect(f.bridge.bind).not.toHaveBeenCalled()
    reopened.close();f.store.close()
  })
  it('never accepts a client-supplied source or a pending authority reference as historical authorization',async()=>{
    const f=fixture()
    f.bridge.describe.mockImplementationOnce(async()=>{throw new Error('target mismatch')})
    await expect(f.remote.restoreGraphReference(f.agent,'ref')).rejects.toThrow('target mismatch')
    f.bridge.describe.mockResolvedValueOnce({...await f.bridge.describe(),record:{... (await f.bridge.describe()).record,state:'pending'}})
    await expect(f.remote.restoreGraphReference(f.agent,'ref')).rejects.toThrow('状态已经变化')
    expect(f.store.listRestoredGraphSets('target')).toEqual([])
    f.store.close()
  })
  it('applies an archive tombstone to a pending bubble but retains it when the authority is offline',async()=>{
    const f=fixture()
    await f.store.addReference('target',{expectedRevision:0,operationId:'op',setId:'set',referenceId:'ref',source:f.source,createdAt:1})
    f.bridge.status.mockRejectedValueOnce(new Error('offline'))
    expect((await f.remote.readPending(f.agent)).pending?.items).toHaveLength(1)
    f.bridge.status.mockResolvedValue({referenceId:'ref',state:'revoked'})
    expect((await f.remote.readPending(f.agent)).pending).toBeNull()
    expect(f.store.resolveReferenceLink('target','ref')?.state).toBe('deleted')
    expect(f.store.listPendingDiscardJobs('target')).toEqual([])
    f.store.close()
  })
  it('removes restored reads on external revoke, and a stale start cannot resurrect the grant',async()=>{
    const f=fixture()
    await f.remote.restoreGraphReference(f.agent,'ref')
    f.bridge.status.mockResolvedValue({referenceId:'ref',state:'revoked'})
    await reconcileGraphRevocations(f.ctx,f.store,'target')
    expect(availableReferenceSets(f.store,f.agent)).toEqual([])
    await expect(f.remote.restoreGraphReference(f.agent,'ref')).rejects.toThrow('已解除')
    expect(f.bridge.bind).not.toHaveBeenCalled()
    f.store.close()
  })
  it('deletes a restored read only after an authority acknowledgement',async()=>{
    const f=fixture();await f.remote.restoreGraphReference(f.agent,'ref')
    const request={expectedRevision:1,setId:'graph-restored:ref',referenceId:'ref',deletedAt:2}
    f.bridge.bind.mockRejectedValueOnce(new Error('offline'))
    await expect(f.remote.deleteReferenceLink(f.agent,request)).rejects.toThrow('offline')
    expect(f.store.listRestoredGraphSets('target')).toHaveLength(1)
    await f.remote.deleteReferenceLink(f.agent,request)
    expect(f.store.listRestoredGraphSets('target')).toEqual([])
    expect(f.bridge.bind).toHaveBeenLastCalledWith('target','ref',null)
    f.store.close()
  })
})
