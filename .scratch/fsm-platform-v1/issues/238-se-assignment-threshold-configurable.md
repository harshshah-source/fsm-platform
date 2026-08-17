# 238 — The SE-assignment threshold is configurable, co-owned by OH and CSM, with the OH holding the final decision

Status: done
Type: Backend + Admin · Settings / Ticketing / Recommender

Filed and built 2026-08-13 from an operator ask: *"the threshold of when the SE should be assigned
should be configurable in setting like 12hr+, 24hrs+, 48hrs+ etc, and authority will be in the hands
of OH and CSM, and OH has the final decision."*

## What was actually asked for, and what it is not

The platform already had a threshold that looked like the one being asked for —
`system_settings.inactivity_threshold_hours`, default 24 — and using it would have been wrong.

That key defines `device_states.is_inactive` (`device-state.service.ts:179`), which is the
**denominator of Fleet Uptime %** and the **Soft Inactive Count that zones are graded on**. Moving it
to change dispatch behaviour silently restates every historical KPI and makes zones non-comparable in
the exact reports built to compare them. This is not a new observation:
`docs/proposals/zone-engine-customization-2026-07-21.md` §3.1 argues it at length, and
`audit/STATUS.md:281` says it outright — *do not overload `inactivity_threshold_hours`.*

So #238 adds a **second, independent** key, `se_assignment_threshold_hours`. `is_inactive` keeps
meaning "silent past the canonical 24 h" for every report; the new key alone decides when that silence
becomes fieldwork. The two are free to differ in either direction, and the shipped default is 24 —
equal to the inactivity threshold — so **the deploy changes no behaviour until an operator moves it**.

## Decisions taken (operator, 2026-08-13)

| Question | Decision |
|---|---|
| How does "OH has the final decision" work? | **Both write; the OH can lock and revert.** A CSM change takes effect immediately; the OH can lock the key (freezing the CSM out) and revert to any recorded prior value. Not an approval queue — a reversible veto, so the CSM's day-to-day work is never blocked waiting on a signature. |
| What does the threshold gate? | **Assignment *and* ticket creation.** A lower value genuinely opens work earlier (tickets can exist for devices the dashboards do not yet call Inactive); a higher value is a grace window. |
| Is manual assignment blocked? | **No — auto-dispatch only.** A ZM/CSM/OH assigning intraday keeps their judgement; the queue badges the ticket `HELD · 18/48h` instead of refusing the click. |

## The ladder

The selectable values are exactly the `SLA_BANDS` lower bounds — **4, 8, 12, 24, 48, 72, 120, 168**.
Not arbitrary round numbers: every choice lands on a boundary the rest of the platform already draws,
so "assign from 48 h" means precisely "assign from HIGH_CRITICAL onward", and the queue colour an
operator is looking at while they decide is the same one the threshold speaks in. A free-text hour
count would let someone pick 37 and split a bucket, which nothing downstream could render honestly.
Enforced server-side in `parseAssignmentThresholdHours` — the single admission point.

## The load-bearing correctness constraint

`TicketCreationService` and `AutoRecoveryService` are **exact complements**: creation takes silence at
or past the threshold, recovery takes silence below it, so no device can be touched by both on one
telemetry pass. `auto-recovery.service.ts`'s own docstring states this. That invariant was carried by
`is_inactive` on both sides.

Moving only creation onto the new threshold would have broken it, and the failure is silent: with the
threshold at 12 h, a device silent 18 h is ticketed by creation and — on the same pass — is not
`is_inactive` (24 h has not elapsed), so an unchanged auto-recovery scan hands it straight back. The
ticket opens and closes on every tick, forever, each closure filed as a self-healing device, quietly
inflating the productivity and component reports. Nothing errors.

Both stages therefore read the one setting, complementary down to the null case.
`test/se-assignment-threshold-engine.e2e-spec.ts::complementarity` is the test that would catch it.

## A measured correction worth recording

The dispatch-side gate was first written as
`NOT: { state: { is: { inactivityHours: { lt: threshold } } } }` — the natural way to say "withhold
only on positive evidence of being below the threshold". **It is wrong**, and it was proved wrong
against the database rather than reasoned about: Prisma renders the negated to-one relation filter such
that a `device_states` row with `inactivity_hours = NULL` matches neither the filter nor its negation,
so every NULL-houred device is silently dropped instead of passing. Probed directly — `NOT(...)` → 0
rows, explicit `OR` → 1 row. The shipped gate is the three-branch `OR` (at-or-past / measurably
unknown / no state row), each branch verified.

This also surfaced two **pre-existing fixture contradictions** that only became observable once the
services read the hours instead of the flag: `auto-recovery.e2e-spec.ts` seeded an `is_inactive` device
at `inactivity_hours: 2` while also labelling it `CRITICAL` (a 24–48 h band), and
`plant-deactivation.e2e-spec.ts` set `latestGpsDatetime` 30 h back but never the derived hours.
Recompute derives the flag *from* the hours, so neither state could exist in production. Both fixtures
were corrected to describe devices that could.

## Acceptance criteria

- [x] AC1 — `se_assignment_threshold_hours` exists in the settings registry, defaulting to 24, with a
      description that names `inactivity_threshold_hours` and says why it is separate.
- [x] AC2 — Only SLA-band boundaries are accepted; anything else is refused with the allowed list.
- [x] AC3 — OH **and** CSM can read and set it; ZM can read and never write; everyone else is refused.
- [x] AC4 — The OH can lock it. While locked, the CSM is refused with the lock's **stated reason**, and
      the OH still writes through. The OH can unlock.
- [x] AC5 — Every change appends a `setting_changes` row carrying the value it replaced; the OH can
      revert to a specific past change, and the revert is itself recorded rather than erasing it.
- [x] AC6 — Ticket creation opens Failure Cycles at the configured threshold, not at `is_inactive`.
- [x] AC7 — Auto-recovery scans the exact complement, so no device is in both scans on one pass.
- [x] AC8 — The recommender withholds tickets below the threshold from **auto**-dispatch, counts them
      separately from `unassignable`, and stamps both on the dispatch-run ledger.
- [x] AC9 — The dispatch-run config snapshot captures the new key (and `inactivity_threshold_hours`,
      the #124/2026-07-22-audit gap, since the pair is only readable together).
- [x] AC10 — UI parity: an OH Settings tab **and** a CSM-reachable route, showing the value, the ladder,
      the consequence against the live Inactive definition, the lock state with its reason, and the
      revertible history. Nav link for OH + CSM only.
- [x] AC11 — The ticket queue badges below-threshold work without blocking manual assignment.

## Not done (deliberate)

- **No per-zone threshold.** Global, for the reason the zone-customization proposal gives: a graded
  party must not set the dial that moves the numbers they are graded on. The ZM read-only view exists
  so they can *see* the policy they work under.
- **No mobile surface.** The SE app has no settings shell and this is not an SE-facing control.
- **No backfill of `withheld_below_threshold` for historical runs.** The column defaults to 0 and the
  per-zone `assignment_threshold_hours` to NULL, which is honest: those runs had no threshold gate.

## Files

Backend: `settings/assignment-threshold.ts`, `settings/setting-authority.ts`,
`settings/assignment-threshold.service.ts`, `settings/assignment-threshold.controller.ts`,
`settings/settings.service.ts`, `settings/settings.controller.ts`, `settings/settings.module.ts`,
`app.module.ts` (controller **order** — see below), `ticketing/ticket-creation.service.ts`,
`ticketing/auto-recovery.service.ts`, `recommender/recommender.service.ts`,
`scheduling/dispatch-run.service.ts`, `ticketing/ticket-query.service.ts`,
`prisma/schema.prisma` + migration `20260813120000_se_assignment_threshold_governance`.

Admin: `api/assignmentThreshold.ts`, `pages/settings/AssignmentThresholdSection.tsx`,
`pages/admin/AssignmentThresholdPage.tsx`, `pages/settings/SettingsPage.tsx`,
`pages/settings/sections.tsx` (access matrix), `AppRoutes.tsx`, `components/shell/nav.ts`,
`pages/tickets/ticketBadges.tsx`, `pages/tickets/TicketsPage.tsx`, `api/tickets.ts`.

> **`AssignmentThresholdController` must stay registered BEFORE `SettingsController` in
> `app.module.ts`.** Nest matches in registration order and `PUT /api/settings/:key` also matches
> `PUT /api/settings/assignment-threshold`. Registered after it, the governed endpoint would be dead —
> the write would fall through to the generic key writer, which refuses the key, while every
> service-level test still passed. Pinned by a test.

## Tests

- `test/se-assignment-threshold.e2e-spec.ts` — 14: ladder, authority unit, CSM set, lock/unlock,
  OH-through-lock, revert, ZM read-only, generic-writer refusal, route-order pin.
- `test/se-assignment-threshold-engine.e2e-spec.ts` — 5: default parity, raised, lowered, and
  complementarity in both directions.
- `apps/admin/test/assignment-threshold.test.tsx` — 12: ladder, consequence copy, save, locked-out CSM
  banner, OH lock + revert targets, queue badge (4 cases), nav visibility by role.
