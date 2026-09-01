# Changelog

## 0.3.5 - 2026-08-31

- Add stable `logicalSessionId` and `logicalAnchorId` fields to annotation links while retaining native session and anchor fallbacks.
- Resolve current Launcher projections through Session Maintenance before opening or deleting a reference.
- Preserve the existing immediate local delete behavior and idempotent background Core cleanup.
- Base this release on the verified Alpha.2 `0.3.4` tree; no DSH peer range is hard locked.

Focused verification: `tests/answer-link.test.tsx`, typecheck and build.
