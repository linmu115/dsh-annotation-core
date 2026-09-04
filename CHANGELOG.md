# Changelog

## 0.3.7 - 2026-09-04

- Target the DSH 0.1.2-rc.1 session contract without retaining an older
  Harness compatibility branch.
- Replace removed `Session.events` reads with immutable
  `Session.snapshotEvents()` snapshots during submission settlement and
  startup reconciliation.
- Preserve the RC1-branded `SessionSeq` from the observed user event through
  `sourceEventSeqs`, instead of narrowing it to an unbranded number.
- Pin the RC1 development packages and Zod 4.4.3 so the suite is compiled
  against one host type identity.

The Annotation Core Host API, immediate-local/background-remote deletion
settlement, annotation projection visibility, and prompt admission semantics
are unchanged.

## 0.3.6 - 2026-09-01

- Treat `@deepseek-ai/schemastery` as a DSH host capability instead of a
  plugin-owned runtime dependency.
- Declare an open optional peer so experimental Harness combinations remain
  selectable without making pnpm install a second core package tree.
- Keep Alpha2 `3.18.2` as a development-only compiler and test dependency.

Focused verification: package manifest contract, typecheck, build and package
dry run.

## 0.3.5 - 2026-08-31

- Add stable `logicalSessionId` and `logicalAnchorId` fields to annotation links while retaining native session and anchor fallbacks.
- Resolve current Launcher projections through Session Maintenance before opening or deleting a reference.
- Preserve the existing immediate local delete behavior and idempotent background Core cleanup.
- Base this release on the verified Alpha.2 `0.3.4` tree; no DSH peer range is hard locked.

Focused verification: `tests/answer-link.test.tsx`, typecheck and build.
