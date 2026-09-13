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
import { availableReferenceSets } from '../src/host/reference-tools.ts'
import { prepareReferenceSet } from '../src/host/prepare-reference-set.ts'

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
  const bridge={protocolVersion:1,bind:vi.fn(async()=>({})),inspect:vi.fn(async()=>({selectedText:'selected',sourceVersionId:'v1',cutoffEventId:'completed-answer'})),
    read:vi.fn(async()=>({items:[{text:'bounded upstream'}]}))}
  ctx.provide('maintenanceSessionContext' as never,bridge)
  const registry=new HostSourceRegistry(ctx)
  const events=[{type:'turn/start',seq:100,time:10}]
  const agent={id:'target',ctx,session:{id:'target',inheritedEventCount:0,header:{},snapshotEvents:()=>events,
    requestContext:()=>({contextWindow:65536}),requestHeader:()=>({config:{maxTokens:8192},tools:[]}),deriveMessages:()=>[]}} as unknown as Agent
  return {ctx,store,bridge,registry,agent,events}
}
describe('fixed upstream annotation lifecycle and model access',()=>{
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
    expect(JSON.parse(result).items[0].text).toBe('bounded upstream')
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
