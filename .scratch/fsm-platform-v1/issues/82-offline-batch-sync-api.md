# 82 — Offline Batch Sync API (`POST /api/sync/batch`)

Status: ready-for-agent
Type: AFK · Backend

## Business purpose

The mobile offline queue (Issue 17) flushes queued writes — troubleshoot submissions, voucher drafts,
soft-state updates — in small batches when connectivity returns. This issue owns the **server transport**
that Issue 17 consumes. It introduces no new write semantics: each item is dispatched to the same
domain logic the per-type endpoints already use, keyed by the existing `client_submission_id` contract.

## PRD references

- §307 (offline-first architecture), §721 (`client_submission_id` dedup contract), §725 (delivery),
  §591 Flow 8 (a true 409 is distinct from an idempotency duplicate).

## Workflow references

- Issue 17 already specifies the queue lifecycle (PENDING → DELIVERED/FAILED) and storage constraints;
  this endpoint is its counterpart.

## API specification

- `POST /api/sync/batch` — body `{ items: [{ submissionType: 'TROUBLESHOOT'|'VOUCHER'|'SOFT_STATE',
  clientSubmissionId, payload }] }`.
- Response: per-item result array `{ clientSubmissionId, result: 'DELIVERED'|'DUPLICATE'|'CONFLICT', code? }`.
  - `DELIVERED` — applied (new record).
  - `DUPLICATE` — idempotency hit on `client_submission_id`; no second record created.
  - `CONFLICT` — business 409 (e.g. `TICKET_ALREADY_CLOSED`) carried in `code`.
- Each item routes through the **existing** service (troubleshoot/voucher/soft-state) — no new business rule.

## Acceptance criteria

- [ ] A batch applies each item via its existing domain service
- [ ] Idempotent `client_submission_id` → `DUPLICATE`, never a second record
- [ ] A business 409 on an item → `CONFLICT` with the original code; other items in the batch still process
- [ ] Partial failure is per-item (one bad item never rolls back delivered items)
- [ ] RBAC: SERVICE_ENGINEER; every item is applied as the authenticated SE

## Validation & error codes

- `EMPTY_BATCH`, `BATCH_TOO_LARGE` (over the configured cap), `UNKNOWN_SUBMISSION_TYPE` (400).
- Per-item `code` mirrors the underlying endpoint's codes (e.g. `ROOT_CAUSE_CATEGORY_REQUIRED`, `TICKET_ALREADY_CLOSED`).

## Permissions

- SERVICE_ENGINEER only; items cannot act on behalf of another SE.

## Dependencies

- #16 (troubleshoot), #38 (vouchers), #15 (soft-state) services. Consumed by #17.

## Test plan (TDD)

- mixed batch → DELIVERED + DUPLICATE + CONFLICT resolved independently.
- duplicate `client_submission_id` creates no second record.
- one CONFLICT item does not roll back delivered items.

## TDD implementation notes

- Reuse the existing services; do not re-implement validation. Start with the per-item result-mapping
  test red. Keep the batch a thin dispatcher.

## Blocked by

- #15, #16, #38
