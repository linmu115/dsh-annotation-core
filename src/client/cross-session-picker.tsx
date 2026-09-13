import { useEffect,useRef,useState } from 'react'
import { createRoot } from 'react-dom/client'

export interface TargetPage {items:{id:string;title:string}[];nextCursor:string|null}
export interface CrossSessionPickerPort {
  list(workspaceId?:string,after?:string):Promise<TargetPage>
  select(sessionId:string):Promise<void>
}

function PickerIcon({kind}:{kind:'folder'|'session'|'back'|'next'|'close'|'warning'}) {
  const paths={
    folder:'M3 6.5h6l2 2h10v11H3z M3 6.5v-2h6l2 2h10v2',
    session:'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L4 21V6A1.5 1.5 0 0 1 5.5 4.5 M8 9h9 M8 13h6',
    back:'m14 6-6 6 6 6',
    next:'m9 6 6 6-6 6',
    close:'m6 6 12 12 M18 6 6 18',
    warning:'M12 8v5 M12 17h.01 M10.3 4.8 2.5 18a1.5 1.5 0 0 0 1.3 2.2h16.4a1.5 1.5 0 0 0 1.3-2.2L13.7 4.8a2 2 0 0 0-3.4 0',
  }
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>
}

export function CrossSessionPicker({port,close}:{port:CrossSessionPickerPort;close:()=>void}) {
  const [workspace,setWorkspace]=useState<{id:string;title:string}>()
  const [page,setPage]=useState<TargetPage>({items:[],nextCursor:null})
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const serial=useRef(0),scroll=useRef<HTMLDivElement>(null),back=useRef<{page:TargetPage;top:number}>()
  const load=async(id?:string,after?:string)=>{
    const request=++serial.current;setBusy(true);setError('')
    try {const next=await port.list(id,after);if(request!==serial.current)return;setPage(old=>({items:after?[...old.items,...next.items]:next.items,nextCursor:next.nextCursor}))}
    catch(e){if(request===serial.current)setError(e instanceof Error?e.message:String(e))}
    finally {if(request===serial.current)setBusy(false)}
  }
  useEffect(()=>{void load();return()=>{serial.current++}},[])
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy)close()};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape)},[busy,close])
  return <div className="dshCrossSessionOverlay" onMouseDown={e=>e.stopPropagation()}>
    <div className="dshCrossSessionMask" aria-hidden="true"/>
    <section className="dshCrossSessionDialog" role="dialog" aria-modal="true" aria-label="跨会话引用">
      <header className="dshCrossSessionHeader">
        <h2>跨会话引用</h2>
        <button className="dshCrossSessionIconButton" type="button" disabled={busy} onClick={close} aria-label="关闭跨会话引用"><PickerIcon kind="close"/></button>
      </header>
      <p className="dshCrossSessionDescription">选择接收引用的会话，保留来源到这条回复结束的上下文。</p>
      <div className="dshCrossSessionNavigation">
        {workspace
          ? <nav aria-label="引用目标位置">
            <button className="dshCrossSessionBack" type="button" disabled={busy} aria-label="返回工作区" onClick={()=>{serial.current++;setWorkspace(undefined);setError('');setPage(back.current!.page);requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop=back.current?.top??0})}}><PickerIcon kind="back"/><span>工作区</span></button>
            <span className="dshCrossSessionSeparator" aria-hidden="true">/</span>
            <span className="dshCrossSessionCurrent" title={workspace.title}>{workspace.title}</span>
          </nav>
          : <span className="dshCrossSessionSectionTitle">选择工作区</span>}
        <span className="dshCrossSessionStep">{workspace?'2':'1'} / 2</span>
      </div>
      <div className="dshCrossSessionList" ref={scroll} aria-label={workspace?'目标会话':'工作区列表'} aria-busy={busy}>
        {page.items.map(item=><button className="dshCrossSessionRow" type="button" key={item.id} disabled={busy} onClick={()=>{
          if(!workspace){back.current={page,top:scroll.current?.scrollTop??0};setWorkspace(item);setPage({items:[],nextCursor:null});void load(item.id)}
          else {setBusy(true);setError('');void port.select(item.id).then(close).catch(e=>setError(e instanceof Error?e.message:String(e))).finally(()=>setBusy(false))}
        }}>
          <span className="dshCrossSessionRowIcon"><PickerIcon kind={workspace?'session':'folder'}/></span>
          <span className="dshCrossSessionRowTitle" title={item.title}>{item.title||(workspace?'未命名会话':'未命名工作区')}</span>
          <span className="dshCrossSessionRowArrow"><PickerIcon kind="next"/></span>
        </button>)}
        {page.nextCursor&&<button className="dshCrossSessionMore" type="button" disabled={busy} onClick={()=>void load(workspace?.id,page.nextCursor!)}>加载更多</button>}
        {!busy&&page.items.length===0&&!error&&<div className="dshCrossSessionEmpty"><PickerIcon kind={workspace?'session':'folder'}/><p>暂无可用{workspace?'会话':'工作区'}</p></div>}
        {busy&&<div className="dshCrossSessionLoading" role="status"><span className="dshCrossSessionSpinner" aria-hidden="true"/>正在加载…</div>}
        {error&&<div className="dshCrossSessionError" role="alert">
          <PickerIcon kind="warning"/>
          <div><strong>操作未完成</strong><p>{error}</p><span>选区已保留，可以稍后重试。</span></div>
          <button className="dshCrossSessionRetry" type="button" onClick={()=>void load(workspace?.id)}>重试列表</button>
        </div>}
      </div>
      <footer className="dshCrossSessionFooter"><span>AI 会按需读取引用的上游上下文</span><span className="dshCrossSessionEscape">Esc 关闭</span></footer>
    </section>
  </div>
}

/** The modal owns no transcript or draft state and survives source-page navigation. */
export function chooseCrossSession(port:CrossSessionPickerPort,signal?:AbortSignal):Promise<void>{
  return new Promise(resolve=>{const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container)
    let closed=false
    const close=()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',close);root.unmount();container.remove();resolve()}
    if(signal?.aborted){close();return}
    signal?.addEventListener('abort',close,{once:true})
    root.render(<CrossSessionPicker port={port} close={close}/> )
  })
}
