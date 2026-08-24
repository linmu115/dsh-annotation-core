# Source preparation, document deduplication, and context budget

Date: 2026-08-24

## Scope

This change implements Task 4 of the unified annotation-core plan. It prepares captured DSH and Obsidian sources before submission and enforces the agreed 20% model-context ceiling. It never sends a message and exports no truncation helper.

## Source preparation

- DSH message references keep their captured selected text and do not require an external adapter.
- Obsidian references delegate online refresh to the registered Host adapter.
- An unchanged online source is preserved.
- A changed note may replace only its full-document snapshot; stable reference identity, selected text, locator, numbering, user comment, and backlink state cannot be rewritten by the adapter.
- A missing source location blocks with `source-missing`.
- A changed or ambiguous selection blocks with `source-changed`.
- An offline bridge uses the captured full-note snapshot and marks it `offline`.
- An unexpected online refresh failure returns `needs-confirmation`. A retry may explicitly select that reference's saved snapshot.
- A missing adapter or incompatible adapter result blocks. It is never treated as ordinary prompt text.

Host adapters can throw the package's exported `SourcePreparationError` with one of the stable preparation codes. Unknown errors are contained as an online refresh failure that requires user confirmation.

## Full-document identity

Full Markdown is deduplicated by `(vaultId, notePath, documentHash)`:

- two selected blocks from the same captured note revision contribute one full document;
- two captured revisions of the same note retain two documents;
- the selected text and user comment remain per-reference material even when their document is shared.

No source snapshot is shortened or silently replaced.

## Context budget

The limit is `floor(contextWindow * 0.20)`.

- When a reliable model context window and tokenizer are supplied, they are used.
- Without reliable metadata, the window is 65,536 tokens.
- Without a tokenizer, token use is conservatively estimated as `ceil(UTF-8 bytes / 3)`.
- Selected text, user comments, and every deduplicated full document are counted together.
- Equality with the limit is allowed; one token above it blocks.
- A blocked result carries a per-reference contribution, total estimate, limit, overage, source type, and note path where relevant.

## Verification

- `pnpm typecheck`
- `pnpm vitest run tests/budget.test.ts tests/prepare-reference-set.test.ts`

The focused tests cover online unchanged/refresh, missing and changed locations, offline snapshots, explicit saved-snapshot retry, adapter protocol mismatch, same-revision deduplication, distinct revision preservation, known tokenizer/window metadata, the fallback estimator, the exact 20% boundary, combined material, per-source details, and absence of a truncation export.
