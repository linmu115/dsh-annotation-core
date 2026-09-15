# Restore graph references and reconcile revocations

Starting an existing session card previously failed when Maintenance retained a sent reference but the instance had no local annotation set. The target-scoped `restoreGraphReference` remote now resolves the immutable authority record and persists a lightweight read grant separately from submission admissions, journals and sent snapshots. It preserves the recorded source version and cutoff, does not rebind the original message, and does not send a new message or create a pending bubble.

The normal reference and upstream tools include these restored sources. Reads retain their existing per-turn budgets, source authorization, delivery checks and graph disclosure receipts. The list tool explains how to read a restored source. Explicit authority revocations remove pending bubbles and restored grants; an offline/unknown authority response never means deletion. Browser reference changes, focus and visible periodic checks refresh pending bubbles. A committing draft remains under the normal admission reconciler.

Deleting a restored source requires an authority acknowledgement first. Deleted identities remain tombstoned and cannot be restored by a stale start action. Existing plain annotation, Obsidian backlink and submission protocols remain separate.

Validation: synthetic recovery/restart, fixed source, no fabricated admissions or rebinding, pending/offline/archived states, stale restoration and deletion acknowledgement tests; client graph actions, upstream lifecycle, remote descriptors, store and package tests. No real model answer was requested.
