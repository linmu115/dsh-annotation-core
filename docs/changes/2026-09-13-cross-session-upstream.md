# Cross-session upstream references for the RC2 copy

Version: 0.3.12-rc2.1. Requires Maintenance plugin 0.2.26-rc2.1 and Engine 0.1.33-rc2.1 with the `annotation-upstream` extension enabled. Sidechat 0.4.7-rc2.1 supplies the selection entry point.

A completed assistant reply can now be cited into another real session. The shared picker lists workspaces and paginated sessions, opens the full target page, waits for its native composer, and adds a fixed-upstream bubble without changing editor text or attachments. A stable operation identity prevents duplicate references and delayed navigation cannot redirect the reference to a different target.

The initial submission contains a bounded selected excerpt and an immutable source identity. `dsh_upstream_read` and `dsh_upstream_search` retrieve the fixed source prefix only when the model asks. Request-derived capacity, page limits and a shared execution budget cover concurrent reads, retries, listing and metadata previews; unknown capacity disables expansion. No full upstream copies, recursive reference expansion or automatic summaries are added.

The existing durable submission journal binds the relationship after target message persistence. Pending discard and committed deletion use retryable outboxes. The shared Engine owns the relationship; a new internal receipt type avoids changing the Obsidian bridge wire contract. Revoked, unsent, missing-source and foreign-target reads fail explicitly. References remain available in later target turns until revoked or unavailable.

Validation: complete Core tests, including target mount/pagination and the new submission/deletion/tool/budget cases; TypeScript and production builds. Actual copy UI, native drafts/attachments and real model tool choice remain user acceptance steps. P2 session stickers and P3 ThoughtDAG integration are not part of this change.
