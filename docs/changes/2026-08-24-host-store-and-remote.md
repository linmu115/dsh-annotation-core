# Host store, Typert Remote, and public services

Date: 2026-08-24

## Scope

This change implements Task 3 of the unified annotation-core plan. It makes the Host the only authority for pending and sent annotation sets and exposes that authority through an explicit Agent-scoped Typert boundary. It does not yet implement Agent inbox delivery, pre-step context injection, the persistence flush barrier, or the visual composer; those remain assigned to Tasks 5 and 6.

## Durable layout

The storage domain is named `dsh_annotation_core_v1`. The design document's dashed spelling could not be used because the official DSH rc.2 domain grammar accepts only lowercase letters, digits, and underscores.

Each `${profileId}:${sessionId}` key holds one schema-validated aggregate. A mutation replaces that complete aggregate with one `KvTable.update`, so the following records never pretend to be a cross-table transaction:

- one pending reference set and all frozen sent sets;
- reference-add operation fences;
- the `clientSubmissionId` admission index;
- the Host-user-message-ID submission journal;
- flush reconciliation facts;
- durable backlink jobs and receipts.

The aggregate and reference set carry separate revisions. Client-facing `readPendingState` exposes only the aggregate revision and pending count; it does not expose source text. Mutations reject stale aggregate revisions. Reference submission additionally locks one exact set revision before it can enter the committing state.

## Race and idempotency behavior

- A cancellation fence written before a delayed add causes that add to fail permanently.
- Reusing the same operation ID with the same canonical source returns its existing identity.
- Reusing a reference ID or submission ID with different canonical input fails explicitly.
- Removing the final pending item removes the pending set itself.
- A committing set rejects additions, edits, and removal until it is failed/restored or completed.
- Completing a set moves it to sent history, where it can be looked up by set or reference identity.
- Long-poll waiters resolve only after a newer Host revision, reject on caller cancellation, and reject when the owning plugin is disposed.

## Remote boundary

The package now publishes:

- `dsh-annotation-core/typert` — the Host contribution consumed by the official Typert Loader;
- `dsh-annotation-core/remote` — the Client descriptor contribution and Remote-result helpers;
- the `annotationCoreHost` Host service;
- the `annotationCore` Client service contract.

All fourteen Remote methods use an `agentId` lookup plus the official `agent` scope. An unknown or non-live Agent is rejected before a business method runs. The Client descriptor is not ambient: the core Client entry explicitly calls `$mount`, and its disposer removes the namespace again.

The two submit methods intentionally stop at a durable `prepared` admission in this task. Task 5 will own image admission, stable Host user-message creation, Agent delivery, ID-bound pre-step context, session-event reconciliation, and the disk flush barrier. Keeping that boundary explicit avoids presenting a prepared admission as a successful model submission.

## Verification

- `pnpm typecheck`
- `pnpm vitest run tests/store.test.ts tests/remote.test.ts`
- `pnpm build`
- Official Typert Loader loaded the built self export and resolved `annotationCore/readPending` with scope `agent`.

The focused suite covers temporary JSON-domain reopen, profile/session isolation, aggregate CAS, committing locks, sent lookup, operation fences, admission and journal idempotency, flush/backlink persistence, canceled long polls, Agent authorization, a real Client `$mount`/RPC/`RemoteResult` round trip, and Domain closure on Cordis fiber disposal.
