import type { ReferenceSet } from '../domain/model.ts'

export interface AnnotationAnswerTarget {
  readonly setId: string
  readonly number: number
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
