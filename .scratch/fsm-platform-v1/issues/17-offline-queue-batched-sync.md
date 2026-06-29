# 17 — Offline queue + batched sync (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The mobile offline-first submission queue (WatermelonDB / SQLite). Troubleshooting Form submissions,
Expense Voucher drafts, and soft-state updates queue locally and auto-sync on connectivity restore.
Storage constraints for low-end Android: store only pending metadata + compact JSON payloads (no full
ticket history, no large telemetry blobs, no zone-wide lists); cache only assigned/current Tickets;
queue table indexed by `status`, `queued_at`, `ticket_id`, `submission_type`; sync in small batches.
Photos compressed and stored as local file references (not blobs); local copies removed after
successful upload. Lifecycle: PENDING → DELIVERED (compacted) / FAILED (kept until SE resolves).
Completed Tickets cleared after configurable retention (default 7–15 days). Max 500 pending
(configurable); warn near limit; never auto-delete pending unsynced items without explicit SE
acknowledgement. Idempotency uses the existing `client_submission_id` contract; a true 409 (ticket
closed by another SE) is distinct from an idempotency duplicate.

> **Backend split (dependency correction).** The batched-sync **endpoint** is backend and **not built**.
> This issue is now the **mobile queue only**. The transport is owned by a new backend issue:
> **"Backend: `POST /api/sync/batch`"** (to be filed — see INDEX "Backend follow-ups"). Decision recorded:
> use the dedicated batch endpoint; do **not** also replay to per-type endpoints (one transport only).

## Business rules (authority)

- PRD §307 (offline-first architecture), §721 (`client_submission_id` dedup contract), §591 Flow 8
  (true 409 distinct from duplicate).

## Acceptance criteria

- [ ] PENDING items auto-sync on reconnect via `POST /api/sync/batch` in small batches
- [ ] Idempotency duplicate marks DELIVERED without creating a second record; true 409 marks FAILED
- [ ] Photos stored as compressed file references, not SQLite blobs; local copy removed after upload
- [ ] DELIVERED items compacted; FAILED items persist until SE resolves
- [ ] Completed Tickets cleared after retention window without touching pending submissions
- [ ] Queue cap (default 500) enforced with near-limit warning; no silent auto-delete of pending items

## API contract (authority: new backend issue — to be filed)

- `POST /api/sync/batch` — request `{ items: [{ submissionType, clientSubmissionId, payload }] }`;
  response per-item `{ clientSubmissionId, result: 'DELIVERED'|'DUPLICATE'|'CONFLICT', code? }`.
  (Exact shape is owned + frozen by the new backend issue; this issue consumes it.)
- Until that endpoint exists, this issue is **blocked** — do not invent the transport.

## Validation & error codes

- A `DUPLICATE` (idempotency) result → mark the local item DELIVERED (no 2nd server record).
- A `CONFLICT` (true 409, e.g. `TICKET_ALREADY_CLOSED`) → mark FAILED + surface (Issue 63 for troubleshoot).

## Permissions

- SE-only; every queued write carries the SE's own auth + `client_submission_id`.

## Offline / synchronization behaviour

- Detect connectivity (Issue 54 seam); flush PENDING in small batches FIFO by `queued_at`.
- Retention sweep clears completed tickets after the configurable window without touching PENDING/FAILED.

## Edge cases & failures

- Near 500-pending cap → warn; never auto-delete PENDING without explicit SE acknowledgement.
- Partial batch failure → only failed items stay PENDING/FAILED; delivered items compact.

## Tests (TDD targets — red first)

- PENDING flushes on reconnect in batches; DELIVERED compacts.
- `DUPLICATE` → DELIVERED (no 2nd record); `CONFLICT` → FAILED.
- Photo stored as file ref; local copy removed post-upload.
- Cap warning at threshold; no silent deletion of PENDING.

## Blocked by

- #16
- #54 (Mobile Foundation — offline seam)
- Backend: `POST /api/sync/batch` — to be filed
