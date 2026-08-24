import type { ReferenceItem } from './model.ts'

/** Pending numbering is always a dense one-based projection of item order. */
export function renumberPendingItems(items: readonly ReferenceItem[]): readonly ReferenceItem[] {
  return items.map((item, index) => item.number === index + 1 ? item : { ...item, number: index + 1 })
}

export function hasDenseReferenceNumbers(items: readonly ReferenceItem[]): boolean {
  return items.every((item, index) => item.number === index + 1)
}
