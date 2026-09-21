import { useEffect, useMemo, useRef, useState } from 'react'

import type { ReferenceItem, ReferenceSet } from '../domain/model.ts'
import { LAYOUT_ATTRIBUTES, affectsMessageText, markReferenceTextDirty } from './reference-text-index.ts'
import { referenceRange, type ReferenceHighlightStore } from './reference-highlights.tsx'

/**
 * Inline reference badges: one small round button pinned to the end of every
 * referenced passage, next to the message text and never inside it.
 *
 * This is Core's own implementation of the same affordance the sticker board
 * draws for its stickers. The two plugins stay independent: Core only reads the
 * sticker dots' rectangles as a rendering hint (see `avoidStickerDots`) and never
 * asks the sticker board for anything, so there is deliberately no cross-plugin
 * contract — and no cross-plugin coupling to break.
 */

/** The sticker board's dot element. Read-only observation, not an interface. */
const STICKER_DOT_SELECTOR = '.dsh-sticker-board-dot'
/** Same viewport margin the sticker board and the highlight pass use. */
const VIEWPORT_MARGIN = 160
/** Past this many candidates in one session we stop measuring off-screen ones. */
const DENSE_CANDIDATE_LIMIT = 200
/** Sticker's own spread step; we reuse the same 24px ladder for visual parity. */
const AVOID_STEP_Y = 24
/** Same-position band as `spreadDotPoint` (|Δx| < 18, |Δy| < 20), plus slack. */
const AVOID_DELTA_X = 20
const AVOID_DELTA_Y = 22

export interface BadgePoint { readonly x: number; readonly y: number }

/** Only the geometry the collision band needs, so jsdom can fake a dot rect. */
export interface DotRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface ReferenceBadgeCandidate {
  readonly key: string
  readonly anchorId: string
  readonly occurrence: number
  readonly set: ReferenceSet
  readonly item: ReferenceItem
}

/**
 * Merge the pending set with the already-prefetched sent sets.
 *
 * Deduplication uses the same identity as the CSS highlight pass
 * (`anchorId + selectedText + occurrence`), so a passage shows exactly one badge
 * no matter how many sent sets quote it. The whole `set` travels with the badge
 * because the click hands it to the dialog, which renders the set's other items
 * as tabs.
 */
export function collectReferenceBadges(store: ReferenceHighlightStore, sessionId: string | undefined): ReferenceBadgeCandidate[] {
  if (sessionId === undefined || sessionId === '') return []
  const candidates: ReferenceBadgeCandidate[] = []
  const seen = new Set<string>()
  for (const set of store.sets.values()) for (const item of set.items) {
    if (item.sourceType !== 'dsh-message' || item.locator.sessionId !== sessionId) continue
    const key = JSON.stringify([item.locator.anchorId, item.selectedText, item.locator.occurrence])
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ key, anchorId: item.locator.anchorId, occurrence: item.locator.occurrence, set, item })
  }
  return candidates
}

/** Non-zero client rects of a range; jsdom returns none. */
function rangeRects(range: Range): DOMRect[] {
  const rects = typeof range.getClientRects === 'function' ? [...range.getClientRects()] : []
  // jsdom exposes neither layout API, so a missing method must not throw.
  const box = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
  if (rects.length === 0 && box !== null && (box.width > 0 || box.height > 0)) rects.push(box)
  return rects.filter(rect => rect.width > 0 && rect.height > 0)
}

function containsPoint(rect: DotRect, point: BadgePoint): boolean {
  return Math.abs(rect.left - point.x) < AVOID_DELTA_X && Math.abs(rect.top - point.y) < AVOID_DELTA_Y
}

/**
 * Collision band used by the sticker board's own `spreadDotPoint` (|Δx| < 18,
 * |Δy| < 20), widened slightly.
 */
export function stickerDotRects(root: ParentNode = document): DotRect[] {
  return [...root.querySelectorAll(STICKER_DOT_SELECTOR)]
    .map(dot => dot.getBoundingClientRect())
    .filter(box => box.width > 0 || box.height > 0)
}

/**
 * Heuristic only: no cross-plugin agreement exists, the sticker board does not
 * know we are here, and it may move or skip its dots at any time. We simply step
 * down the same 24px ladder until the point clears the rectangles that are
 * visible right now. A missing or renamed sticker class degrades to "no
 * avoidance", which is exactly the pre-existing overlap.
 */
export function avoidStickerDots(point: BadgePoint, blocked: readonly DotRect[]): BadgePoint {
  let y = point.y
  while (blocked.some(rect => containsPoint(rect, { x: point.x, y }))) y += AVOID_STEP_Y
  return { x: point.x, y }
}

/** The only rectangles a badge can collide with are the sticker dots. */
function avoidCollisions(point: BadgePoint, blocked: readonly DotRect[]): BadgePoint {
  return avoidStickerDots(point, blocked)
}

interface MeasuredBadge extends ReferenceBadgeCandidate { readonly point: BadgePoint | null }

/** Shape handed to React: candidates plus the point each one may be drawn at. */
interface BadgeGeometry { readonly badges: MeasuredBadge[] }

/**
 * Per-frame measurement pass, kept out of React so one frame measures once.
 *
 * The cache is invalidated wholesale by `clear()` whenever the message DOM may
 * have moved, so it can never serve a position measured against stale layout.
 * While it is valid, React renders (dialog opens, host re-renders) reuse the same
 * points instead of walking every message again.
 */
class BadgeGeometryCache {
  private blockedRects: DotRect[] = []
  private measured: MeasuredBadge[] = []
  private valid = false

  clear(): void { this.blockedRects = []; this.measured = []; this.valid = false }

  /** Measure from scratch: one anchor rect per candidate, then one Range each. */
  measure(candidates: readonly ReferenceBadgeCandidate[], resolve: (candidate: ReferenceBadgeCandidate) => HTMLElement | null, viewport: { width: number; height: number }): void {
    this.clear()
    this.blockedRects = stickerDotRects()
    const points = new Map<string, BadgePoint | null>()
    // Phase 1: cheap anchor lookup + one rect per candidate. Everything outside
    // the viewport margin is dropped here, before any Range is built.
    const near: { candidate: ReferenceBadgeCandidate; root: HTMLElement; top: number }[] = []
    for (const candidate of candidates) {
      const root = resolve(candidate)
      if (root === null) { points.set(candidate.key, null); continue }
      const anchor = root.getBoundingClientRect()
      if (anchor.bottom < -VIEWPORT_MARGIN || anchor.top > viewport.height + VIEWPORT_MARGIN) {
        points.set(candidate.key, null)
        continue
      }
      near.push({ candidate, root, top: anchor.top })
    }
    // Phase 2: under heavy reference counts we cap the measured set at the
    // candidates closest to the fold, so the per-frame cost stops tracking the
    // total reference count and tracks the visible area instead.
    const measurable = near.length > DENSE_CANDIDATE_LIMIT
      ? [...near].sort((left, right) => distanceToViewport(left.top, viewport.height) - distanceToViewport(right.top, viewport.height)).slice(0, DENSE_CANDIDATE_LIMIT)
      : near
    const measurableKeys = new Set(measurable.map(entry => entry.candidate.key))
    for (const { candidate, root } of measurable) {
      const range = referenceRange(root, candidate.item.selectedText, candidate.occurrence)
      const rects = range === null ? [] : rangeRects(range)
      const last = rects.at(-1)
      points.set(candidate.key, last === undefined ? null : avoidCollisions({ x: last.right + 7, y: last.top + last.height / 2 }, this.blockedRects))
    }
    this.measured = candidates.map(candidate => ({ ...candidate, point: measurableKeys.has(candidate.key) ? points.get(candidate.key) ?? null : null }))
    this.valid = true
  }

  /**
   * Used while React renders. A changed candidate list (different references, or
   * a different session) measures again; an unchanged one reuses the last pass.
   */
  geometry(candidates: readonly ReferenceBadgeCandidate[], resolve: (candidate: ReferenceBadgeCandidate) => HTMLElement | null, viewport: { width: number; height: number }): BadgeGeometry {
    if (!this.valid || this.measured.length !== candidates.length || candidates.some((candidate, index) => this.measured[index]?.key !== candidate.key)) {
      this.measure(candidates, resolve, viewport)
    } else {
      this.measured = candidates.map((candidate, index) => ({ ...candidate, point: this.measured[index]?.point ?? null }))
    }
    return { badges: this.measured.map(badge => ({ ...badge })) }
  }
}

/** 0 when the anchor straddles the fold; grows with distance above or below it. */
function distanceToViewport(top: number, height: number): number {
  return top < 0 ? -top : top > height ? top - height : 0
}

export interface ReferenceBadgesProps {
  readonly store: ReferenceHighlightStore
  currentSession(): string | undefined
  subscribeSession(listener: () => void): () => void
  /** Durable anchorId → rendered `[data-chat-anchor-key]` value. */
  resolveAnchor(item: ReferenceItem): string
  /** Default placement: the dialog docks to the composer card by itself. */
  openReference(set: ReferenceSet, referenceId?: string): void
}

/** `CSS.escape` is absent in jsdom (and in the SSR pass); anchor keys are plain. */
function escapeAttributeValue(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS
  return typeof css?.escape === 'function' ? css.escape(value) : value
}

export function ReferenceBadges({ store, currentSession, subscribeSession, resolveAnchor, openReference }: ReferenceBadgesProps) {
  const [version, setVersion] = useState(0)
  const cache = useRef<BadgeGeometryCache | null>(null)
  const resolve = (candidate: ReferenceBadgeCandidate): HTMLElement | null => {
    const key = resolveAnchor(candidate.item)
    return key === '' ? null : document.querySelector<HTMLElement>(`[data-chat-anchor-key="${escapeAttributeValue(key)}"]`)
  }
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    let frame = 0, observing = false
    const paint = () => {
      frame = 0
      // Positions measured against the old layout are unusable now.
      cache.current?.clear()
      const hasSources = collectReferenceBadges(store, currentSession()).length > 0
      if (hasSources && !observing) {
        observer.observe(document.body, {
          childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...LAYOUT_ATTRIBUTES],
        })
        observing = true
      }
      if (!hasSources && observing) { observer.disconnect(); observing = false }
      setVersion(value => value + 1)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    // A batch that carries content or moves layout both changes where the badge
    // belongs, so both repaint and mark the shared tables stale. Anything inside
    // our own hosts is filtered out, which keeps the dialog's keystrokes from
    // throwing the tables away.
    const observer = new MutationObserver(records => { if (affectsMessageText(records)) { markReferenceTextDirty(); schedule() } })
    const unsubscribe = store.subscribe(schedule), unsubscribeSession = subscribeSession(schedule)
    schedule()
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      unsubscribe(); unsubscribeSession()
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      cache.current?.clear()
    }
  }, [store, currentSession, subscribeSession, resolveAnchor])
  const sessionId = currentSession()
  const geometry = useMemo(() => {
    const candidates = collectReferenceBadges(store, sessionId)
    const current = cache.current ?? (cache.current = new BadgeGeometryCache())
    return current.geometry(candidates, resolve, { width: window.innerWidth, height: window.innerHeight })
    // `version` is the paint clock: it changes exactly when the geometry pass ran.
  }, [store, sessionId, resolveAnchor, version])
  const badges = geometry.badges.filter((badge): badge is MeasuredBadge & { point: BadgePoint } => badge.point !== null)
  return <div data-dsh-annotation-badges>
    {badges.map(badge => <button
      key={badge.key}
      type="button"
      className="dshAnnotationReferenceBadge"
      data-dsh-annotation-badge={badge.item.referenceId}
      data-dsh-badge-anchor={badge.anchorId}
      style={{ left: badge.point.x, top: badge.point.y }}
      aria-label={`注释 ${badge.item.number}：${badge.item.selectedText.slice(0, 20)}`}
      title={(badge.item.userComment || badge.item.selectedText).slice(0, 60)}
      onPointerDown={event => event.preventDefault()}
      onMouseDown={event => event.preventDefault()}
      onClick={event => { event.preventDefault(); event.stopPropagation(); openReference(badge.set, badge.item.referenceId) }}
    >{badge.item.number > 99 ? '99+' : badge.item.number}</button>)}
  </div>
}
