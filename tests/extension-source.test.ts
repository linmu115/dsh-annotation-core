import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { addReference, createPendingReferenceSet } from '../src/domain/state-machine.ts'
import { HostSourceRegistry } from '../src/host/source-registry.ts'
import { prepareReferenceSet } from '../src/host/prepare-reference-set.ts'
import { documentHash, selectedTextHash } from '../src/protocol/index.ts'
import { ReferenceSetSchema } from '../src/host/store.ts'

it('registers a new source namespace, persists it and stops preparation on removal without losing data', async () => {
  const selectedText = 'A quoted source paragraph'
  const set = addReference(createPendingReferenceSet({ setId: 'set', profileId: 'web', sessionId: 'target', createdAt: 1 }), {
    referenceId: 'custom-ref', source: { sourceType: 'extension', selectedText,
      locator: { providerId: 'example-reader', objectId: 'chapter-1', revision: 'v1', selectedTextHash: selectedTextHash(selectedText) },
      snapshot: { markdown: selectedText, documentHash: documentHash(selectedText), capturedAt: 1, freshness: 'captured' } },
  }, 0).set
  const reopened = ReferenceSetSchema.parse(JSON.parse(JSON.stringify(set))) as typeof set
  const registry = new HostSourceRegistry(new Context())
  const unregister = registry.registerSourceAdapter('extension:example-reader', { prepare: async item => item })
  const options = { signal: new AbortController().signal }
  expect((await prepareReferenceSet(reopened, registry, options)).kind).toBe('ready')
  unregister()
  expect((await prepareReferenceSet(reopened, registry, options)).kind).toBe('blocked')
  expect(reopened.items[0]?.selectedText).toBe(selectedText)
})
