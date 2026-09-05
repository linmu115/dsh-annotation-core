interface SuppressionRecord { count: number; originalHidden: boolean }
const suppressions = new WeakMap<HTMLElement, SuppressionRecord>()
const roots = new WeakMap<Document | HTMLElement, AnchorIndex>()
const selector = '[data-chat-anchor-key]'

function acquire(element: HTMLElement): void {
  const existing = suppressions.get(element)
  if (existing !== undefined) existing.count += 1
  else {
    suppressions.set(element, { count: 1, originalHidden: element.hidden })
    element.hidden = true
  }
}

function release(element: HTMLElement): void {
  const record = suppressions.get(element)
  if (record === undefined || --record.count > 0) return
  element.hidden = record.originalHidden
  suppressions.delete(element)
}

/** One index and observer per conversation root; duplicate consumers share ownership. */
class AnchorIndex {
  private readonly anchors = new Map<string, Set<HTMLElement>>()
  private readonly keys = new Map<HTMLElement, string>()
  private readonly consumers = new Map<string, number>()
  private readonly observer: MutationObserver | undefined
  private records: MutationRecord[] = []
  private scheduled = false
  private closed = false

  constructor(private readonly root: Document | HTMLElement) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) this.update(element)
    this.observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver((records) => {
      this.records.push(...records)
      if (this.scheduled) return
      this.scheduled = true
      queueMicrotask(() => { this.scheduled = false; if (!this.closed) this.flush() })
    })
    this.observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-anchor-key'] })
  }

  subscribe(key: string): () => void {
    // A remount may precede delivery of the preceding DOM changes.
    this.flush()
    const count = this.consumers.get(key) ?? 0
    this.consumers.set(key, count + 1)
    if (count === 0) for (const element of this.anchors.get(key) ?? []) acquire(element)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const remaining = (this.consumers.get(key) ?? 1) - 1
      if (remaining > 0) this.consumers.set(key, remaining)
      else {
        this.consumers.delete(key)
        for (const element of this.anchors.get(key) ?? []) release(element)
      }
      if (this.consumers.size === 0) {
        this.closed = true
        this.observer?.disconnect()
        this.records = []
        this.anchors.clear()
        this.keys.clear()
        roots.delete(this.root)
      }
    }
  }

  private update(element: HTMLElement): void {
    const previous = this.keys.get(element)
    const next = element !== this.root && this.root.contains(element) ? element.getAttribute('data-chat-anchor-key') ?? undefined : undefined
    if (previous === next) return
    if (previous !== undefined) {
      if (this.consumers.has(previous)) release(element)
      const bucket = this.anchors.get(previous)
      bucket?.delete(element)
      if (bucket?.size === 0) this.anchors.delete(previous)
      this.keys.delete(element)
    }
    if (next !== undefined) {
      const bucket = this.anchors.get(next) ?? new Set<HTMLElement>()
      bucket.add(element)
      this.anchors.set(next, bucket)
      this.keys.set(element, next)
      if (this.consumers.has(next)) acquire(element)
    }
  }

  private flush(): void {
    const records = this.records.splice(0)
    records.push(...this.observer?.takeRecords() ?? [])
    const candidates = new Set<HTMLElement>()
    const subtrees = new Set<Element>()
    const removed = new Set<Element>()
    for (const record of records) {
      if (record.type === 'attributes') candidates.add(record.target as HTMLElement)
      else {
        for (const node of record.addedNodes) if (node.nodeType === 1) subtrees.add(node as Element)
        for (const node of record.removedNodes) if (node.nodeType === 1) {
          subtrees.add(node as Element)
          removed.add(node as Element)
        }
      }
    }
    for (const subtree of subtrees) {
      // Nested additions in the same batch are covered by their outer subtree.
      let parent = subtree.parentElement
      while (parent !== null && !subtrees.has(parent)) parent = parent.parentElement
      if (parent !== null) continue
      candidates.add(subtree as HTMLElement)
      // Detached descendants may have lost their key after the removal notification.
      for (const element of subtree.querySelectorAll<HTMLElement>(removed.has(subtree) ? '*' : selector)) candidates.add(element)
    }
    for (const element of candidates) this.update(element)
  }
}

/** Hide only the generic row representing the same durable annotation event. */
export function suppressGenericAnnotationRow(key: string, root: Document | HTMLElement = document): () => void {
  let index = roots.get(root)
  if (index === undefined) { index = new AnchorIndex(root); roots.set(root, index) }
  return index.subscribe(key)
}
