import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// rc.2 compatibility: only an explicit owner claim may submit an empty editor.
export function patchNativeReferenceInput(source) {
  const edits = [
    ['const empty = draft.trim() === "" && attachments.length === 0;', 'const empty = draft.trim() === "" && attachments.length === 0 && !(input?.phase === "claimed" && input.claim?.allowEmpty === true);'],
    ['if (this.snapshot.draft.trim() === "" && this.attachmentIds.length > 0) {', 'if (this.snapshot.draft.trim() === "" && this.attachmentIds.length > 0 && !(this.snapshot.phase === "claimed" && this.snapshot.claim?.allowEmpty === true)) {'],
  ]
  for (const [before, after] of edits) {
    if (source.includes(after)) continue
    if (source.split(before).length !== 2) throw new Error('Unsupported native conversation build; no files changed')
    source = source.replace(before, after)
  }
  return source
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = process.argv[2]
  if (!target) throw new Error('Pass the rc.2 ui-conversation lib/client.js path')
  const source = readFileSync(target, 'utf8')
  const patched = patchNativeReferenceInput(source)
  if (patched !== source) writeFileSync(target, patched)
}
