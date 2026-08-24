# Stable reference identity and backlink binding

## Scope

This follow-up closes two integration gaps found while connecting the Obsidian capture pipeline to the shared annotation core.

Baseline commit: `d87b7bd` (`fix: stabilize rc2 client startup and composer snapshots`).

## Problem

- A source adapter could provide a stable `referenceId`, but the client API always generated a new ID. Retrying the same persisted Obsidian capture could therefore create a different reference identity.
- A sent reference set stored the user message and anchor IDs but not the hash of the actual submitted user text. Backlink writers could not verify that a deep link still points at the same message contents.

## Changes

- `AnnotationCoreClient.addReference()` now accepts an optional source-owned `referenceId`; the Core still generates one when it is omitted.
- The submission journal and admission record persist `userTextHash`, computed from the exact user text passed to the annotated submit transaction.
- Commit finalization copies the validated SHA-256 digest onto the sent `ReferenceSet`.
- Backlink bindings require and expose `userTextHash`, so source adapters can reject stale or mismatched message targets.
- Source-preparation failures are normalized by their bounded public error code, so an independently bundled consumer adapter does not need to ship or import the Core Host implementation just to preserve `source-changed` and related outcomes.
- Package metadata declares annotation protocol version 2 so Maintenance can reject incompatible plugin sets before touching a DSH profile.
- Store schemas remain able to read earlier pending data, while new annotated submissions require the hash before they can finalize.
- Bundle-contract expectations now include the existing `react-dom` runtime external.

## Verification

- `pnpm typecheck`
- `pnpm test`: 21 files, 79 tests passed
- `pnpm build`
- `pnpm pack`

## Rollback

Revert the commit that adds this report. Existing versioned store documents remain readable because `userTextHash` is optional in persisted historical records; only new annotated enqueue/finalize operations require it.
