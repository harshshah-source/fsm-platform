# 254 — `plant-eligibility-refresh` fires after the dispatch it feeds (unpinned cron, #240 family)

Status: done (2026-08-20)
Type: AFK · Backend

Filed 2026-08-19 while documenting the daily cron chain for #247. Not found by a test — found by
writing down what the chain actually does and noticing one row could not be true.

## The defect

`plant-eligibility-refresh-scheduler.service.ts:59` registers its `@Cron` with **no `timeZone`**:

```ts
@Cron(readPlantEligibilityRefreshConfig().refreshCron, { name: 'plant-eligibility-refresh' })
```

Its own docstring states the intent and, in doing so, states the bug:

> "daily at 04:30 **UTC**, i.e. shortly before the default 05:00 dispatch tick, so the floating-SE
> eligibility index is rebuilt from current plants + territory before the morning batch consumes it"

The 05:00 dispatch is **05:00 IST** — `dispatch-cron.ts:19` with `timeZone: BUSINESS_TIMEZONE`, i.e.
**23:30 UTC the previous day**. So on a UTC host (no `TZ` is set in any compose/Dockerfile/env in this
repo) the refresh fires at 04:30 UTC = **10:00 IST, five hours after** the batch it exists to feed.
The morning dispatch therefore reads a `plant_eligible_floating_se` MV that is up to a day stale.

This is exactly the defect #240 fixed for `schedule-closure`, which had the identical shape
(`0 4 * * *`, unpinned, landing at 09:30 IST *after* the 05:00 IST dispatch). #240 fixed the two jobs
it was scoped to and this one was not in scope; #247 pinned the new `vu-auto-resume` from the start.
`plant-eligibility-refresh` is the last unpinned link in the daily chain.

## Impact, honestly bounded

Not catastrophic, because #138 slice 1 made the recommender's floating leg **re-check
`coverage_type`/`is_active` live** rather than trusting the MV, and slice 2 refreshes it after every
successful master sync. This scheduler is the periodic *backstop* for the cases those two do not cover
— a lost post-commit refresh, or a plant/district geometry change landing between syncs. So the
consequence is that the backstop's staleness bound is a day wider than intended, on the plant↔SE
geometry the floating leg still reads from the MV.

Worth fixing regardless: the job's stated contract ("before the morning batch") is simply false today,
and a reader who trusts the docstring will reason wrongly about MV freshness.

## What to build

1. Register with `timeZone: BUSINESS_TIMEZONE` (import from `scheduling/dispatch-cron`), exactly as
   `ScheduleClosureScheduler` and `VehicleReturnResumeScheduler` do.
2. Correct the docstring: `30 4 * * *` is then **04:30 IST**, between the 04:00 closure and the 05:00
   dispatch, which is what it always meant to say. Note that `PLANT_ELIGIBILITY_REFRESH_CRON` is
   thereafter read as an **IST** expression.
3. Pin it behaviourally, following `schedule-closure-wiring.e2e-spec.ts` and
   `vu-auto-resume-wiring.e2e-spec.ts`: assert the absolute next firing instant (04:30 IST = 23:00 UTC
   the previous day), not the stored options. **Verify the probe under `TZ=UTC`** — the dev host runs
   on IST, so removing the pin does not turn such a test red locally.
4. While there: check whether any *other* `@Cron` whose cadence means a wall-clock hour is still
   unpinned. The `business-*` sweeps are correctly unpinned (every 2/5/15 min, plus the report cubes,
   which are UTC-day/UTC-month bounded by construction) — but `business-system-efficiency` (`30 1 * * *`)
   and the three month-start cubes are worth an explicit ruling rather than an assumption, since they
   finalise a *day* and a *month* whose boundaries the rest of the system now reads as IST.

## Acceptance criteria

- [x] AC1 — `plant-eligibility-refresh` fires at 04:30 IST on any host, pinned and asserted absolutely.
- [x] AC2 — The docstring states IST and no longer claims a UTC time is "shortly before" an IST one.
- [x] AC3 — The pin is verified to fail under `TZ=UTC` without the `timeZone` option (recorded, since
      it cannot fail on an IST host).
- [x] AC4 — The report-cube crons' day/month boundary semantics are ruled on explicitly: either pinned,
      or documented as deliberately UTC-bounded with the reason.

## Closed 2026-08-20

AC1/AC2: `timeZone: BUSINESS_TIMEZONE` on the registration, docstring rewritten to say 04:30 **IST**,
between the 04:00 IST closure and the 05:00 IST dispatch, and to note `PLANT_ELIGIBILITY_REFRESH_CRON`
is thereafter an IST expression. AC3: the behavioural pin (in
`plant-eligibility-refresh-scheduler.e2e-spec.ts`, absolute instant 23:00 UTC) was run **red first
under `TZ=UTC`** — `expected 4 to be 23`, i.e. the job firing at 04:30 UTC, the defect verbatim — then
green under both `TZ=UTC` and the host IST after the one-line fix. On the IST host alone it cannot go
red, which is why the TZ=UTC run is the recorded evidence.

AC4 — the ruling on what stays unpinned, and why:

| Cron(s) | Verdict |
|---|---|
| `ingestion-telemetry`, `ingestion-masters`, and the minute-cadence `business-*` sweeps (verification, install-verification, intraday-timeout, cross-zone, repeat-escalation, tier-override-expiry, soft-inactive) | **Correctly unpinned** — "every N minutes" has no wall-clock meaning; a timezone would change nothing. |
| `partition-maintenance` (`10 0 * * *`) | **Unpinned, acceptable** — it creates/drops time-range partitions whose boundaries are data-defined; the hour it runs at only needs to be off-peak, which 00:10 is in either zone. |
| The report cubes — `business-system-efficiency` (`30 1 * * *`), `business-fleet-uptime`, `business-root-cause`, `business-zm-performance` (month-start) | **Deliberately unpinned/UTC until #214 executes.** The cubes' day/month boundaries are UTC by construction (`previousUtcDayStart`), and the operator ruling to move analytics to the IST day is filed as #214, which requires a written finding per cube before any recompute. Pinning these crons *now* would make new rows IST-bounded against UTC-bounded history inside one cube — the worst of both. The pin belongs to #214's execution, not here. |

## Blocked by

none.
