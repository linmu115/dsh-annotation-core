# 0.3.3 — Maintenance logical session links

- Annotation protocol v2 locators, claims, backlink commits and delete envelopes can carry `logicalSessionId` and `logicalAnchorId` while retaining native session and anchor IDs for older DSH builds.
- Added a one-shot logical target resolver for annotation navigation. Failed or unavailable Maintenance resolution falls back to the persisted native target instead of repeatedly forcing session selection.
- Stable link metadata is serialized canonically; reference text remains outside navigation diagnostics.
- The existing local-first committed-reference deletion and retry lifecycle is unchanged.

Focused verification: `tests/answer-link.test.tsx`, typecheck and build.
