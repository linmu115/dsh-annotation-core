# 0.3.4 — Host-side reference deletion

- Expose an optional `annotationCoreHost.deleteReferenceLink` capability for integrations that run in the DSH host.
- Persist the same deletion tombstone and retry jobs used by the browser API.
- Kick Obsidian cleanup outboxes immediately after a host-side deletion.

This lets cross-app deletion continue even when no DSH browser page is open.
