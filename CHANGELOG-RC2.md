# 0.3.11-rc2.1

- Compile and declare the DSH 0.1.5-rc.2 package cohort.
- Accept ordered native image/file attachments while preserving legacy images and digests.
- Resolve Agent-scoped file receipts before image admission; commit after delivery acceptance and roll back failures.
- Journal exact user-message identity and admitted durable content for retry/recovery evidence.
- Subscribe immediately to existing executor receipt services, avoiding a missed notification during startup.
- Retain pending drafts, durable backlink gating, source snapshots, deletion tombstones and idempotent submission receipts.

Validation: full Core suite plus ordered file/image admission, foreign receipt refusal, retained drafts and retry after upload receipt retirement. Target-instance composition validation is tracked separately.
