import type { Context } from '@deepseek-ai/cordis'
import type { ReferenceItem } from '../domain/model.ts'
import type { DshMessageCapture, DshMessageReferenceSource } from '../protocol/index.ts'
import { selectedTextHash } from '../protocol/index.ts'
import { PreparedUpstreamContextSchema } from '../domain/upstream-context.ts'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

/** Structural subset of the optional host capability; Engine owns the full DTO and all range rules. */
export interface UpstreamHost {
  readonly protocolVersion: 1
  directory(workspaceId?: string, after?: string): Promise<{ items: {id:string;title:string}[];nextCursor:string|null }>
  capture(input:{operationId:string;sourceNativeSessionId:string;targetNativeSessionId:string;anchorId:string;selectedText:string;expectedSourceVersionId?:string}): Promise<{
    referenceId:string;sourceTitle:string;sourceVersionId:string;cutoffEventId:string;selectedText:string
  }>
  inspect(targetNativeSessionId:string,referenceId:string): Promise<{selectedText:string;sourceVersionId:string;cutoffEventId:string}>
  bind(targetNativeSessionId:string,referenceId:string,targetMessageId:string|null): Promise<unknown>
  describe?(targetNativeSessionId:string,referenceId:string):Promise<unknown>
  status?(targetNativeSessionId:string,referenceId:string):Promise<{referenceId:string;state:'pending'|'sent'|'revoked'}>
  settleRead?(targetNativeSessionId:string,referenceId:string,requestId:string,delivery:'returned'|'failed'):Promise<unknown>
  read(input:{targetNativeSessionId:string;referenceId:string;executionId:string;requestId?:string;userRequestId?:string;cursor?:string;query?:string;view?:'selected-turn';maxBytes:number;totalBytes:number}):Promise<unknown>
  endExecution?(targetNativeSessionId:string,executionId:string):Promise<unknown>
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
    anchorId:capture.messageId??capture.anchorId,selectedText:capture.selectedText,
    ...(capture.expectedSourceVersionId === undefined ? {} : {expectedSourceVersionId:capture.expectedSourceVersionId})})
  if (capture.expectedSourceVersionId && saved.sourceVersionId !== capture.expectedSourceVersionId)
    throw new Error('来源版本与所选材料不一致，请重新选择回复')
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

/** Resolve the saved immutable reference through the target-scoped host, never a fresh capture. */
export async function describeGraphUpstream(ctx:Context,targetSessionId:string,profileId:string,referenceId:string) {
  const host=upstreamHost(ctx)
  if (!host.describe) throw new Error('Maintenance 尚未提供主干图引用接入，请更新匹配的适配器')
  const value=z.object({sourceNativeSessionId:z.string().min(1),record:z.object({
    referenceId:z.literal(referenceId),sourceAnchorId:z.string().min(1),sourceVersionId:z.string().min(1),
    cutoffEventId:z.string().min(1),sourceTitle:z.string(),selectedText:z.string(),state:z.enum(['pending','sent']),
  })}).parse(await host.describe(targetSessionId,referenceId))
  const record=value.record
  const source:DshMessageReferenceSource={sourceType:'dsh-message',selectedText:record.selectedText,
    locator:{profileId,sessionId:value.sourceNativeSessionId,messageId:record.sourceAnchorId,anchorId:record.sourceAnchorId,
      role:'assistant',occurrence:0,selectedTextHash:selectedTextHash(record.selectedText),
      upstream:{kind:'fixed-upstream',referenceId,sourceTitle:record.sourceTitle,sourceVersionId:record.sourceVersionId,
        cutoffEventId:record.cutoffEventId,targetSessionId}}}
  return {source,state:record.state}
}

export async function prepareInitialUpstream(ctx: Context, item: ReferenceItem, executionId: string, maxBytes: number, totalBytes: number) {
  const ref = upstreamOf(item)
  if (!ref) throw new Error('引用没有固定上游来源')
  const host = upstreamHost(ctx), requestId=randomUUID()
  const result = await upstreamHost(ctx).read({targetNativeSessionId:ref.targetSessionId,referenceId:ref.referenceId,
    executionId,requestId,view:'selected-turn',maxBytes:host.settleRead?Math.max(1024,maxBytes-192):maxBytes,totalBytes})
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error('首轮上下文超过已预留额度')
  const page = z.object({
    referenceId:z.literal(ref.referenceId), sourceVersionId:z.literal(ref.sourceVersionId), cutoffEventId:z.literal(ref.cutoffEventId),
    items:PreparedUpstreamContextSchema.shape.items, nextCursor:PreparedUpstreamContextSchema.shape.nextCursor,
    hasMore:z.boolean(), selectedTurn:z.object({complete:z.boolean(),
      omittedIntermediateItems:z.number().int().nonnegative().optional(),detailsCursor:z.string().max(2048).optional()}),
  }).parse(result)
  const prepared=PreparedUpstreamContextSchema.parse({kind:'selected-turn',sourceVersionId:page.sourceVersionId,
    cutoffEventId:page.cutoffEventId,items:page.items,turnComplete:page.selectedTurn.complete,
    nextCursor:page.nextCursor,hasMore:page.hasMore,
    ...(page.selectedTurn.omittedIntermediateItems === undefined ? {} : {omittedIntermediateItems:page.selectedTurn.omittedIntermediateItems}),
    ...(page.selectedTurn.detailsCursor === undefined ? {} : {detailsCursor:page.selectedTurn.detailsCursor}),
    ...(host.settleRead ? {disclosureRequestId:requestId} : {})})
  if(Buffer.byteLength(JSON.stringify(prepared))>maxBytes)throw new Error('首轮上下文超过已预留额度')
  return prepared
}
