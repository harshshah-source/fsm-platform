# 16 — Troubleshoot form + structured root cause + idempotency

Status: done
Type: AFK
Progress: docs/progress/16-troubleshoot-form-root-cause-idempotency.md — all 6 ACs green (backend +14 tests/+4 files, migration 22). Component multi-select/SLA-pause deferred to Issues 21/22; mobile UI to mobile ticket screens. 2026-06-23.

## What to build

The Troubleshooting Form submission (online path) with structured root-cause capture and server-side idempotency. Fields: `root_cause_category` (required; POWER_ISSUE / SIM_NETWORK_ISSUE / GPS_ANTENNA_ISSUE / DEVICE_HARDWARE_FAULT / WIRING_ISSUE / CONFIGURATION_ISSUE / VEHICLE_ACCESS_ISSUE / INSTALLATION_ISSUE / CUSTOMER_SIDE_ISSUE / UNKNOWN), `root_cause_subcategory`, `root_cause_notes`, `action_taken_category` + notes, `component_used` (multi, auto-populated with expected components), `component_unavailable` toggle, `photo_refs`, free-text diagnosis notes (supplementary only), and SE GPS auto-captured silently at submission. `client_submission_id` generated at draft creation; uniqueness key `(se_id, submission_type, client_submission_id)`; repeat submits return the already-created record (`duplicate = true`) and never create a second record or inventory transaction. On submit the Ticket enters VERIFICATION_PENDING.

End-to-end: an SE submits the form online, the ticket moves to VERIFICATION_PENDING, and a duplicate submit with the same id is a no-op.

## Acceptance criteria

- [x] Form captures all structured root-cause / action-taken / component / photo fields
- [x] `root_cause_category` required; free-text notes are supplementary, not the analytics source
- [x] SE GPS auto-captured silently at submission
- [x] `client_submission_id` (draft-time UUID) enforced unique per `(se_id, submission_type, id)`
- [x] Duplicate submission returns existing record; no second record or inventory transaction
- [x] Successful submit transitions Ticket to VERIFICATION_PENDING

## Blocked by

- #15
