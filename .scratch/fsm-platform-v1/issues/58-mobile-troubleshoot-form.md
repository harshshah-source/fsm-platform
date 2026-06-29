# 58 — M4: Troubleshoot form (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The full mobile Troubleshooting form (Issue 16 `/api/tickets/:id/troubleshoot`): structured root-cause
selection, component-unavailable flag, photo capture, and location-captured-on-submit (Decision §9).
Idempotent submit via `client_submission_id`. Also hosts the resubmit form for the component loop
(Issue 22 mobile half).

## Business rules (authority)

- PRD §513 Flow 2 step 4 (field list), §533 Flow 3 (Component Unavailable → resubmit with a NEW
  `client_submission_id`). `client_submission_id` dedup contract: PRD §721.

## Acceptance criteria

- [ ] Structured root-cause form renders and submits to `/api/tickets/:id/troubleshoot`
- [ ] `component_unavailable` flag captured; photo capture + location-on-submit wired
- [ ] Idempotent submit with `client_submission_id`
- [ ] Resubmit path supports a new `client_submission_id` on the same ticket (Issue 22 mobile AC)

## API contract (authority: backend on `main`)

- `POST /api/tickets/:id/troubleshoot` — body `{ clientSubmissionId (required), rootCauseCategory
  (required, enum), rootCauseSubcategory?, rootCauseNotes?, actionTaken*?, components?,
  componentUnavailable?, photoRefs?: string[], gps? }` (`ticketing/troubleshoot.controller.ts`,
  `TroubleshootBody`). `rootCauseCategory` ∈ the service's `ROOT_CAUSE_CATEGORIES` enum.
- On success the ticket enters VERIFICATION_PENDING (PRD §529).

## Validation & error codes

- `CLIENT_SUBMISSION_ID_REQUIRED`, `ROOT_CAUSE_CATEGORY_REQUIRED` (400) — surface inline.
- True conflict (ticket closed by another SE) → 409 `TICKET_ALREADY_CLOSED` → routes to the full-screen
  409 (Issue 63). An idempotency duplicate is NOT a 409 (returns the existing submission).

## Photo handling ⚠

- `photoRefs` is an array of STRING references, not blobs/multipart. The capture→ref step needs the
  media-upload endpoint (**to be filed — see INDEX "Backend follow-ups"**); block the photo AC on it.

## Permissions

- SERVICE_ENGINEER only; server-scoped to the caller.

## Offline behaviour (PRD §530)

- Submit offline → queued via Issue 17 with the `client_submission_id`; auto-uploads on reconnect.
  Photos are stored as compressed local file refs until upload (Issue 17).

## Edge cases & failures

- Missing root cause → `ROOT_CAUSE_CATEGORY_REQUIRED` inline.
- Component-unavailable submit → server creates the Component Request, cycle → WAITING_COMPONENT, SLA
  paused; the resubmit form later reopens with a NEW `client_submission_id` (PRD §533–539).

## UI surfaces

- **Mobile:** Troubleshoot form + resubmit. Owned by this issue (also closes Issue 22 mobile resubmit AC).
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/troubleshooting.png.png`

## Tests (TDD targets — red first)

- Submit without `clientSubmissionId`/root cause → respective 400 codes rendered inline.
- Valid submit → ticket VERIFICATION_PENDING; duplicate `client_submission_id` returns same submission (no 2nd record).
- 409 `TICKET_ALREADY_CLOSED` routes to Issue 63 screen (not treated as a duplicate).
- Resubmit uses a fresh `client_submission_id` on the same ticket.

## Blocked by

- #54, #16
- (photo AC) media-upload backend issue — to be filed
