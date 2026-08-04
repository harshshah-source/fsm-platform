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

- [x] Structured root-cause form renders and submits to `/api/tickets/:id/troubleshoot`
- [x] `component_unavailable` flag captured; location-on-submit wired — **photo capture NOT built, blocked on #81** (Media Upload API, unbuilt — see the issue's own "Photo handling" section above)
- [x] Idempotent submit with `client_submission_id`
- [x] Resubmit path supports a new `client_submission_id` on the same ticket — free: every submit tap generates a fresh id

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
  media-upload endpoint (**#81 — Media Upload API**); block the photo AC on it.

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

- `docs/ui/mobile/troubleshooting.png`

## Tests (TDD targets — red first)

- Submit without `clientSubmissionId`/root cause → respective 400 codes rendered inline.
- Valid submit → ticket VERIFICATION_PENDING; duplicate `client_submission_id` returns same submission (no 2nd record).
- 409 `TICKET_ALREADY_CLOSED` routes to Issue 63 screen (not treated as a duplicate).
- Resubmit uses a fresh `client_submission_id` on the same ticket.

## Blocked by

- #54, #16
- ~~(photo AC) #81 — Media Upload API~~ — **#81 is done (see 2026-08-04 contract-audit comment); the photo AC is unblocked and buildable now**

## Comments

### 2026-07-28 — #172 decisions 6-8

- **Photo slots (decision 6):** the form has **4 named slots** — `Before`, `After`, `Part`, `Plate`
  — overriding the PRD's unstructured "photo refs". `photoRefs: string[]` cannot express them;
  **#81** now owes slot semantics.
- **Notes fields (decision 7):** the image shows two text areas against the PRD's three fields.
  Map `ISSUE REMARKS` → `rootCauseNotes` and `COMPLETION NOTE` → `actionTakenNotes`. All three stay
  server-side; `diagnosisNotes` is simply unused by mobile. Nothing is lost.
- **Pickers (decision 8):** the image shows fixed 10+10 tiles. `rootCauseCategory` is a proper
  server enum, but **`actionTakenCategory` is an unvalidated free string**
  (`troubleshoot.controller.ts:38`) — it becomes an enum, and both vocabularies get served or
  shared rather than hardcoded (**#169** item 7, validated by **#174**).
- The form header's context strip (vehicle reg, `GPS502 · 39h inactive`, transporter, plant, zone,
  state) all comes from **#161**.

### 2026-08-04 — built except photos (#81) and the component-item catalog picker

`TroubleshootSubmitRequest`/`TroubleshootSubmissionView`/`TroubleshootSubmitResponse`/
`TroubleshootConflictBody`/`RootCauseCategory` moved to `@fsm/shared` first (same precedent as
#56/#57; service-layer Prisma-facing types in `troubleshoot-submission.service.ts` stayed local).
New `TilePicker` kit primitive (single-select, text-only — no icon vocabulary exists anywhere for
these domain concepts). **Issue Found** tiles are the real `ROOT_CAUSE_CATEGORIES` enum per decision
8's own text ("rootCauseCategory is a proper server enum") — not the reference image's mismatched
labels (its "Battery"/"No Reach" tiles don't map cleanly onto the 10 real categories). **Action
Taken** tiles are the reference image's own literal labels verbatim — `actionTakenCategory` has no
real enum yet (#169/#174's still-open work per decision 8), so the image is the only vocabulary
that exists for this field, not a guess. Notes map per decision 7. Location captured silently via
#57's `captureLocation()`, mapped `{lat,lng}` → `{lat,lon}` (the two endpoints spell the field
differently). `clientSubmissionId` generated fresh on every submit tap — the resubmit AC falls out
of this for free, no separate resubmit mode needed. Wired from #57: once ON_SITE, "Start
Troubleshooting" posts `TROUBLESHOOT_STARTED` (closing #57's own deferred item) and opens this form
in place; submit success closes the form and refetches the ticket, which now reads
`VERIFICATION_PENDING`. 131 mobile tests green, `tsc`/`eslint` clean.

**Not built:** photo capture (#81, Media Upload API, unbuilt — confirmed zero `apps/backend/src`
hits for any media endpoint). The specific `componentUnavailableItem` catalog picker (the
"Component / Replacement" tile section in the reference image) — no component catalog/read exists
to populate one from (same gap #161 already recorded: "no `expected_components` table exists —
Issue 21/22"); only the boolean `componentUnavailable` flag is wired, which is what this issue's
own ACs actually name. 409 shows an inline message, not the full #63 screen — #63 has its own
unresolved gaps (`winnerSeId` has no name-resolution endpoint, `shadowUseRecorded` is permanently
`false` server-side), recorded on #63 already, not re-litigated here.

### 2026-08-04 (later, contract audit) — CORRECTION: the photo AC's blocker is gone; #81 is done

The remaining open work on this issue is the **photo AC only**, and its stated blocker is stale:

1. **#81 (Media Upload API) is `Status: done`.** `POST /api/media/upload` exists and is already
   consumed by two other mobile forms — `VoucherFormScreen.tsx` (capture → `apiUploadMedia(token,
   'VOUCHER', 'RECEIPT', …)` → `photoRef`) and `InstallFormScreen.tsx` (`'INSTALL'`,
   `'INSTALL_PHOTO'`) — so the capture-and-upload pattern this form needs is established, not
   novel. The comment above ("unbuilt — confirmed zero hits") was true when written and is not
   edited; this comment supersedes it.
2. **The backend already accepts the result.** `troubleshoot.controller.ts:66` passes
   `body.photoRefs` through today; `TroubleshootSubmitRequest.photoRefs?: string[]` is in
   `@fsm/shared` (index.ts:405). Note the shared doc comments at index.ts:389-390 and :404 still
   say "photo capture is blocked on #81 (unbuilt)" — stale, fix alongside.
3. **Slot semantics are ready.** #172 Decision 6's four named slots (`BEFORE`/`AFTER`/`PART`/
   `PLATE`) are already in `MediaSlot` + `MEDIA_SLOTS_BY_KIND.TROUBLESHOOT` (index.ts:563-568) —
   what decision 6's own text said "#81 now owes" has been delivered. Slot identity rides on the
   upload (`kind` + `slot` per media object); the submit body's flat `photoRefs: string[]` stays
   as-is.
4. **Also stale in the comment above:** "409 shows an inline message, not the full #63 screen" —
   the full-screen `ConflictScreen` has since been wired (`TroubleshootFormScreen.tsx:44` renders
   it, replacing the form).

**Remaining scope for this issue, precisely:** wire `PhotoCaptureRow` (4 named slots) +
`expo-image-picker` capture + `apiUploadMedia(token, 'TROUBLESHOOT', <slot>, …)` into
`TroubleshootFormScreen`, thread the returned refs into `photoRefs` on submit — following the
Voucher/Install pattern verbatim. The `componentUnavailableItem` catalog picker remains separately
blocked (no component catalog read exists) and is NOT revived by this correction.
