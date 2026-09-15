// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrossSessionPicker } from '../src/client/cross-session-picker.tsx'
import { AnnotationCoreClientService } from '../src/client/service.tsx'
import { Context } from '@deepseek-ai/cordis'
import { sessionTargetTitle } from '../src/client/session-target-title.ts'

const roots:ReturnType<typeof createRoot>[]=[]
afterEach(()=>{for(const root of roots.splice(0))act(()=>root.unmount());document.body.replaceChildren();vi.restoreAllMocks()})
function button(text:string){const found=[...document.querySelectorAll('button')].find(button=>button.textContent?.includes(text));if(!found)throw new Error('Button missing: '+text);return found}
async function click(text:string){await act(async()=>button(text).click())}

describe('workspace selection and real target composer navigation',()=>{
  it('shows workspaces first, paginates sessions, restores scroll and retains selection on a failed open',async()=>{
    const list=vi.fn(async(workspace?:string,after?:string)=>workspace
      ? {items:[{id:after?'cold-201':'first',title:after?'Cold session 201':'First session'}],nextCursor:after?null:'page-one'}
      : {items:[{id:'workspace',title:'Workspace'}],nextCursor:null})
    const select=vi.fn(async()=>{throw new Error('Target is unavailable')}),close=vi.fn()
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root)
    await act(async()=>root.render(<CrossSessionPicker port={{list,select}} close={close}/>))
    expect(list).toHaveBeenCalledExactlyOnceWith(undefined,undefined)
    await click('Workspace');await click('加载更多')
    expect(list).toHaveBeenLastCalledWith('workspace','page-one')
    await click('Cold session 201');expect(select).toHaveBeenCalledWith('cold-201')
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Target is unavailable');expect(close).not.toHaveBeenCalled()
    await click('工作区');expect(button('Workspace')).toBeDefined()
  })
  it('opens the full target, waits for its composer and adds one bubble without editing either draft or attachment',async()=>{
    const ctx=new Context();let current='source'
    const drafts={source:'source draft',target:'target draft'},attachments={source:['a.png'],target:['b.pdf']}
    let core:AnnotationCoreClientService
    const open=vi.fn((id:string)=>{current=id;core.registerNativeComposer(id)})
    const refresh=vi.fn(async()=>{})
    ctx.provide('sessions',{refresh,open,list:{getSnapshot:()=>({current,byId:{target:{title:'目标会话名称',displayTitle:'目标会话名称'},workspace:{title:'不能覆盖工作区'}}})}} as never)
    core=new AnnotationCoreClientService(ctx,{profileId:'web'})
    const capture={sourceSessionId:'source',anchorId:'reply',role:'assistant' as const,occurrence:0,selectedText:'quoted'}
    const saved={sourceType:'dsh-message',selectedText:'quoted',locator:{upstream:{kind:'fixed-upstream',referenceId:'one-reference'}}}
    const remote={upstreamDirectory:vi.fn(async(request:{workspaceId?:string})=>({ok:true,value:{items:[request.workspaceId?{id:'target',title:'DSH session session-793cbb1b-b626-410c-b881-4030cdddd5a7'}:{id:'workspace',title:'Workspace'}],nextCursor:null}})),
      captureUpstream:vi.fn(async()=>({ok:true,value:saved}))}
    vi.spyOn(core as any,'remote').mockReturnValue(remote)
    const add=vi.spyOn(core,'addReference').mockResolvedValue({setId:'set',referenceId:'one-reference'} as never)
    let task!:Promise<void>
    await act(async()=>{task=core.openCrossSessionReference(capture);expect(core.openCrossSessionReference(capture)).toBe(task)})
    await click('Workspace')
    expect(document.querySelector('[aria-label="目标会话"]')?.textContent).not.toContain('793cbb1b')
    expect(refresh).not.toHaveBeenCalled()
    await click('目标会话名称');await task
    expect(open).toHaveBeenCalledExactlyOnceWith('target')
    expect(add).toHaveBeenCalledExactlyOnceWith('target',saved,expect.objectContaining({referenceId:'one-reference'}))
    expect(drafts).toEqual({source:'source draft',target:'target draft'});expect(attachments).toEqual({source:['a.png'],target:['b.pdf']})
    expect(document.querySelector('[aria-label="跨会话引用"]')).toBeNull()
  })
  it('keeps cold-session names and does not let generated native display labels replace them',()=>{
    expect(sessionTargetTitle({id:'cold',title:'历史会话名称'})).toBe('历史会话名称')
    expect(sessionTargetTitle({id:'cold',title:'历史会话名称'},{displayTitle:'项目目录'})).toBe('历史会话名称')
    expect(sessionTargetTitle({id:'cold',title:'cold'},{displayTitle:'项目目录'})).toBe('项目目录')
    expect(sessionTargetTitle({id:'cold',title:'DSH session session-old'},{title:'刚改好的名称'})).toBe('刚改好的名称')
    expect(sessionTargetTitle({id:'cold',title:'cold'},{displayTitle:'cold'})).toBe('未命名会话')
  })
})
