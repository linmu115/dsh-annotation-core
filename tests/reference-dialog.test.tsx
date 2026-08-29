// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnnotationDialogController, ReferenceDialog } from '../src/client/reference-dialog.tsx'
import { ClientSourceRegistry } from '../src/client/source-registry.ts'
import type { ReferenceSet } from '../src/domain/model.ts'
import { selectedTextHash } from '../src/protocol/index.ts'

const roots: ReturnType<typeof createRoot>[] = []
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
})

function pendingSet(): ReferenceSet {
  return {
    schemaVersion: 1, setId: 'set-1', profileId: 'web', sessionId: 'session-1', state: 'pending', revision: 1, createdAt: 1,
    items: ['first selected text', 'second selected text'].map((selectedText, index) => ({
      referenceId: `reference-${index + 1}`, number: index + 1, sourceType: 'dsh-message' as const,
      selectedText, userComment: index === 0 ? 'existing note' : '', backlinkState: 'not-required' as const,
      locator: { profileId: 'web', sessionId: 'source', anchorId: `anchor-${index}`, role: 'user' as const, occurrence: 0, selectedTextHash: selectedTextHash(selectedText) },
    })),
  }
}

function renderDialog(controller: AnnotationDialogController, updateComment = vi.fn(() => Promise.resolve())) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(<ReferenceDialog
    controller={controller}
    sources={new ClientSourceRegistry()}
    updateComment={updateComment}
    remove={() => Promise.resolve()}
    deleteLink={() => Promise.resolve()}
    reuse={() => Promise.resolve()}
    retryBacklink={() => Promise.resolve()}
  />))
  return { updateComment }
}

describe('floating annotation details', () => {
  it('renders a non-modal floating window and only the selected annotation', async () => {
    const controller = new AnnotationDialogController()
    renderDialog(controller)
    await act(async () => controller.open(pendingSet(), 'reference-2'))

    const dialog = document.querySelector('[data-annotation-floating-window]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('aria-modal')).toBe('false')
    expect(document.querySelector('.dshAnnotationDialogBackdrop')).toBeNull()
    expect(document.querySelectorAll('[data-annotation-reference]')).toHaveLength(1)
    expect(document.body.textContent).toContain('second selected text')
    expect(document.body.textContent).not.toContain('first selected text')
  })

  it('switches annotations in place and saves the polished comment field on blur', async () => {
    const controller = new AnnotationDialogController()
    const updateComment = vi.fn(() => Promise.resolve())
    renderDialog(controller, updateComment)
    await act(async () => controller.open(pendingSet(), 'reference-1'))

    await act(async () => (document.querySelector('[aria-label="查看注释 2"]') as HTMLButtonElement).click())
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.placeholder).toContain('希望模型特别关注')
    await act(async () => {
      textarea.focus()
      textarea.value = 'new note'
      textarea.blur()
    })
    expect(updateComment).toHaveBeenCalledWith('reference-2', 'new note')
  })

  it('closes with Escape without placing a page-wide click blocker', async () => {
    const controller = new AnnotationDialogController()
    renderDialog(controller)
    await act(async () => controller.open(pendingSet()))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[data-annotation-floating-window]')).toBeNull()
  })
})
