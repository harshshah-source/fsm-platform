# HANDOFF — #204 (IST day boundary) partially landed; #213 not started

Created 2026-08-04. Live handoff — **move to `docs/archive/` with a 2-line ARCHIVED banner as soon as
it is consumed** (per `CLAUDE.md` §Progress & state convention).

Parent epic: [#197](./197-mobile-pilot-readiness-remediation-epic.md) ·
This issue: [#204](./204-time-semantics-day-boundary-implementation.md) ·
Next issue: [#213](./213-configurable-dispatch-schedule.md)

## Read first

1. `CONTEXT.md` **Decisions §19** — the ruling this implements (IST operating day, 05:00 IST
   configurable dispatch). It is the authority; do not re-derive it.
2. [#198](./198-decision-day-boundary-and-dispatch-clock.md) — the ruling's options, evidence, and the
   verbatim operator instruction on dispatch configurability.
3. `#204`'s own `## 2026-08-04 — implementation notes` section — the design correction that shaped
   what landed, and the one open question below.

## What landed (committed, green)

- **`apps/backend/src/common/ist-day.ts`** — two helpers, deliberately separate:
  - `istDate(now)` → UTC midnight of the IST **calendar date**, for `@db.Date` columns
    (`deferred_until`, `deferred_to_date`, `date_from`, `date_to`).
  - `istDayStartInstant(now)` → the real **instant** IST midnight occurred, for `@db.Timestamptz`
    (`removed_at`).
  - **Why two:** a single helper cannot serve both. Passing the DATE form to a timestamptz comparison
    shifts the window by 5h30m and nothing fails loudly — which is what the retired `utcDayStart` was
    doing at `me-tickets-query.service.ts`.
- **All 13 call sites migrated** across 12 services; `src/common/utc-day.ts` **deleted** so there is
  exactly one definition.
- **Cron pinned** — `@Cron(..., { timeZone: BUSINESS_TIMEZONE })` on `business-dispatch`;
  `BUSINESS_TIMEZONE = 'Asia/Kolkata'` is exported from `dispatch-scheduler.service.ts` for #213 to
  reuse.
- **Tests:** `test/ist-day.spec.ts` (12, new) + a behavioural timezone assertion appended to
  `test/dispatch-scheduler.e2e-spec.ts`. Both went red first — the cron one failed
  `expected 5 to be 23`, confirming it had been firing at 05:00 in the *host's* zone.

## What is NOT done on #204 — pick up here

### 1. Leave-window IST interpretation (`B8`) — design settled, not written

`leave-request.controller.ts:52-53` does `new Date(body.windowStart)`. For a date-only `YYYY-MM-DD`
that yields **UTC midnight = 05:30 IST**, so an SE who books 10 Aug is still available for the first
5h30m of it.

Design already worked out — implement this, don't re-derive it:
- `leave_requests.window_start/window_end` and `se_availability.window_start/window_end` are all
  **`@db.Timestamptz`** (real instants), not dates.
- The active-window predicate is `windowStart <= now AND windowEnd > now`
  (`se-availability.service.ts:45,73`) — **`windowEnd` is exclusive**.
- Therefore a single IST leave day maps to `[IST midnight of that date, IST midnight of the next date)`
  — e.g. 2026-08-10 → `2026-08-09T18:30:00Z` to `2026-08-10T18:30:00Z`.
- **Must keep handling full ISO instants unchanged.** Admin sends `datetime-local` values
  (`SeManagementPage.tsx:315,323`; `VehicleUnavailabilityPage.tsx:168`), which are real instants and
  must not be re-interpreted as IST calendar days. Branch on "is this date-only?", don't blanket-convert.
- Write the failing test first: a single-day leave request leaves the SE unavailable at 00:15 IST and
  at 23:45 IST on that date, and available at 00:15 IST the next day.

### 2. Admin planner alignment

`apps/admin/src/pages/planner/PlannerPage.tsx:33-39` derives `YYYY-MM-DD` from **device-local**
`getFullYear/getMonth/getDate`. It agrees with the backend only when the operator's machine is set to
IST. Derive the IST date instead. Note `apps/admin/src/lib/datetime.ts` exists as the shared home —
prefer putting an IST helper there over a page-local function, mirroring the backend's one-definition
posture. **There is no `PlannerPage` test file today**, so a small one is the cheap win.

### 3. AC housekeeping

`#204`'s ACs are still unticked. Tick what actually landed; do not tick the two items above.

## OPEN QUESTION — needs an operator ruling before #204 closes

**The analytics day is still UTC while operations are now IST.**
`business-sweep-scheduler.service.ts:89` defines its **own** `previousUtcDayStart` (a different symbol,
so the migration sweep did not catch it) and feeds `SystemEfficiencyAggregationService.computeDay` at
`:189`. A ticket closed at 02:00 IST now sits on today's Day Plan but in **yesterday's** efficiency cube.

Left unchanged deliberately — it is not a like-for-like fix: `system_efficiency_summary_daily` already
holds rows computed on UTC boundaries, so changing the boundary either rewrites recorded history or
leaves a seam. The same question applies to the fleet-uptime / root-cause / ZM-performance /
soft-inactive cubes, which were **not** audited.

Three options are written up on `#204`: (a) leave analytics on UTC and document the discontinuity;
(b) move and recompute; (c) move from a cutover date forward. **Raise this before closing #204.**

## #213 — not started

Fully specified and unblocked; read its `## Approved direction (operator, 2026-08-04)` section, which
is binding. Two things it must NOT rebuild — verified as already existing:
the manual `POST /api/schedules/dispatch-run` endpoint with its `OPERATIONS_HEAD`/`CSM` role gate and
its full `MANUAL`+actor audit bracket, and the admin "Run dispatch" button.

The two real gaps: the schedule is an **env var** (`BUSINESS_SWEEP_DISPATCH_CRON`) rather than a
`system_settings` entry, and the single-in-flight guard is a **private field on the scheduler**
(`dispatch-scheduler.service.ts:41,53,57,65`) while the manual trigger calls
`DispatchRunService.runForActiveZones` **directly** (`schedules.controller.ts:78`), bypassing it.

**Load-bearing detail for #213:** `@Cron` at `dispatch-scheduler.service.ts:50` evaluates its
expression **once at class-decoration time**. That is exactly why the operator's "must take effect
without a restart" requires **re-registering the job on write** (via `SchedulerRegistry`), not
re-reading the setting per tick.

## Verification commands

```bash
cd apps/backend
node scripts/run-tests.mjs test/ist-day.spec.ts test/dispatch-scheduler.e2e-spec.ts   # the new work
node scripts/run-tests.mjs                                                            # full — mandatory for #204
npx tsc --noEmit -p tsconfig.json
```

## Environment note (unchanged, still true)

The dev DB is still missing the `device_tokens` migration — `pnpm prisma migrate deploy` before the
next backend restart, or logout 500s. See `audit/mobile-device-readiness-2026-08-04.md`.
