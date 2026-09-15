/** Display metadata only. The Maintenance directory still owns eligibility and IDs. */
export function sessionTargetTitle(
  target: { id: string; title: string },
  summary?: { title?: string; displayTitle?: string },
): string {
  const readable = (value: string | undefined): string | undefined => {
    const title = value?.trim()
    if (!title || title === target.id || /^(?:DSH session\s+|dsh-maintenance_|logical-dsh-|session-[0-9a-f]{8}-)/i.test(title)) return undefined
    return title
  }
  return readable(summary?.title) ?? readable(target.title) ?? readable(summary?.displayTitle) ?? '未命名会话'
}
