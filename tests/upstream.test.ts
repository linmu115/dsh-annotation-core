import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { AnnotationStore } from '../src/host/store.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { BacklinkOutbox } from '../src/host/backlink-outbox.ts'
import { PendingDiscardOutbox } from '../src/host/pending-discard-outbox.ts'
import { CommittedDeleteOutbox } from '../src/host/committed-delete-outbox.ts'
import { selectedTextHash, type ReferenceSource } from '../src/protocol/index.ts'
import { UpstreamToolBudgets, upstreamHeadroom, type NativeUpstreamUsage } from '../src/host/upstream-budget.ts'
import { registerUpstreamTools } from '../src/host/upstream-tools.ts'
import { availableReferenceSets, registerReferenceTools } from '../src/host/reference-tools.ts'
import { prepareReferenceSet } from '../src/host/prepare-reference-set.ts'
import { createAnnotationContextMessage } from '../src/host/commit-journal.ts'
import { ReferenceSetSchema } from '../src/host/store.ts'
import { annotationContextMessageId, parseSerializedAnnotationContext, serializePreparedReferenceSet } from '../src/protocol/index.ts'
import { collectReferenceDocuments } from '../src/domain/budget.ts'
import type { ReferenceSet } from '../src/domain/model.ts'
import { captureUpstream, describeGraphUpstream } from '../src/host/upstream.ts'
import { DshMessageCaptureSchema } from '../src/protocol/index.ts'
import { reconcileGraphRevocations } from '../src/host/graph-reference-recovery.ts'

const digest='sha256:'+'a'.repeat(64)
const source:ReferenceSource={sourceType:'dsh-message',selectedText:'selected',locator:{profileId:'web',sessionId:'source',anchorId:'answer',
  role:'assistant',occurrence:0,selectedTextHash:selectedTextHash('selected'),upstream:{kind:'fixed-upstream',referenceId:'reference',sourceTitle:'Source',
    sourceVersionId:'v1',cutoffEventId:'completed-answer',targetSessionId:'target'}}}
async function fixture(sent=true){
  const store=new AnnotationStore(AnnotationStore.memoryTable(),{profileId:'web'})
  await store.addReference('target',{expectedRevision:0,operationId:'op',setId:'set',referenceId:'reference',source,createdAt:1})
  if(sent){
    const begun=await store.beginAnnotatedAdmission('target',{expectedRevision:1,clientSubmissionId:'submission',requestDigest:digest,setId:'set',referenceRevision:1,createdAt:2})
    await store.recordEnqueuedSubmission('target',{expectedRevision:begun.revision,clientSubmissionId:'submission',requestDigest:digest,userMessageId:'user',
      contextMessageId:'context',contextDigest:digest,userTextHash:digest,preparedSet:begun.set!,createdAt:3})
    await store.finalizeDurableSubmission('target',{expectedRevision:3,clientSubmissionId:'submission',userMessageId:'user',userObserved:true,contextObserved:true,committedAt:4})
  }
  const ctx=new Context()
  const bridge={protocolVersion:1,settleRead:vi.fn(async()=>({recorded:true})),endExecution:vi.fn(async()=>({})),bind:vi.fn(async()=>({})),inspect:vi.fn(async()=>({selectedText:'selected',sourceVersionId:'v1',cutoffEventId:'completed-answer'})),
    read:vi.fn(async()=>({referenceId:'reference',sourceVersionId:'v1',cutoffEventId:'completed-answer',
      items:[{eventId:'question',role:'user',text:'Why use gradient checkpointing?',offset:0,complete:true},
        {eventId:'completed-answer',role:'assistant',text:'bounded upstream: recomputation trades time for GPU memory. Full selected answer.',offset:0,complete:true}],
      selectedTurn:{complete:true,omittedIntermediateItems:2,detailsCursor:'intermediate-tool'},nextCursor:'older-turn',hasMore:true}))}
  ctx.provide('maintenanceSessionContext' as never,bridge)
  const registry=new HostSourceRegistry(ctx)
  const events=[{type:'turn/start',seq:100,time:10}]
  const agent={id:'target',ctx,session:{id:'target',inheritedEventCount:0,header:{},snapshotEvents:()=>events,
    requestContext:()=>({contextWindow:65536}),requestHeader:()=>({config:{maxTokens:8192},tools:[]}),deriveMessages:()=>[]}} as unknown as Agent
  return {ctx,store,bridge,registry,agent,events}
}
describe('fixed upstream annotation lifecycle and model access',()=>{
  it('keeps a committing batch intact until rollback, then applies an authoritative revocation',async()=>{
    const f=await fixture(false)
    Object.assign(f.bridge,{status:async()=>({referenceId:'reference',state:'revoked'})})
    await f.store.beginAnnotatedAdmission('target',{expectedRevision:1,clientSubmissionId:'submission',requestDigest:digest,setId:'set',referenceRevision:1,createdAt:2})
    await reconcileGraphRevocations(f.ctx,f.store,'target')
    expect(f.store.readPending('target').pending?.state).toBe('committing')
    expect(f.store.readDeletedReference('target','reference')).toBeUndefined()
    await f.store.markPendingCommitFailed('target',{expectedRevision:2,setId:'set'})
    await f.store.restorePendingCommit('target',{expectedRevision:3,setId:'set'})
    await reconcileGraphRevocations(f.ctx,f.store,'target')
    expect(f.store.readPending('target').pending).toBeUndefined()
    f.store.close()
  })
  it('does not deliver restored graph context revoked during a read',async()=>{
    const f=await fixture(false), restored=new AnnotationStore(AnnotationStore.memoryTable(),{profileId:'web'}), registered:any[]=[]
    await restored.restoreGraphReference('target',source)
    let state='sent'
    Object.assign(f.bridge,{status:async()=>({referenceId:'reference',state})})
    const page=await f.bridge.read()
    f.bridge.read.mockImplementationOnce(async()=>{state='revoked';return page})
    f.ctx.provide('tools',{register:(tool:any)=>registered.push(tool)} as never)
    registerUpstreamTools(f.ctx,restored,new UpstreamToolBudgets())
    await vi.waitFor(()=>expect(registered).toHaveLength(2))
    await expect(registered[0].execute({referenceId:'reference'},{agent:f.agent,signal:new AbortController().signal})).rejects.toThrow('读取期间已撤销')
    expect(f.bridge.settleRead).toHaveBeenLastCalledWith('target','reference',expect.any(String),'failed')
    expect(availableReferenceSets(restored,f.agent)).toEqual([])
    restored.close();f.store.close()
  })
  it('resolves the recorded source identity without capturing or extending its version',async()=>{
    const ctx=new Context(),describe=vi.fn(async()=>({sourceNativeSessionId:'native-source',record:{
      referenceId:'ref',sourceAnchorId:'real-message-id',sourceVersionId:'old-retained-version',cutoffEventId:'fixed-completed-event',
      sourceTitle:'Source',selectedText:'quote',state:'pending',
    }})),capture=vi.fn()
    ctx.provide('maintenanceSessionContext' as never,{protocolVersion:1,describe,capture})
    const result=await describeGraphUpstream(ctx,'target','web','ref')
    expect(result.source.locator).toMatchObject({sessionId:'native-source',messageId:'real-message-id',upstream:{sourceVersionId:'old-retained-version',targetSessionId:'target'}})
    expect(describe).toHaveBeenCalledExactlyOnceWith('target','ref')
    expect(capture).not.toHaveBeenCalled()
  })
  it('records tool delivery only after validation and records cancellation without exposing the response',async()=>{
    const f=await fixture(),registered:any[]=[]
    f.ctx.provide('tools',{register:(tool:any)=>registered.push(tool)} as never)
    registerUpstreamTools(f.ctx,f.store,new UpstreamToolBudgets())
    await vi.waitFor(()=>expect(registered).toHaveLength(2))
    await registered[0].execute({referenceId:'reference'},{agent:f.agent,signal:new AbortController().signal})
    const input=(f.bridge.read.mock.calls as unknown as [{requestId:string}][]).at(-1)![0]
    expect(f.bridge.settleRead).toHaveBeenCalledWith('target','reference',input.requestId,'returned')
    const abort=new AbortController(),page=await f.bridge.read()
    f.bridge.read.mockImplementationOnce(async()=>{abort.abort();return page})
    await expect(registered[0].execute({referenceId:'reference'},{agent:f.agent,signal:abort.signal})).rejects.toThrow()
    expect(f.bridge.settleRead).toHaveBeenLastCalledWith('target','reference',expect.any(String),'failed')
  })
  it('ends initial read executions on success and source failure', async()=>{
    const f=await fixture(false)
    const set=f.store.readPending('target').pending!
    expect((await prepareReferenceSet(set,f.registry,{upstreamExecutionId:'initial:first'})).kind).toBe('ready')
    expect(f.bridge.endExecution).toHaveBeenLastCalledWith('target','initial:first')
    f.bridge.read.mockRejectedValueOnce(new Error('source disappeared'))
    expect((await prepareReferenceSet(set,f.registry,{upstreamExecutionId:'initial:second'})).kind).toBe('blocked')
    expect(f.bridge.endExecution).toHaveBeenLastCalledWith('target','initial:second')
  })
  it('does not exhaust a process-lifetime turn limit and refuses reads after turn end',async()=>{
    const f=await fixture(),budget=new UpstreamToolBudgets()
    for(let turn=0;turn<10001;turn++){
      f.events.splice(0,f.events.length,{type:'turn/start',seq:turn,time:turn})
      const allowance=budget.reserve(f.agent)
      allowance.settle('bounded output')
      expect(budget.end('target')).toBe(allowance.executionId)
    }
    f.events.push({type:'turn/end',seq:10002,time:10002})
    expect(()=>budget.reserve(f.agent)).toThrow('没有正在执行')
    expect(budget.end('target')).toBeUndefined()
  })
  it.each(['turn/end','turn/start','session/disposed','agent/disposed'] as const)('closes the host budget on %s',async event=>{
    const f=await fixture(),registered:any[]=[]
    f.ctx.provide('tools',{register:(tool:any)=>{registered.push(tool)}} as never)
    registerReferenceTools(f.ctx,f.store,f.registry)
    await vi.waitFor(()=>expect(registered).toHaveLength(4))
    await registered.find(tool=>tool.name==='dsh_upstream_read').execute({referenceId:'reference'},
      {agent:f.agent,signal:new AbortController().signal})
    if(event==='agent/disposed')f.ctx.emit(event,{agent:f.agent})
    else if(event==='session/disposed')f.ctx.emit(event,f.agent.session)
    else f.ctx.emit('session/event',f.agent.session,{type:event} as never)
    await vi.waitFor(()=>expect(f.bridge.endExecution).toHaveBeenCalledExactlyOnceWith('target','turn:100:10'))
  })
  it('carries the selected graph material version to the atomic capture and rejects a mismatching host receipt',async()=>{
    const ctx=new Context()
    const capture=vi.fn(async()=>({referenceId:'ref',sourceTitle:'Source',sourceVersionId:'v1',cutoffEventId:'answer',selectedText:'selected'}))
    ctx.provide('maintenanceSessionContext' as never,{protocolVersion:1,capture})
    const input=DshMessageCaptureSchema.parse({sourceSessionId:'source',anchorId:'answer',messageId:'answer',role:'assistant',
      occurrence:0,selectedText:'selected',expectedSourceVersionId:'v1'})
    const source=await captureUpstream(ctx,'target','web',input,'graph-op')
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({expectedSourceVersionId:'v1',sourceNativeSessionId:'source',targetNativeSessionId:'target'}))
    expect(source.locator.upstream?.sourceVersionId).toBe('v1')
    capture.mockResolvedValueOnce({referenceId:'ref',sourceTitle:'Source',sourceVersionId:'v2',cutoffEventId:'answer',selectedText:'selected'})
    await expect(captureUpstream(ctx,'target','web',input,'graph-op')).rejects.toThrow('所选材料')
    expect(()=>DshMessageCaptureSchema.parse({...input,expectedSourceVersionId:''})).toThrow()
  })
  it('records a durable target binding and revokes only that relation on delete',async()=>{
    const f=await fixture(); const outbox=new BacklinkOutbox(f.store,f.registry)
    await outbox.runPending('target');await outbox.runPending('target')
    expect(f.bridge.bind).toHaveBeenCalledExactlyOnceWith('target','reference','user')
    expect(f.store.listBacklinkJobs('target')[0]).toMatchObject({state:'written',receipt:{kind:'maintenance-reference'}})
    await f.store.deleteReferenceLink('target',{expectedRevision:f.store.read('target').revision,setId:'set',referenceId:'reference',deletedAt:5})
    await new CommittedDeleteOutbox(f.store,f.registry).runPending('target')
    expect(f.bridge.bind).toHaveBeenLastCalledWith('target','reference',null)
    expect(f.store.listCommittedDeleteJobs('target')).toHaveLength(0)
    expect(f.store.readAdmission('target','submission')?.state).toBe('durable')
  })
  it('keeps an offline pending revoke for retry and never publishes an unsent draft to AI',async()=>{
    const f=await fixture(false)
    expect(availableReferenceSets(f.store,f.agent)).toEqual([])
    f.bridge.bind.mockRejectedValueOnce(new Error('offline'))
    await f.store.removeReference('target',{expectedRevision:1,referenceId:'reference'})
    const outbox=new PendingDiscardOutbox(f.store,f.registry)
    await outbox.runPending('target')
    expect(f.store.listPendingDiscardJobs('target')).toHaveLength(1)
    await outbox.runPending('target')
    expect(f.store.listPendingDiscardJobs('target')).toHaveLength(0)
  })
  it('checks the actual target and the immutable source identity before admission',async()=>{
    const f=await fixture(false),set=f.store.readPending('target').pending!
    expect((await prepareReferenceSet(set,f.registry)).kind).toBe('ready')
    expect((await prepareReferenceSet({...set,sessionId:'foreign'},f.registry)).kind).toBe('blocked')
    f.bridge.inspect.mockResolvedValueOnce({selectedText:'selected',sourceVersionId:'v2',cutoffEventId:'completed-answer'})
    expect((await prepareReferenceSet(set,f.registry)).kind).toBe('blocked')
  })
  it('journals and reconstructs the complete source turn alongside the excerpt without making a document snapshot',async()=>{
    const f=await fixture(false),set=f.store.readPending('target').pending!
    const result=await prepareReferenceSet(set,f.registry,{upstreamExecutionId:'initial-test'})
    expect(result.kind).toBe('ready')
    if(result.kind!=='ready')throw new Error('Preparation failed')
    expect(f.bridge.read).toHaveBeenCalledWith(expect.objectContaining({view:'selected-turn',executionId:'initial-test'}))
    expect(f.store.readPending('target').pending!.items[0]).not.toHaveProperty('initialContext')
    const persisted=ReferenceSetSchema.parse(JSON.parse(JSON.stringify(result.set))) as ReferenceSet
    const serialized=serializePreparedReferenceSet(persisted,collectReferenceDocuments(persisted))
    const journal={clientSubmissionId:'submission',requestDigest:digest,createdAt:2,userMessageId:'user',setId:set.setId,preparedSet:persisted,contextDigest:serialized.digest,
      contextMessageId:annotationContextMessageId({sessionId:'target',userMessageId:'user',setId:set.setId,digest:serialized.digest})}
    const context=createAnnotationContextMessage('target',journal)
    expect(context.content).toEqual([{type:'text',text:serialized.text}])
    const parsed=parseSerializedAnnotationContext(serialized.text)
    expect(parsed.documents.documents).toEqual([])
    expect(parsed.annotations.items[0]).toMatchObject({selectedText:'selected',initialContext:{kind:'selected-turn',turnComplete:true,omittedIntermediateItems:2,detailsCursor:'intermediate-tool',
      nextCursor:'older-turn',items:[{role:'user',text:'Why use gradient checkpointing?'},{role:'assistant',text:expect.stringContaining('Full selected answer')}]}})
  })
  it('does not silently downgrade to isolated text when turn preparation fails or the fixed version differs',async()=>{
    const f=await fixture(false),set=f.store.readPending('target').pending!
    f.bridge.read.mockRejectedValueOnce(new Error('source offline'))
    expect((await prepareReferenceSet(set,f.registry)).kind).toBe('blocked')
    f.bridge.read.mockResolvedValueOnce({...await f.bridge.read(),sourceVersionId:'different'})
    expect((await prepareReferenceSet(set,f.registry)).kind).toBe('blocked')
    expect(f.store.readPending('target').pending).toEqual(set)
  })
  it('shares preparation space across multiple references and charges initial context before later tools',async()=>{
    const f=await fixture(false),set=f.store.readPending('target').pending!
    const result=await prepareReferenceSet({...set,items:[set.items[0]!,{...set.items[0]!,number:2}]},f.registry)
    expect(result.kind).toBe('ready')
    const calls=f.bridge.read.mock.calls as unknown as [{maxBytes:number;totalBytes:number;executionId:string}][]
    expect(calls).toHaveLength(2)
    expect(calls[0]![0].maxBytes).toBeLessThan(6500)
    expect(calls[0]![0].executionId).toBe(calls[1]![0].executionId)
    const budget=new UpstreamToolBudgets(undefined,()=>6000)
    const first=budget.reserve(f.agent,16000)
    expect(first.bytes).toBe(Math.floor(65536*.2)-6000)
    first.settle('x'.repeat(first.bytes))
    expect(()=>budget.reserve(f.agent)).toThrow('额度')
  })
  it('uses one host-owned allowance for concurrent reads and retries and includes request/tool/output space',async()=>{
    const f=await fixture(),budget=new UpstreamToolBudgets()
    const first=budget.reserve(f.agent,8000),second=budget.reserve(f.agent,8000)
    expect(first.executionId).toBe(second.executionId)
    expect(first.bytes+second.bytes).toBe(Math.floor(65536*.2))
    expect(()=>budget.reserve(f.agent)).toThrow('额度')
    first.settle('x'.repeat(first.bytes));second.settle('x'.repeat(second.bytes))
    expect(()=>budget.reserve(f.agent)).toThrow('额度')
    f.events.push({type:'turn/start',seq:200,time:20})
    expect(budget.reserve(f.agent).executionId).not.toBe(first.executionId)
    expect(upstreamHeadroom(undefined,{})).toBe(0)
    expect(upstreamHeadroom(16000,{messages:'x'.repeat(10000)},8192)).toBe(0)
    expect(upstreamHeadroom(64000,{tools:'x'.repeat(50000)},8192)).toBeLessThan(2000)
  })
  it('registers tools only with Maintenance and rejects drafts, foreign and revoked references',async()=>{
    const f=await fixture(),registered:any[]=[]
    f.ctx.provide('tools',{register:(tool:any)=>{registered.push(tool)}} as never)
    registerUpstreamTools(f.ctx,f.store,new UpstreamToolBudgets())
    await vi.waitFor(()=>expect(registered).toHaveLength(2))
    expect(registered.map(t=>t.name)).toEqual(['dsh_upstream_read','dsh_upstream_search'])
    const exec={agent:f.agent,signal:new AbortController().signal}
    await expect(registered[0].execute({referenceId:'missing'},exec)).rejects.toThrow('没有')
    const result=await registered[0].execute({referenceId:'reference'},exec)
    expect(JSON.parse(result).items[1].text).toContain('bounded upstream')
    expect(f.bridge.read).toHaveBeenLastCalledWith(expect.objectContaining({targetNativeSessionId:'target',executionId:'turn:100:10',maxBytes:8000}))
    await f.store.deleteReferenceLink('target',{expectedRevision:f.store.read('target').revision,setId:'set',referenceId:'reference',deletedAt:5})
    await expect(registered[0].execute({referenceId:'reference'},exec)).rejects.toThrow('没有')
  })
  it('waits for trusted inner usage, then shares a bounded Codex allowance without counting outer history twice',async()=>{
    const f=await fixture()
    const agent={...f.agent,session:{...f.agent.session,requestContext:()=>({provider:'codex'}),
      deriveMessages:()=>[{content:[{type:'image',url:'opaque'}, {type:'text',text:'x'.repeat(100000)}]}]}} as unknown as Agent
    let usage:NativeUpstreamUsage|undefined
    const resolver=vi.fn(()=>usage),budget=new UpstreamToolBudgets(resolver)
    expect(()=>budget.reserve(agent)).toThrow('尚未确认')
    usage={executionId:'native-live',modelContextWindow:65536,inputTokens:44000,outputTokens:1000}
    const first=budget.reserve(agent)
    expect(first.bytes).toBe(8000)
    expect(first.totalBytes).toBe(8248)
    expect(resolver).toHaveBeenLastCalledWith('target')
    first.settle('x'.repeat(8000))
    expect(()=>budget.reserve(agent)).toThrow('额度')
    usage=undefined
    expect(()=>budget.reserve(agent)).toThrow('尚未确认')
    f.events.push({type:'turn/start',seq:200,time:20})
    usage={executionId:'native-next',modelContextWindow:65536,inputTokens:1000,outputTokens:100}
    expect(budget.reserve(agent).bytes).toBe(8000)
    expect(()=>new UpstreamToolBudgets().reserve(agent)).toThrow('尚未确认')
  })
  it('exports the exact native definitions when Runtime Support arrives and revokes exports on unload',async()=>{
    const f=await fixture(),registered:any[]=[],exported=new Map<string,any>(),retired:string[]=[]
    f.ctx.provide('tools',{register:(tool:any)=>{registered.push(tool)}} as never)
    const fiber=f.ctx.plugin({name:'upstream-managed-test',apply(child){registerUpstreamTools(child,f.store,new UpstreamToolBudgets())}})
    await fiber
    await vi.waitFor(()=>expect(registered).toHaveLength(2))
    expect(exported.size).toBe(0)
    const exportTool=vi.fn((tool:any)=>{
      exported.set(tool.name,tool)
      return()=>{exported.delete(tool.name);retired.push(tool.name)}
    })
    f.ctx.provide('dshRuntimeSupport' as never,{apiVersion:1,managedTools:{exportTool}})
    await vi.waitFor(()=>expect(exported.size).toBe(2))
    for(const tool of registered)expect(exported.get(tool.name)).toBe(tool)
    await fiber.dispose()
    expect(exported.size).toBe(0)
    expect(retired.sort()).toEqual(['dsh_upstream_read','dsh_upstream_search'])
  })
})
