// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReferenceHighlights, ReferenceHighlightStore } from '../src/client/reference-highlights.tsx';
import type { ReferenceSet } from '../src/domain/model.ts';
it('restores sent highlights across DOM replacement and removes only its own registry entry', async () => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
 const registry = new Map<string, unknown>(); registry.set('sticker-owner', 'untouched');
 vi.stubGlobal('CSS', { highlights: registry, escape: (value:string)=>value });
 vi.stubGlobal('Highlight', class { constructor(...ranges: Range[]) { return {ranges} } });
 vi.stubGlobal('requestAnimationFrame', (fn:()=>void)=>setTimeout(fn,0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
 const host = document.createElement('div'), message = document.createElement('p'); message.dataset.chatAnchorKey='a'; message.textContent='source text'; document.body.append(host,message);
 const root = createRoot(host), store = new ReferenceHighlightStore();
 const set: ReferenceSet = {schemaVersion:1,setId:'set',profileId:'web',sessionId:'s',state:'pending',revision:1,createdAt:1,items:[{referenceId:'r',number:1,sourceType:'dsh-message',selectedText:'source text',userComment:'',backlinkState:'not-required',locator:{profileId:'web',sessionId:'s',anchorId:'a',role:'user',occurrence:0,selectedTextHash:'hash'}}]};
 const flush = async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})};
 const count = ()=>(registry.get('dsh-core-references') as {ranges:Range[]}).ranges.length;
 try {
  await act(async()=>root.render(<ReferenceHighlights store={store} currentSession={()=>'s'} subscribeSession={()=>()=>{}} resolveAnchor={()=>'a'}/>));
  store.update('pending',set); await flush(); expect(count()).toBe(1);
  store.update('sent',set); store.update('pending',null); await flush(); expect(count()).toBe(1);
  message.innerHTML='<strong>source</strong> text'; await flush(); expect(count()).toBe(1);
  store.update('sent',null); await flush(); expect(count()).toBe(0);
  expect(registry.get('sticker-owner')).toBe('untouched');
 } finally { await act(async()=>root.unmount()); host.remove(); message.remove(); vi.unstubAllGlobals(); }
 expect(registry.has('dsh-core-references')).toBe(false);
});
