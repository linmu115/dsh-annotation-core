import { ReferenceHighlights, ReferenceHighlightStore } from '../../src/client/reference-highlights.tsx'
import { createRoot } from 'react-dom/client'
import { ReferenceRail } from '../../src/client/reference-rail.tsx'
import { AnnotationDialogController, ReferenceDialog } from '../../src/client/reference-dialog.tsx'
import { ClientSourceRegistry } from '../../src/client/source-registry.ts'
import type { ReferenceSet } from '../../src/domain/model.ts'
import type { ReferenceSessionStore } from '../../src/client/composer-binding.tsx'
import '../../src/client/styles.css'
let pending: ReferenceSet = { schemaVersion: 1, setId: 'demo', profileId: 'web', sessionId: 'current', state: 'pending', revision: 1, createdAt: 1,
  items: [
    { referenceId: 'one', number: 1, sourceType: 'dsh-message', selectedText: '将引用收起为数量气泡，鼠标悬停时展开，点击后修改注释。', userComment: '请结合上下文解释这一段。', backlinkState: 'not-required', locator: { profileId: 'web', sessionId: 'current', anchorId: 'anchor', role: 'assistant', occurrence: 0, selectedTextHash: 'hash' } },
    { referenceId: 'two', number: 2, sourceType: 'dsh-message', selectedText: '跨会话引用保留来源位置，方便回到原文继续阅读。', userComment: '', backlinkState: 'not-required', locator: { profileId: 'web', sessionId: 'current', anchorId: 'anchor', role: 'assistant', occurrence: 0, selectedTextHash: 'hash' } },
  ] }
if (new URLSearchParams(location.search).has("single")) pending = { ...pending, items: pending.items.slice(0, 1) }
const highlights = new ReferenceHighlightStore(); highlights.update('pending', pending)
const listeners = new Set<() => void>()
let snapshot = { status: 'ready', revision: 1, pending }
const controller = new AnnotationDialogController()
const publish = () => { highlights.update('pending', pending); snapshot = { ...snapshot, pending }; listeners.forEach(fn => fn()); controller.replace(pending) }
const store = { subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot } as unknown as ReferenceSessionStore
const sources = new ClientSourceRegistry()
const jump = async () => { document.querySelector('#status')!.textContent = '已调用来源跳转' }
sources.register('dsh-message', { openSource: jump })
const remove = async (id: string) => { pending = { ...pending, items: pending.items.filter(item => item.referenceId !== id) }; publish(); if (!pending.items.length) controller.close() }
createRoot(document.querySelector('#app')!).render(<><p data-chat-anchor-key="anchor">{pending.items[0]!.selectedText} {pending.items[1]?.selectedText}</p><ReferenceHighlights store={highlights} currentSession={() => "current"} subscribeSession={() => () => {}} resolveAnchor={() => "anchor"} /><div data-composer-seat><div className="dshAnnotationNativeDock"><div className="dshAnnotationNativeDockInner"><ReferenceRail layout="default" store={store} open={(set,id,anchor) => controller.open(set,id,anchor)} remove={remove} jump={jump} /></div></div><div className="composer" data-composer-card><textarea className="chat" placeholder="输入消息，也可以仅发送引用" /></div></div><p id="status">合成数据预览</p><button onClick={() => controller.open({ ...pending, state: "sent" })}>查看已发送引用</button><ReferenceDialog controller={controller} sources={sources} updateComment={async (id, comment) => { pending = { ...pending, items: pending.items.map(item => item.referenceId === id ? { ...item, userComment: comment } : item) }; publish() }} remove={remove} deleteLink={async () => {}} reuse={async () => {}} retryBacklink={async () => {}} /></>)
