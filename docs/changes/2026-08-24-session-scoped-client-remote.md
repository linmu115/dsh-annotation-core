# Session-scoped Client Remote fix

## Problem

The public Client API accepts an explicit `sessionId`, but the initial 0.1.0 candidate resolved `remote.annotationCore` from the root Client context. That root lookup could address the staged page session instead of a forked sidechat child, so a sidechat reference or submission could be applied to the wrong Agent.

## Fix

- Added `annotationRemoteForSession(ctx, sessionId)`.
- Every session-bearing Client API operation now resolves `ctx.sessions.scope(sessionId)` first and obtains the Remote namespace from that Agent-scoped context.
- Composer binding, conversation-node detail loading, answer links, reference mutation, fencing and plain/annotated submission therefore share the same explicit session axis.
- `retryBacklink()` derives the owning session from the already loaded sent-set cache and fails closed when the set has no known owner.

## Verification

- Added `tests/session-remote.test.ts`, proving a requested child session uses the child namespace and never the root namespace.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm exec vitest run`: 20 files, 76 tests passed.

## Rollback

Revert this commit. Do not use the preceding candidate with embedded/forked consumers because its Client Remote scope is ambiguous.
