import type { ReferenceSet } from '../domain/model.ts'

export interface AnnotationAnswerTarget {
  readonly setId: string
  readonly number: number
}

export interface AnnotationSessionTarget {
  readonly logicalSessionId?: string
  readonly logicalAnchorId?: string
  readonly sessionId: string
  readonly anchorId: string
}

export type AnnotationSessionTargetResolver = (target: {
  readonly logicalSessionId: string
  readonly logicalAnchorId?: string
  readonly legacySessionId: string
  readonly legacyAnchorId: string
}) => Promise<{ readonly sessionId: string; readonly anchorId?: string } | undefined>

/** Resolve once at navigation time; historical native IDs remain a non-blocking fallback. */
export async function resolveAnnotationSessionTarget(
  target: AnnotationSessionTarget,
  resolver?: AnnotationSessionTargetResolver,
): Promise<{ readonly sessionId: string; readonly anchorId: string }> {
  if (target.logicalSessionId !== undefined && resolver !== undefined) {
    const resolved = await resolver({
      logicalSessionId: target.logicalSessionId,
      ...(target.logicalAnchorId === undefined ? {} : { logicalAnchorId: target.logicalAnchorId }),
      legacySessionId: target.sessionId,
      legacyAnchorId: target.anchorId,
    })
    if (resolved !== undefined) {
      return { sessionId: resolved.sessionId, anchorId: resolved.anchorId ?? target.anchorId }
    }
  }
  return { sessionId: target.sessionId, anchorId: target.anchorId }
}

const PREFIX = '#dsh-annotation-'

/** Parse only the versioned, same-document fragment emitted by the core prompt. */
export function parseAnnotationAnswerLink(href: string): AnnotationAnswerTarget | undefined {
  if (!href.startsWith('#')) return undefined
  const fragment = href
  if (!fragment.startsWith(PREFIX)) return undefined
  const body = decodeURIComponent(fragment.slice(PREFIX.length))
  const separator = body.lastIndexOf('-')
  if (separator <= 0) return undefined
  const setId = body.slice(0, separator)
  const numberText = body.slice(separator + 1)
  if (!/^[1-9]\d*$/.test(numberText)) return undefined
  return { setId, number: Number(numberText) }
}

export function resolveAnnotationAnswerLink(
  href: string,
  sets: readonly ReferenceSet[],
): { readonly set: ReferenceSet; readonly referenceId: string; readonly number: number } | undefined {
  const target = parseAnnotationAnswerLink(href)
  if (target === undefined) return undefined
  const set = sets.find((candidate) => candidate.setId === target.setId && candidate.state === 'sent')
  const item = set?.items.find((candidate) => candidate.number === target.number)
  if (set === undefined || item === undefined) return undefined
  return { set, referenceId: item.referenceId, number: item.number }
}
