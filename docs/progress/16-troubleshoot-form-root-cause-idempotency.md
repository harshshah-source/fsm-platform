# Progress — Issue 16: Troubleshoot form + structured root cause + idempotency

> Build date: 2026-06-23 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend: **+14 tests / +4 files** for this issue;
> `tsc --noEmit` clean (PostgreSQL 16 + PostGIS on :5433). Migration **22** (`add_troubleshooting_submissions`).

## Scope & decisions

The online troubleshooting-form submit (schema D11). The SE submits structured root cause + action +
component-unavailable + photos + free-text, with the SE GPS captured silently as the Phase-1
verification anchor. Storage-level idempotency on `(se_id, client_submission_id)`; a fresh submit moves
the Ticket **OPEN → VERIFICATION_PENDING** and the Failure Cycle **OPEN → SUBMITTED**.

Decisions:

1. **Submit → VERIFICATION_PENDING (ticket), SUBMITTED (cycle).** Per the issue + CONTEXT Troubleshoot
   Ticket lifecycle: the ticket externally observed post-submit state is `VERIFICATION_PENDING` (what
   Issue 18's VerificationWorker scans); the `SUBMITTED` state lives on the Failure Cycle.
2. **Form submission resolves the SE's active soft states** on the ticket (`resolved_by=SE`,
   `reason=FORM_SUBMITTED`) — the documented resolution event (CONTEXT §Soft State), wired through to
   the Issue 15 `soft_states` table in the same transaction.
3. **`root_cause_category` is the analytics source; free-text is supplementary.** `diagnosis_notes` is a
   separate nullable column never read by analytics; the required enum (controller 400 when absent) is
   the only Root-Cause-Analytics input (the `(root_cause_category, submitted_at)` index feeds it).
4. **Idempotency is storage-level here.** The `(se_id, client_submission_id)` unique + a pre-check
   returns the existing row (`duplicate=true`) on a retry — no second record. The cross-type
   `offline_submission_receipts` ledger + the offline queue land with Issue 17; component-wait reuse
   with Issue 22.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | Form captures all structured root-cause / action-taken / component / photo fields | 🟢 | `troubleshooting_submissions` columns + `submit` persists them; `photo_refs text[]`, `component_unavailable(+item)`, action-taken/root-cause subcategory+notes. `troubleshooting-submissions-schema` (3) + `troubleshoot-submission` (3). |
| 2 | `root_cause_category` required; free-text notes supplementary | 🟢 | NOT NULL enum + controller 400 (`ROOT_CAUSE_CATEGORY_REQUIRED`); `diagnosis_notes` is a separate supplementary column. `troubleshoot-controller` 400 test. |
| 3 | SE GPS auto-captured silently at submission | 🟢 | `se_gps_lat/lon` stored from `seGps`; `presence_source = FORM_GPS` when GPS present, else NONE. Submission + controller tests assert the stored GPS. |
| 4 | `client_submission_id` (draft-time UUID) unique per `(se_id, submission_type, id)` | 🟢 | `troubleshooting_submissions_se_id_client_submission_id_key` unique (the form-type CHECK fixes submission_type to the two form types, so the pair is the effective scope). Schema test. |
| 5 | Duplicate submission returns existing record; no second record or inventory transaction | 🟢 | `submit` pre-checks `(seId, clientSubmissionId)` → `DUPLICATE` with the existing row; exactly one row persists. No inventory writes exist here (deferred to Issue 21). Submission + controller duplicate tests. |
| 6 | Successful submit transitions Ticket to VERIFICATION_PENDING | 🟢 | Ticket `OPEN → VERIFICATION_PENDING` + cycle `OPEN → SUBMITTED` + `ticket_events` row, in one tx. Submission + controller tests. |

## Slice-by-slice RED→GREEN report

- **Slice 1 — schema.** `TroubleshootingSubmission` model + `SubmissionType` / `PresenceSource` /
  `RootCauseCategory` enums + back-relations; migration `20260623150000_add_troubleshooting_submissions`
  (table, `(se_id, client_submission_id)` unique, 2 CHECKs, 3 indexes incl. `submitted_at DESC`,
  geometry column). `troubleshooting-submissions-schema.e2e-spec.ts` (3).
- **Slice 2 — submit service (happy path).** `TroubleshootSubmissionService.submit` — create + ticket
  transition + cycle transition + soft-state resolution + lifecycle event + audit, one tx; silent GPS.
- **Slice 3 — idempotency.** Pre-check on `(seId, clientSubmissionId)` → `DUPLICATE`, no second row;
  `NOT_OPEN` when the ticket already left OPEN. `troubleshoot-submission.e2e-spec.ts` (3, slices 2–3).
- **Slice 4 — HTTP surface.** `TroubleshootController` (`POST /api/tickets/:id/troubleshoot`, SE-only,
  root-cause-required 400, duplicate 200, NOT_OPEN 409, NOT_FOUND 404); registered in AppModule.
  `troubleshoot-controller.e2e-spec.ts` (4).

## Deviations / deferred (read before extending)

1. **Component multi-select deferred to Issue 21.** Only the scalar `component_unavailable` +
   `component_unavailable_item` (a plain bigint — `component_master` FK deferred) are captured. The
   `submission_components` join, expected-component auto-populate, and inventory decrement land with Van
   Stock (Issue 21); 409-Conflict / Shadow Use with Issue 24.
2. **`component_unavailable=true` does not yet pause the SLA / open a Component Request.** The
   `WAITING_COMPONENT` pause + auto `component_requests` row is Issue 22; this slice records the flag
   only (CHECK enforces the named item).
3. **Offline queue + `offline_submission_receipts` cross-type idempotency** is Issue 17. Issue 16 covers
   the online path with storage-level idempotency.
4. **No mobile UI** — the SE mobile app is still an auth shell. The form is delivered as the backend
   service + HTTP surface the mobile form will POST to; the on-screen form lands with the mobile ticket
   screens.
5. **`presence_source` multi-signal** here resolves to FORM_GPS / NONE from the submitted GPS only;
   richer GEOFENCE_AUTO / MANUAL_ONSITE derivation from the live soft state is a follow-up (the column +
   enum are in place).

## Environment note

Migration created by hand (shadow-DB `CREATE DATABASE` denied to the `fsm` role) then `migrate deploy`
+ `generate`. Auto-recovery comment updated: a submitted ticket is `VERIFICATION_PENDING`, so the
auto-recovery `status: 'OPEN'` scan already excludes worked tickets (no extra guard needed).

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/troubleshooting-submissions-schema.e2e-spec.ts test/troubleshoot-submission.e2e-spec.ts \
  test/troubleshoot-controller.e2e-spec.ts
node node_modules/typescript/bin/tsc --noEmit
```
