/** Display metadata only. The Maintenance directory still owns eligibility and IDs. */
export function sessionTargetTitle(
  target: { id: string; title: string },
  summary?: { title?: string; displayTitle?: string },
): string {
  const readable = (value: string | undefined): string | undefined => {
    const title = value?.trim()
    if (!title || title === target.id || generatedSessionTitle.test(title)) return undefined
    return title
  }
  return readable(summary?.title) ?? readable(target.title) ?? readable(summary?.displayTitle) ?? '未命名会话'
}

// Match complete generated identifiers, not user titles discussing sessions.
const generatedSessionTitle = /^(?:DSH session\s+)?(?:dsh-maintenance_[A-Za-z0-9_-]+|logical-dsh-[0-9a-f]{32}|(?:session|knowledge)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
