# 244 — Special ticket: derived identification, configurable threshold, admin surfacing

Status: done (2026-08-19)
Type: AFK · Backend + Admin

Filed 2026-08-19. Approved Decisions 3/7/8: Special = a ticket that repeatedly entered an SE's
active workload, actually reached the SE mobile workflow, and never reached a successful
troubleshooting outcome. **Identification first** — Special is NOT a ticket status, NOT a priority
mechanism, and never touches REPEAT/ESCALATED machinery.

## What to build

### The approved, code-grounded definition

- **Attempt window** = one `batch_assignment_tickets` row. Creators that open a countable window:
  05:00 dispatch, intraday accept, `assignTicket` (Critical Queue / ZM same-day / Device-Detail
  `assignPlants`), and the new row created by `REASSIGN`/`SPLIT_BATCH`. `SWAP_SE` continues the
  same window (verified: it re-points the batch, never the rows). `REORDER` is not an attempt.
- **Reached** = a `soft_states` row for the ticket with `set_at` inside the window
  (`row.created_at .. row.removed_at`, open-ended while live). Earliest signal is the mobile
  auto-posted `VIEWED` (`TicketDetailScreen.tsx:96-118`). This proves the SE opened the ticket in
  the mobile workflow — the design must never claim it proves handset delivery. A server-side
  assignment alone never counts.
- **Success** = a `troubleshooting_submissions` row for the ticket — the system's single success
  writer (`TroubleshootSubmissionService.submit()`, idempotent on `(se_id, client_submission_id)`;
  the component-unavailable variant also writes one — the SE diagnosed the fault). No second
  definition is invented.
- **Countable unsuccessful reached attempt** = reached ∧ no submission ∧ the window ended with
  `removal_reason IN ('PLAN_EXPIRED', 'VEHICLE_UNAVAILABLE')`. Windows ended by
  `ZM_WITHDRAWN / ZM_DEFERRED / REASSIGNED / BULK_UNASSIGNED / AUTO_RECOVERY / TICKET_CANCELLED /
  COMPONENT_WAIT / DEV_CLEANUP / HUMAN_REMOVED` never count (approved exclusions). Live windows are
  in-progress, not judged.
- **SPECIAL** := countable unsuccessful reached attempts ≥ threshold ∧ no submission ever ∧
  `ticket.status = 'OPEN'`.
- **Representation: DERIVED — no stored counter, no new ticket state.** Determined on evidence
  (`docs/audits/four-decisions-final-analysis-2026-08-18.md` §3.2): identification-first needs no
  sortable column; threshold changes reclassify retroactively; a late/re-sent submission
  self-corrects a false Special (there is no offline queue — a lost submit simply arrives on
  re-send); no writer means no drift or double-count. If Special ever needs to affect sorting, that
  is a recorded architectural consequence requiring a follow-up (materialisation), not a silent
  change here.

### Threshold configuration

`system_settings` key `special_ticket_attempt_threshold`, default **3**, following the #238
`assignment-threshold.ts` pattern exactly: named key constant + description; validated integer
ladder **2–10** (0 and 1 are technically expressible and operationally destructive — 1 ≈ the whole
backlog Special at once; the parser refuses them with the allowed list); pure parser with typed
rejections; `coerceStored` falling back to the default; free `read…(prisma)` function read per
evaluation, never cached. Write authority: the registry default (`DEFAULT_SETTING_WRITE_ROLES` =
OPERATIONS_HEAD) — no invented co-ownership; the existing lock/history machinery applies as-is.

### Backend surface

A query service (`ticketing/special-ticket.query.ts` or folded into `ticket-query.service.ts`)
exposing, as **batched aggregates** (never per-ticket loops — the run touches ~12k open tickets):
`isSpecial`, `countableAttempts`, and the per-window attempt history (window open/close, reason,
reached?, submission?) for detail views. Endpoints: a `special=true` filter + count on the existing
tickets list API, and attempt history on the existing ticket-detail read. No new writer anywhere.

### Admin surface

- Tickets queue: a `SPECIAL` badge (the `ticketBadges.tsx` / #238 `HELD` precedent) + a Special
  filter chip + count.
- Ticket / Device Detail: an "Attempts" section listing each window (dates, SE, reached, outcome,
  removal reason) with the Special verdict and the live threshold.
- Visually and semantically distinct from the existing REPEAT / ESCALATED indicators — the three
  concepts never share a field, a query, or a chip.

### Existing code to reuse

`settings/assignment-threshold.*` (pattern), `batch_assignment_tickets` + #241 reasons + indexes,
`soft_states`, `troubleshooting_submissions`, `ticket-query.service.ts`, `ticketBadges.tsx`,
`RepeatEscalationService` (untouched — contamination guard only).

### Tests

- Unit: the derivation over fixture ledgers — every removal-reason class; SWAP_SE continuity;
  REASSIGN old/new windows; reached-vs-not; component-blocked submission = success; live window not
  judged.
- e2e: threshold change reclassifies retroactively; a submission arriving after a `PLAN_EXPIRED`
  judgment un-Specials the ticket with no writer involved; REPEAT/ESCALATED fixtures unaffected;
  ladder governance per the #238 test shape.
- Admin: badge/filter/attempt-history render + role visibility.
- Query-plan pin: the aggregate uses the #241 indexes (no seq-scan of the ledger per request).

### Risks

Read cost — bounded by the indexes and batched aggregates; the tickets-list filter computes Special
for the page, not the table. Double-classification impossible (derived).

## Acceptance criteria

- [x] AC1 — With recycling live, the D0–D4 simulation (3 dispatches, VIEWED each day, no
      submission) yields Special at the configured threshold; day 2 of the same history does not.
      *Asserted from both sides of the boundary in one ticket's history.*
- [x] AC2 — Excluded removal reasons provably never count; a never-opened window (no soft state)
      never counts. *Each exclusion tested at three windows — i.e. at threshold volume — so one that
      silently stopped working flips the verdict rather than merely shifting a count. Plus the other
      boundary: a soft state **outside** a window does not make that window reached.*
- [x] AC3 — `special_ticket_attempt_threshold` governed per the #238 pattern; values outside 2–10
      refused with the allowed list; changes reclassify existing tickets immediately (both directions).
      *This exposed a real gap: the generic `PUT /api/settings/:key` validated nothing, so an
      out-of-ladder value would be stored and then silently coerced to the default at read time —
      settings page and engine disagreeing. Closed with `SETTING_VALIDATORS`, a pure per-key validator
      on the generic writer.*
- [x] AC4 — Special is not a `TicketStatus`/`AssignmentState`/`workType` value and writes nothing to
      `failure_cycles`; REPEAT/ESCALATED behaviour is bit-identical before/after (pinned). *"Writes
      nothing" is asserted with whole-table counts, not fixture-scoped queries.*
- [x] AC5 — Admin queue badge + filter + count, and the per-ticket attempt history, render for
      manager roles; SEs see nothing new on mobile (the endpoints 403 an SE).
- [x] AC6 — Return-date priority (#248) and Special do not interact: a Special verdict changes no
      ordering. *Pinned against the ordering itself rather than against #248, so it holds before and
      after that slice: moving the threshold changes the verdicts and leaves the row sequence
      byte-identical.*

## UI surfaces

Admin: Tickets queue (badge + filter + count, modified) · Ticket detail drawer → Assignment History
(attempt history section, modified) · Device Detail (SPECIAL chip beside the open-ticket link,
modified). Mobile: n/a.

**Recorded narrowing on Device Detail.** That page represents a device's ticket as a **single link**,
not as a section, so it gained the *identification* (the chip) while the attempt history stays one
click away in the drawer the link opens. Duplicating a full history section onto a one-line panel
would be the redesign the surfacing rule forbids. The chip is computed by the same shared predicate,
inside the device read's existing open-ticket LATERAL, so the two surfaces cannot disagree.

## Reference

`docs/ui/desktop/v2-reference/07-tickets.png` (the SIGNALS column, where REPEAT / ESCALATED already
live — the badge is additive there, the #238 `HELD` precedent) and
`docs/ui/desktop/v2-reference/28-tickets-drawer.png` / `08-ticket-detail.png` (the Assignment History
tab the attempt list extends). Verified by listing the directory rather than trusting this line —
three issues in this block filed a wrong Reference section. No layout redesign.

## Blocked by

#241 (reasons + indexes) ✅, #242 (recycling makes the condition reachable) ✅.
