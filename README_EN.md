# dsh-annotation-core

Shared annotation bubbles, cross-session references, reliable submission and historical annotation details for DSH plugins. Current source version: **0.3.12-rc2.11**, targeting official **DSH 0.1.5-rc.2 / the web profile**. This does not imply an npm release; build and install matching local packages to use this branch.

English · [中文](README.md)

Core has no independent sidebar or canvas. Sidechat supplies selection actions, Sticker supplies sticker interactions, and ThoughtDAG supplies the session graph. All share one Core instance through host interfaces, without EAC or a desktop shell. The complete Maintenance/Codex installation must also satisfy its own RC2 host-artifact requirements.

## Features and usage

### Annotation bubbles

- Bubbles appear above the composer without inserting `@` tokens, quote blocks or hidden placeholders into the visible draft.
- Open a bubble to inspect the selection, edit an optional comment or delete it. Remaining pending references are renumbered.
- Sent user messages have an “N annotations” pill; annotation links in model answers reopen the corresponding details.
- Main, side and embedded composers share the reference state and presentation protocol.
- Removing a pending Obsidian reference removes its bubble first, then retries source cleanup in the background. Delayed backlinks cannot resurrect deleted relations.

### Cross-session references

1. With the matching Sidechat plugin, select text in a **completed assistant reply** and choose cross-session reference. Ordinary annotations still accept user and assistant messages; fixed upstream references require completed assistant replies.
2. Choose a workspace, then a target conversation. Lists support scrolling and pagination.
3. Core opens the real target page, waits for its composer and adds a bubble. Existing text and attachments stay intact; nothing is sent automatically.
4. Write your question and send. The source range ends at the **complete end of the selected reply**. The selection identifies the focus; subsequent source turns are excluded.

Initial submission prioritizes the bounded **question and answer containing the selection**. Long turns expose incompleteness and a continuation position; intermediate tool steps have a separate read entry. The model can call `dsh_upstream_read` and `dsh_upstream_search` to retrieve earlier context without asking again for permission to read an authorized source.

Core does not automatically copy entire upstream histories, recursively expand every reference or create per-turn context backups. Source versions, reply cutoffs, page limits and a shared turn budget constrain reads. Initial material is deducted from the later tool budget. See [initial question/answer context](docs/changes/2026-09-14-initial-upstream-turn.md) and [request capacity and budgets](docs/changes/2026-09-14-system-audit-fixes.md).

### Native Agent graph and context management

With the matching Maintenance `annotation-context` Adapter configured and ready, native DSH agents receive conversation-scoped tools:

- `dsh_graph_inspect` and `dsh_context_status`: bounded, revision-bound pages for sources, materials, operations, nodes, edges and historical read coverage.
- `dsh_request_list`: the real user-request index for the current conversation or an authorized reference; long requests use stable request IDs and continuation cursors.
- `dsh_context_window_set`, `dsh_context_release`, `dsh_context_source_set` and `dsh_context_pin`: select disjoint authorized ranges, release used bodies, pause/resume sources and manage model pins without removing user pins.
- `dsh_graph_edit`: bounded edits to the executing conversation's main graph through the normal relationship service.
- `dsh_context_discover`: allowed session candidates or the current conversation's existing note links; metadata discovery never grants body access.

Read tools remain constrained by the fixed source version, completed-reply cutoff, active window and cumulative allowance. `dsh_upstream_read` also accepts the stable `userRequestId` from the index. Model-created links carry a separate activation record rather than a fabricated user-submission receipt.

Release first reports `pending-next-step`. Before the next native model request, Core appends an immutable DSH `surfaceOp: replace` event. Maintenance acknowledges `applied` only after verifying the durable native evidence. Mixed envelopes and tool results retain unselected fragments, tool pairing, the real user message and `userComment`; original events remain intact. Unknown external compaction fails explicitly rather than resurrecting pruned content.

Status pages never return the entire graph. Index and metadata reads share the cumulative read allowance; metadata pages are conservatively charged at their reserved byte limit in the durable Engine budget. Releasing does not refund it. Bounded management receipts remain available when the read budget or material catalog is full, and unregistered material is reported explicitly. Historical coverage is separate from current retention.

This phase supports **native DSH agents only**. New tools are not exported to the managed Codex runtime. Missing, disabled or incompatible Adapter capabilities fail closed. See the [implementation and verification report](docs/changes/2026-09-15-native-context-tools.md).

If the capability becomes unavailable during a run, ordinary chats without plugin material continue with these tools unmounted. Requests with retained plugin material or incoming annotations pause until capability recovery, preserving pending releases and window restrictions. Source-wide release and window changes first register newly admitted material. If registration is incomplete, known `materialIds` can still be released to free capacity; an empty operation is never presented as releasing the whole source.

### Durable submission and conflict recovery

Before sending, Core rechecks the authoritative pending revision and target/composer identity. If references change during preparation, bubbles refresh while text, images and files remain available for a manual retry.

References become sent only after executor acceptance and durable persistence. Lost-response retries inspect the original receipt: identical messages do not send twice or consume file receipts again. Editing text or attachments creates a new submission identity, so an old receipt cannot falsely confirm a new draft. Ordered RC2 images/files, legacy embedded `images` calls and older request digests remain supported. See [submission revision conflicts](docs/changes/2026-09-14-reference-submit-revision.md).

Capacity calculations include history, system instructions, tools, the message, attachments and reserved output. Insufficient capacity preserves the draft. When native Codex usage cannot be verified, preparation uses an explicitly identified conservative mode rather than claiming a measured remaining capacity.

### Graph continuation, archival and revocation

Opening a ThoughtDAG node can adopt its existing incoming references with their original source versions and reply cutoffs, without recapturing newer history or sending a message. If a lawful sent relationship remains in Maintenance but its local annotation record is missing, Core restores a separate lightweight read grant. It **does not fabricate submission receipts, user messages or sent snapshots**, or bind an old relationship to a new user turn.

When Maintenance archives/deletes either endpoint, or a relationship is explicitly revoked, that reference stops supplying further context. Core reconciles pending bubbles and restored grants against authoritative status; offline or unknown responses do not imply deletion. Submitted messages are not rewritten, and revocation cannot make a model forget material already delivered. Deleting a restored source requires authority acknowledgement; stale graph actions cannot reactivate revoked identities.

See [session graph continuation and disclosure records](docs/changes/2026-09-15-session-main-graph-context.md) and [restoring lawful sent references](docs/changes/2026-09-15-graph-reference-recovery.md). Disclosure records distinguish preparation, delivery and failure, not model understanding.

## Component responsibilities

| Component | Responsibility |
|---|---|
| Annotation Core | Bubbles, comments, submission transactions, historical details, target-scoped read tools and reference adoption |
| Sidechat | Selection popup, cross-session entry and actual forked side conversations |
| Maintenance / DSH version Adapter | Canonical sessions, stable identities, fixed source reads, authoritative relationships, archival/revocation and disclosure records |
| Session Sticker / ThoughtDAG | Sticker/session-node interactions, layout and relationships, without a duplicate native transcript store |
| Obsidian Bridge / Reference Adapter | Note selection, embedded-window delivery, note sources and backlinks; the Vault owns note content |

The companion Bridge/Adapter controls delivery windows. The current paired system allows only the configured Obsidian embedded conversation surface to claim note references.

When host tools are available, `dsh_reference_list` / `dsh_reference_read` expose submitted references, the current execution batch and lawful restored graph sources in the current conversation. Snapshot reads retain original content; refresh uses source adapters without rewriting submitted input. Inherited fork references do not create backlinks. Optional Runtime Support bridges tools into corresponding Codex executions without exposing arbitrary note paths or model-driven deletion.

## Build and installation

Use Core, Maintenance and consumers matched to **DSH 0.1.5-rc.2**. Other host versions require separate validation. Ordinary annotations do not require the complete graph stack; fixed upstream references and graph continuation require corresponding Maintenance capabilities.

From the source root, use **pnpm 11.19.0**, as declared in [package.json](package.json), and follow the official RC2 host's Node requirement:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Build emits Host/Client bundles and declarations; both test and pack run a build first. Install the generated archive into the intended instance's web profile, for example:

```bash
dsh plugin --profile web add "file:/absolute/path/dsh-annotation-core-0.3.12-rc2.11.tgz"
```

Install matching Sidechat, Sticker or ThoughtDAG, restart the target `dsh web` and refresh the page. Launcher/Maintenance-managed instances should use their own deployment workflow to keep package versions, runtime bindings and loaded locations consistent. Building or pushing source does not update a running instance. An unversioned registry install does not guarantee this candidate code.

## Consumer API

Negotiate features before calling the [Client API](src/public/client-api.ts) or [Host API](src/public/host-api.ts).

The optional host capability `annotationCoreHost.referenceDirectory` (`protocolVersion: 1`) exposes read-only session and reference pages, with at most 50 entries per page, 4000 characters per excerpt and 2000 per comment. Subscribers receive only the session ID and revision after durable commits; full aggregates, note snapshots and submission journals are excluded. With `annotation-records` enabled, the matching Maintenance plugin backfills and continuously mirrors this directory, retrying failed acknowledgements. Only explicit tombstones represent deletion; missing entries do not revoke anything. Native upstream relationships are deduplicated in the directory, and restored graph grants are not exported again. See the [directory and synchronization report](docs/changes/2026-09-15-reference-directory-mirror.md).

| Capability | Entry points |
|---|---|
| `cross-session-upstream-v1` | `openCrossSessionReference` opens the shared picker |
| `graph-reference-actions-v1` | `addCrossSessionReference` targets a conversation; `resolveReferenceLink` returns one metadata locator; `deleteReferenceLink` removes a relationship |
| `session-main-graph-v2` | `prepareGraphReferences` adopts lawful existing references with original versions and cutoffs |

Keep the same `operationId` when retrying an add. Graph captures can supply `expectedSourceVersionId`, checked atomically by Maintenance, so a changed source cannot silently replace the previewed version. See [graph actions](docs/changes/2026-09-14-thoughtdag-reference-actions.md) and [source version protection](docs/changes/2026-09-14-graph-material-version-guard.md).

## Troubleshooting

- **No UI:** install a matching consumer. Sidechat and Sticker can share the same Core instance.
- **Cross-session directory unavailable:** check Maintenance capabilities, paired versions and session archival/deletion status. Incompatibility and a disabled extension are different conditions.
- **Conflict or insufficient capacity:** the draft is retained. Wait for state refresh and retry, or reduce the current materials; repeated clicks do not bypass validation.

See [CHANGELOG](CHANGELOG.md) for history. Each change report states its validation scope; unit tests alone do not establish real model-answer or full deployment acceptance.

## License

MIT
