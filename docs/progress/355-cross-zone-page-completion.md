# 355 — Cross-zone page completion: flag from ticket, re-escalate, modal, deferred resurfacing, history

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan (`docs/module-gaps/IMPLEMENTATION-PLAN.md`
§4), absorbing survey ids CZ-04 / CZ-05 / CZ-06 / CZ-07 / CZ-08, **closing #92 and #93** and the
cross-zone legs of #80. Red-first. Depends on #354 (atomic approve, `direction`, the target-ZM notice),
which is present at HEAD. Also fixes **#335** (the drawer crash from #244), which the round handed to
this slice because it owns the file.

## What it closes

Cross-zone escalation is the path for work one zone cannot do and another must. It had all its write
doors and almost none of its reads, so an escalation's life ended at its first decision:

- **You could not raise one from the place you realise you need one.** `apiCrossZoneFlag` shipped with
  Issue 32 and had **zero call sites** (#92). The ticket drawer is where a ZM sees that their zone
  cannot cover the work; the Cross-Zone page is the queue that flag *creates an entry in*.
- **A denied AUTO escalation vanished from the only queue that could act on it** (#93).
  `listForScope` returned actionable statuses only, so a DENIED row left the home ZM's queue — and the
  home ZM is the only role permitted to `re-escalate` it. The route existed with no button, and the row
  the button would sit on was not on screen.
- **Approve was five `window.prompt`s** in which the target zone and the engineer were typed
  independently and **never checked against each other**, so the escalation could record "sent to zone
  3" while the ticket landed on a zone-5 engineer's day plan.
- **A deferral's `reviewDate` was written and never read.** A CSM who parked a Platinum escalation
  "until Thursday" left a row in DEFERRED that no queue showed and no sweep touched. On Thursday
  nothing happened.
- **No decision could be read back at all.** The receiving zone had no way to see what was asked or
  when, and a denial could not be read against the reason given for it.

## The shape of the fix

Five changes, each on the seam that was actually missing:

1. **`listForScope` keeps one decided status for one reader** — DENIED **AUTO** rows for the home ZM.
   Not for the CSM/OH (a denied row is not theirs to act on) and not for denied MANUAL flags (there is
   no door behind those, so surfacing them would only add a queue item that cannot be actioned).
2. **`approve` derives and validates the target zone from the engineer.** `targetZoneId` is optional on
   the wire; when supplied it must equal `engineer_master.zone_id` or the call is
   `ZONE_SE_MISMATCH` → **400 `SE_NOT_IN_TARGET_ZONE`**, carrying the zone the engineer is actually in.
3. **`sweepDueReviews(now)`** returns DEFERRED rows past their review date to PENDING with a notice,
   driven from `business-sweep-scheduler.service.ts`'s existing `crossZoneTick`.
4. **`history(scope, range)` + `GET /cross-zone/history`**, read from `audit_logs`, zone-clamped like
   the queue, bounded by a 30-day default window and a 200-row default cap (500 max).
5. **The admin surfaces** — a "Flag cross-zone" action with a reason Modal on the ticket drawer, and a
   Cross-Zone page with real Modals, a Re-escalate row action for the home ZM, a Review-date column and
   a History tab.

## Decisions worth keeping

**1. History reads the audit log, not the escalation row.** The obvious implementation is to widen
`listForScope` to APPROVED/DENIED and call it history. It would have been wrong twice over. The row
holds only its *latest* decision and overwrites it — and since `sweepDueReviews` a resurfaced deferral
actively clears the decider fields it just used, so a row-sourced history would lose the deferral it
was resurfacing. More importantly the row has never carried `acted_as_role`, and **AC5 asks for the
acting role**: a CSM deciding under a ZM's backup authority (#340) is not the ZM's decision, and the
escalation table cannot tell you which it was. The audit chain can, for every step.

Consequence worth stating: history includes the **raises** (`CROSS_ZONE_MANUAL_FLAG`,
`CROSS_ZONE_AUTO_ESCALATION`) as well as the decisions, because the receiving zone's first question is
what was asked of it, which is the half the issue's own framing names.

**2. The review date is *consumed* when the row resurfaces.** Clearing `reviewDate` is not tidiness —
it is the entire idempotency mechanism. A resurfaced row that kept its date matches the sweep's
predicate on every subsequent tick, so the queue would be re-notified about the same escalation every
fifteen minutes for ever. The update is additionally guarded (`updateMany` on
`status: 'DEFERRED'` **and** the same `reviewDate`), so two instances firing the same cron cannot both
resurface one row and send two notices: the loser updates nothing, sees `count === 0`, and tells nobody.

`decisionReason` deliberately survives the resurfacing while `decidedBy*` / `decidedAt` are cleared.
The row is undecided again so it must not name a decider — but *why it was parked* is the first thing
whoever picks it back up needs, and nothing about who deferred it is lost: that is in the audit chain
history now reads.

**3. Two notices, not one.** The deciders' queue gets its own type — `CROSS_ZONE_REVIEW_DUE`, not a
second `CROSS_ZONE_AUTO_ESCALATION`, because nothing has been newly escalated and a reader who sees the
raise notice twice cannot tell a new Platinum ticket from one they already decided to look at later.
The home ZM gets one too: they were told their escalation had been parked, so they are told it is back.
`NotificationTray` routes any `CROSS_ZONE*` type to `/cross-zone` by prefix, so the new type needed no
front-end change.

**4. The zone/SE agreement check lives in the service, not the DTO.** Plan §4 asks
`cross-zone.dtos.ts` to "derive / validate `targetZoneId` from the SE's `engineerMaster.zoneId`". A DTO
cannot: the engineer's zone is a database read. The DTO keeps the format validation it had; the
agreement check is in `approve`, immediately after the `SE_NOT_FOUND` lookup that already exists there
(#354/CZ-13), so it costs no extra query.

**5. The picker constrains the pair, so the 400 is a backstop rather than a workflow.** The approve
Modal's zone select drives the SE list, and changing the zone clears the SE. A picker that could offer
another zone's engineer would exist only to produce the 400 the backend now returns.

**6. `Flag cross-zone` is hidden for PLATINUM and for the Operations Head.** Platinum reaches this
queue by the auto-sweep and the backend answers a manual flag on it with `PLATINUM_USES_AUTO_ESCALATION`
— a button whose only outcome is a 400 is worse than no button. The OH is excluded because the door
itself is `@Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')` and their drawer is the read-only view
(`09-ticket-detail-ops-head-readonly.png`). The CSM **is** offered it: they hold the same door.

**7. The drawer crash (#335) was fixed by normalising the whole payload, not the one line.** The
issue's own note asks for exactly this: `isSpecial`, `countableAttempts` and `threshold` are read off
the same optional object, and a half-tolerant tab would print `undefined/undefined` into the verdict the
SPECIAL badge is meant to be checkable against.

## Where the premise was wrong

- **`cross-zone.service.ts` does not exist**; the service is `cross-zone-escalation.service.ts` (the
  round brief already corrected this).
- **Plan §4's DTO instruction is not implementable as written** — see decision 4.
- **The issue's `service:225` / `:271` line references had drifted** (#354's edits moved them), but the
  two defects they name were real and present: `listForScope`'s status filter and the never-read
  `reviewDate`. Everything else in the issue verified true against the working tree.
- **The crash is filed as #335, not #244.** #244 introduced the line; #335 (and #292 before it) is the
  issue that owns it, and its ACs are what this slice met.

## What was tested, and why in that shape

**Backend, at the service.** Every one of the five behaviours is a property of the service, and three
of them (DENIED-AUTO visibility, the zone/SE refusal, resurfacing) are only observable against real
rows — the escalation spec's existing fixture already carries two zones, two engineers and a target
zone with no designated ZM, which is exactly the shape these need. The resurfacing test runs the sweep
**three times on a frozen clock** (before the date, after it, again) because "returns to PENDING" and
"does not do it twice" are one behaviour, and only the third call can tell them apart.

**Backend, at the HTTP surface.** The controller spec grew its own self-contained fixture (zone,
company, plant, device, failure cycle, ticket, engineer, escalation) rather than borrowing a seeded
ticket: run alone this database holds no tickets at all, and the first attempt — `ticket.findFirst()` —
passed only in a full run. That is a fixture that lies.

**The scheduler.** One line in `business-sweep-scheduler.e2e-spec.ts`'s stub and one assertion, in the
existing "every sweep is wired to its tick with the right clock" case. A review date nothing reads is
the whole defect, so *that the tick reads it* is the thing worth pinning.

**Admin.** The page's three decisions moved from `window.prompt` to Modals, so `cross-zone.test.tsx`'s
existing cases were **retargeted, not rewritten** — same assertions, new handles — and the new
behaviours went into their own file so the #78 spec's fixtures stay untouched. The drawer's flag action
and the #335 guard share a file because they are the same file's two changes.

## Acceptance criteria

- **AC1 — a ZM can flag a Gold/Silver ticket cross-zone from its drawer.** ✅ `flag-cross-zone` +
  reason Modal, `POST /cross-zone/flag`, hidden for PLATINUM and for the Operations Head.
- **AC2 — the home ZM sees DENIED AUTO rows and can re-escalate.** ✅ `listForScope`'s third arm +
  the `cz-re-escalate-*` row action, ZM-only.
- **AC3 — approve uses a modal; the SE picker constrains the zone; a mismatch → 400.** ✅ Modal with
  zone→SE pickers; `ZONE_SE_MISMATCH` → 400 `SE_NOT_IN_TARGET_ZONE` naming the engineer's real zone.
- **AC4 — a deferred row returns to PENDING on its review date, with a notice.** ✅ `sweepDueReviews`
  in `crossZoneTick`; `CROSS_ZONE_REVIEW_DUE` to the deciders and a decision notice to the home ZM;
  the Review-date column shows when it will happen.
- **AC5 — history lists decisions with decider, acting role, reason, date; zone-clamped for ZM.** ✅
  `GET /cross-zone/history` + the History tab.

## Tests, verbatim

Backend (through `.scratch/locks/backend-test.sh`):

- `test/cross-zone-escalation.e2e-spec.ts` — **30 tests, all passing** (8 new under
  *"#355 — denied-AUTO visibility, SE/zone agreement, due-review resurfacing, history"*).
- `test/cross-zone-controller.e2e-spec.ts` — **15 tests, all passing** (5 new; one existing case
  retargeted from `TARGET_ZONE_AND_SE_REQUIRED` to `SE_REQUIRED`).
- `test/business-sweep-scheduler.e2e-spec.ts` — **14 tests, all passing**.

Admin (`npx vitest run` in `apps/admin`):

- `test/cross-zone-page-completion.test.tsx` — **9 tests** (new).
- `test/ticket-drawer-cross-zone-flag.test.tsx` — **6 tests** (new; 5 for AC1, 1 for #335).
- `test/cross-zone.test.tsx` — **9 tests** (8 existing, three of them retargeted to the Modals; 1 new
  mandatory-reason case).
- `test/cross-zone-incoming.test.tsx` — **1 test**, unchanged and green through the type fold-in.
- Full admin suite: **132 files / 971 tests**, 968 passing. The two failures are not this slice:
  `dispatch-cross-view-links.test.tsx` fails on `IntradayQueuePage.tsx:312` (`updates.map` of
  undefined), a file #356 is editing in the same round; `tickets-list.test.tsx` failed only under
  parallel load and passes alone (#184).
- `npx tsc -b` clean in `apps/admin`. `npx tsc --noEmit` in `apps/backend` reports only four
  pre-existing `reports.service.ts` `dataAsOf` errors from another slice in flight.

## Follow-ups this slice does not own

- **The history query has no supporting index.** `audit_logs` indexes `(entity_type, entity_id)`; this
  read filters `(entity_type, action, created_at)` and orders by `created_at`. Bounded by the 200-row
  cap and fine at current volumes, but a `(entity_type, action, created_at desc)` index is the right
  answer if the log grows. No migration was written — the drift gate cannot run on this box.
- **The history window is not operator-adjustable from the page.** The client and the endpoint both
  take `from` / `to` / `limit`; the page sends none of them and shows the 30-day default. A date-range
  control is a small follow-up, not a gap in the AC.
- **`#292` / `#335` should be closed against this slice** — the guard and its regression test landed
  here, and the admin suite's unhandled-error channel is clean.
