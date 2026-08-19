# 246 — Return-date deferral wiring: filing ends the attempt, the ticket waits, re-entry is automatic

Status: ready-for-agent
Type: AFK · Backend + Mobile

Filed 2026-08-19. Approved Decisions 4/9/10/14 + gate answer Q1(a) (provisional deferral — recorded
in #245). Connects the captured return date to the deferral engine for the first time: today
`expectedFrom` is stored and read by nothing in scheduling (verified).

## What to build

### Current behaviour (verified)

`fileReport` = report row + primary-SLA pause + `lastStateChangedAt`. The ticket stays
`FORMALLY_ASSIGNED` on its live batch; `deferredUntil` untouched; the date the SE types has no
consequence. Mobile presets cap the date at ~tomorrow 2 PM (`vehicleUnavailabilityDisplay.ts:19-24`)
while the API accepts any date.

### Required change

**1. Filing ends the attempt window** (the `deferTicket` three-write shape, system-flavoured):
in `fileReport`'s existing transaction — live batch row → `removed_at = now`, `removed_by = seId`,
`removal_reason = 'VEHICLE_UNAVAILABLE'`; ticket → `assignmentState = 'UNASSIGNED'`. This is what
makes a VU visit one unsuccessful reached attempt (Decision 16; counted by #244 since the SE was
on-ticket — VIEWED/ON_SITE exist).

**2. The ticket waits — IST calendar-day semantics (Decision 14):**
`deferredUntil = istDay(authoritativeDate)` **only when that IST day is after today**; a same-day /
sub-day return writes **no deferral** (the ticket is simply eligible again — no hour-level
machinery). The authoritative date is #245's `expected_from` (provisional = SE's proposal until a
manager decides). When a manager approves/overrides (#245) or a new report supersedes, the deferral
is **re-derived** from the new authoritative date in the same transaction (including clearing it if
the new date is today/past).

**3. No bounds (Decision 10):** any future date is accepted — no horizon validation, no cap on
consecutive VU deferrals. Management approval is the control. (Each cycle still increments Special
attempts, so a never-returning vehicle surfaces rather than disappears.)

**4. Re-entry:** the existing inclusive `notDeferredOn` (`deferredUntil <= day`) — no new job. The
recommender, shared pool, intraday, cross-zone, and me-tickets all already spread the one predicate.
While touching `se-ticket-access.ts`, fold its hand-rolled deferral copy (`:34`) back onto
`notDeferredOn` (the #153 drift shape).

**5. Holds stay separate (Decision 13):** nothing in this slice writes `deferredUntil` for admin
holds; #251's hold endpoint must refuse/warn on tickets whose deferral derives from an OPEN VU
report, so a hold never silently overwrites a return decision.

**6. Mobile:**
- Replace the four-preset "Expected Back" ladder with a real date (+optional time) picker — the SE
  must be able to express any future date ("next week" is currently inexpressible).
- Post-submit confirmation: "This ticket will return to scheduling on {authoritative date}" — the
  read the service docstring says is missing; also show it on the ticket detail while deferred.

### Existing code to reuse

`OverrideService.deferTicket` (write-shape reference), `ticketing/deferral.ts`,
`batch-assignment.service.ts:182` (dispatch clears the spent deferral — unchanged, verified
correct), #245's authoritative-date model, `VehicleUnavailabilityFormScreen.tsx`,
`captureLocation.ts`.

### Tests

- e2e matrix: return-in-2h/today → no deferral, eligible next run; return-tomorrow → excluded
  today, selected tomorrow (inclusive predicate pinned); return-25-Aug → waits; far-future date
  accepted (no-bounds pinned); manager override to an earlier/later date re-derives the deferral;
  supersession re-derives; VU filing yields `VEHICLE_UNAVAILABLE` row + `UNASSIGNED` + attempt
  countable by #244; repeat absence → new report + second attempt.
- Mobile: date-picker entry, confirmation copy, deferred-state display.
- Regression: ZM `DEFER_TICKET` and dispatch-clear behaviour unchanged.

### Risks / rollback

The `fileReport` transaction grows by two writes — same shape as `deferTicket`, low risk. Timestamp
→ IST-day conversion is the one subtlety (use `istDate`; boundary tests). Rollback: revert —
reports remain, deferrals are just dates.

## Acceptance criteria

- [ ] AC1 — Filing a VU report removes the ticket from the live batch (`VEHICLE_UNAVAILABLE`),
      returns it to `UNASSIGNED`, and (future-IST-day dates only) defers it to the authoritative
      date.
- [ ] AC2 — Same-day/sub-day returns create no deferral; the four Decision-14 examples are pinned
      as tests.
- [ ] AC3 — No maximum-date or deferral-count validation exists on any write path (pinned: a
      +90-day date is accepted end-to-end).
- [ ] AC4 — Approve/override/supersession re-derives the deferral atomically; the ticket's wait
      always reflects the current authoritative date.
- [ ] AC5 — The ticket re-enters the selectable set on exactly the authoritative IST day via the
      existing predicate — no new sweep; the `se-ticket-access` inline copy is folded into
      `notDeferredOn`.
- [ ] AC6 — Mobile: any future date is enterable; the SE sees the return date after filing and on
      the deferred ticket.
- [ ] AC7 — A VU-ended window counts as one unsuccessful reached attempt in #244's derivation
      (integration-tested across the two slices).

## UI surfaces

Mobile: Vehicle Unavailability form (date picker, modified) · Ticket detail (deferred/return
banner, modified). Admin: n/a (covered by #245).

## Reference

`docs/ui/mobile/` vehicle-unavailability screen image (extend the existing form layout — picker
replaces the preset row; no redesign).

## Blocked by

#241 (removal reason), #245 (authoritative date + decisions). Feeds #247, #248, #249.
