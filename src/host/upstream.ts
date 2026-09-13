import type { Context } from '@deepseek-ai/cordis'
import type { ReferenceItem } from '../domain/model.ts'
import type { DshMessageCapture, DshMessageReferenceSource } from '../protocol/index.ts'
import { selectedTextHash } from '../protocol/index.ts'

/** Structural subset of the optional host capability; Engine owns the full DTO and all range rules. */
export interface UpstreamHost {
  readonly protocolVersion: 1
  directory(workspaceId?: string, after?: string): Promise<{ items: {id:string;title:string}[];nextCursor:string|null }>
  capture(input:{operationId:string;sourceNativeSessionId:string;targetNativeSessionId:string;anchorId:string;selectedText:string}): Promise<{
    referenceId:string;sourceTitle:string;sourceVersionId:string;cutoffEventId:string;selectedText:string
  }>
  inspect(targetNativeSessionId:string,referenceId:string): Promise<{selectedText:string;sourceVersionId:string;cutoffEventId:string}>
  bind(targetNativeSessionId:string,referenceId:string,targetMessageId:string|null): Promise<unknown>
  read(input:{targetNativeSessionId:string;referenceId:string;executionId:string;cursor?:string;query?:string;maxBytes:number;totalBytes:number}):Promise<unknown>
}
export function upstreamHost(ctx:Context):UpstreamHost {
  const bridge=ctx.get('maintenanceSessionContext' as never) as UpstreamHost|undefined
  if(bridge?.protocolVersion!==1)throw new Error('当前实例尚未接通 Maintenance 跨会话引用能力')
  return bridge
}
export function upstreamOf(item:ReferenceItem){return item.sourceType==='dsh-message'?item.locator.upstream:undefined}
export async function captureUpstream(ctx:Context,targetSessionId:string,profileId:string,capture:DshMessageCapture,operationId:string):Promise<DshMessageReferenceSource>{
  if(capture.role!=='assistant')throw new Error('请选择一条已完成的 AI 回复')
  const saved=await upstreamHost(ctx).capture({operationId,sourceNativeSessionId:capture.sourceSessionId,targetNativeSessionId:targetSessionId,
    anchorId:capture.messageId??capture.anchorId,selectedText:capture.selectedText})
  return {sourceType:'dsh-message',selectedText:capture.selectedText,locator:{profileId,sessionId:capture.sourceSessionId,
    anchorId:capture.anchorId,role:'assistant',occurrence:capture.occurrence,selectedTextHash:selectedTextHash(capture.selectedText),
    upstream:{kind:'fixed-upstream',referenceId:saved.referenceId,sourceTitle:saved.sourceTitle,sourceVersionId:saved.sourceVersionId,
      cutoffEventId:saved.cutoffEventId,targetSessionId}}}
}
export async function inspectUpstream(ctx:Context,item:ReferenceItem):Promise<void>{
  const ref=upstreamOf(item);if(!ref)return
  const current=await upstreamHost(ctx).inspect(ref.targetSessionId,ref.referenceId)
  if(current.selectedText!==item.selectedText||current.sourceVersionId!==ref.sourceVersionId||current.cutoffEventId!==ref.cutoffEventId)
    throw new Error('引用气泡与 Maintenance 中的固定来源不一致，请重新选择')
}
