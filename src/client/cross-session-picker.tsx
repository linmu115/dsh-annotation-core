import { useEffect,useRef,useState } from 'react'
import { createRoot } from 'react-dom/client'

export interface TargetPage {items:{id:string;title:string}[];nextCursor:string|null}
export interface CrossSessionPickerPort {
  list(workspaceId?:string,after?:string):Promise<TargetPage>
  select(sessionId:string):Promise<void>
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
  return <div style={{position:'fixed',inset:0,zIndex:1000000,background:'#0006',display:'grid',placeItems:'center'}} onMouseDown={e=>e.stopPropagation()}>
    <section role="dialog" aria-modal="true" aria-label="跨会话引用" style={{width:'min(480px,90vw)',background:'var(--background-color, #202127)',color:'var(--text-color, #eee)',border:'1px solid #7777',borderRadius:14,padding:20,boxShadow:'0 18px 70px #0008'}}>
      <header style={{display:'flex',justifyContent:'space-between',gap:12}}><strong>跨会话引用</strong><button type="button" disabled={busy} onClick={close} aria-label="关闭跨会话引用">×</button></header>
      <p style={{fontSize:13,opacity:.75}}>选择工作区和目标会话。引用包含来源开头至该回复完整结束的上游，AI 按需读取。</p>
      {workspace&&<button type="button" disabled={busy} onClick={()=>{serial.current++;setWorkspace(undefined);setError('');setPage(back.current!.page);requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop=back.current?.top??0})}}>← 工作区 / {workspace.title}</button>}
      <div ref={scroll} style={{maxHeight:'min(50vh,420px)',overflowY:'auto',overscrollBehavior:'contain',marginTop:12}}>
        {page.items.map(item=><button type="button" key={item.id} disabled={busy} style={{display:'block',width:'100%',textAlign:'left',padding:'10px 12px',marginBottom:4,overflowWrap:'anywhere',background:'#8881',border:'1px solid #8883',borderRadius:6,color:'inherit'}} onClick={()=>{
          if(!workspace){back.current={page,top:scroll.current?.scrollTop??0};setWorkspace(item);setPage({items:[],nextCursor:null});void load(item.id)}
          else {setBusy(true);setError('');void port.select(item.id).then(close).catch(e=>setError(e instanceof Error?e.message:String(e))).finally(()=>setBusy(false))}
        }}>{workspace?'↗':'▸'} {item.title||'未命名会话'}</button>)}
        {page.nextCursor&&<button type="button" disabled={busy} onClick={()=>void load(workspace?.id,page.nextCursor!)}>加载更多</button>}
        {!busy&&page.items.length===0&&!error&&<p>暂无可用{workspace?'会话':'工作区'}</p>}
      </div>
      {busy&&<p role="status">正在加载…</p>}
      {error&&<div role="alert"><p>{error}</p><button type="button" onClick={()=>void load(workspace?.id)}>重试列表</button></div>}
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
