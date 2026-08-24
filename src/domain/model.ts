import type {
  DshMessageLocator,
  ObsidianNoteLocator,
  ReferenceSource,
  SourceSnapshot,
} from '../protocol/index.ts'

export const REFERENCE_SET_SCHEMA_VERSION = 1 as const

export type ReferenceSetState = 'pending' | 'committing' | 'sent' | 'failed'
export type BacklinkState = 'not-required' | 'pending' | 'written' | 'failed'

interface ReferenceItemBase {
  readonly referenceId: string
  readonly number: number
  readonly selectedText: string
  readonly userComment: string
  readonly backlinkState: BacklinkState
}

export interface DshMessageReferenceItem extends ReferenceItemBase {
  readonly sourceType: 'dsh-message'
  readonly locator: DshMessageLocator
}

export interface ObsidianNoteReferenceItem extends ReferenceItemBase {
  readonly sourceType: 'obsidian-note'
  readonly locator: ObsidianNoteLocator
  readonly snapshot: SourceSnapshot
}

export type ReferenceItem = DshMessageReferenceItem | ObsidianNoteReferenceItem

export interface ReferenceSet {
  readonly schemaVersion: typeof REFERENCE_SET_SCHEMA_VERSION
  readonly setId: string
  readonly profileId: string
  readonly sessionId: string
  readonly state: ReferenceSetState
  readonly revision: number
  readonly items: readonly ReferenceItem[]
  readonly createdAt: number
  readonly committedAt?: number
  readonly userMessageId?: string
  readonly userAnchorId?: string
}

export interface CreateReferenceSetInput {
  readonly setId: string
  readonly profileId: string
  readonly sessionId: string
  readonly createdAt: number
}

export interface AddReferenceInput {
  readonly referenceId: string
  readonly source: ReferenceSource
  readonly userComment?: string
}

export interface CompleteReferenceCommitInput {
  readonly expectedRevision: number
  readonly committedAt: number
  readonly userMessageId: string
  readonly userAnchorId: string
}

export interface ReuseReferenceInput {
  readonly setId: string
  readonly referenceId: string
  readonly targetSessionId: string
  readonly createdAt: number
}
