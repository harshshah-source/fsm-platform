# 17 — Offline queue + batched sync

Status: ready-for-agent
Type: AFK

## What to build

The mobile offline-first submission queue (WatermelonDB / SQLite) and the batched sync endpoint (`POST /api/sync/batch`). Troubleshooting Form submissions, Expense Voucher drafts, and soft-state updates queue locally and auto-sync on connectivity restore. Storage constraints for low-end Android: store only pending metadata + compact JSON payloads (no full ticket history, no large telemetry blobs, no zone-wide lists); cache only assigned/current Tickets; queue table indexed by `status`, `queued_at`, `ticket_id`, `submission_type`; sync in small batches. Photos compressed and stored as local file references (not blobs); local copies removed after successful upload. Lifecycle: PENDING → DELIVERED (compacted) / FAILED (kept until SE resolves). Completed Tickets cleared after configurable retention (default 7–15 days). Max 500 pending (configurable); warn near limit; never auto-delete pending unsynced items without explicit SE acknowledgement. Idempotency uses the existing `client_submission_id` contract; a true 409 (ticket closed by another SE) is distinct from an idempotency duplicate.

## Acceptance criteria

- [ ] PENDING items auto-sync on reconnect via `POST /api/sync/batch` in small batches
- [ ] Idempotency duplicate marks DELIVERED without creating a second record; true 409 marks FAILED
- [ ] Photos stored as compressed file references, not SQLite blobs; local copy removed after upload
- [ ] DELIVERED items compacted; FAILED items persist until SE resolves
- [ ] Completed Tickets cleared after retention window without touching pending submissions
- [ ] Queue cap (default 500) enforced with near-limit warning; no silent auto-delete of pending items

## Blocked by

- #16
