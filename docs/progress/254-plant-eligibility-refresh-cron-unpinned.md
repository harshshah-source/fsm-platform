# #254 — the last unpinned link in the daily cron chain

**Done 2026-08-20.** One line of behaviour (`timeZone: BUSINESS_TIMEZONE` on the
`plant-eligibility-refresh` registration), a rewritten docstring, one behavioural pin, and the AC4
ruling on everything that deliberately stays unpinned.

## The defect

`plant-eligibility-refresh-scheduler.service.ts` registered `30 4 * * *` with no `timeZone`. Its own
docstring stated the intent — "04:30 UTC, shortly before the default 05:00 dispatch tick" — and in
doing so stated the bug: that dispatch is 05:00 **IST** (23:30 UTC), so on a UTC host the refresh
landed at 10:00 IST, **five hours after** the batch it exists to feed, and the morning dispatch read a
`plant_eligible_floating_se` MV up to a day stale. Identical shape to the #240 `schedule-closure`
defect, on the one job that fix did not cover; #247's `vu-auto-resume` was pinned from the start.

Impact honestly bounded, as the issue records: #138 slice 1 re-checks `coverage_type`/`is_active`
live, and slice 2 refreshes after each master sync — this scheduler is the *backstop*, so the effect
was a backstop whose staleness bound was a day wider than its stated contract.

## Verification — under the clock that can actually fail

This host runs IST, where an unpinned cron gives the pinned answer, so the RED had to be produced
under `TZ=UTC npx vitest run` (the environment #107's CI will actually use):

| | `TZ=UTC` | host (IST) |
|---|---|---|
| pin, before the fix | **red — `expected 4 to be 23`** (firing 04:30 UTC, the defect verbatim) | green (cannot fail here) |
| pin, after the fix | green 7/7 | green 7/7 |

The pin (in `plant-eligibility-refresh-scheduler.e2e-spec.ts`) asserts the **absolute next-fire
instant** — 04:30 IST = 23:00 UTC the previous day, after the 04:00 IST closure (22:30 Z) and before
the 05:00 IST dispatch (23:30 Z) — following the #240/#247 wiring-pin pattern, not the stored options.

## AC4 — the ruling on what stays unpinned

Recorded in the issue file in full. In brief: the minute-cadence sweeps and ingestion crons are
correctly unpinned (no wall-clock meaning); `partition-maintenance` at 00:10 only needs to be
off-peak, which it is in either zone; and the four report-cube crons stay **deliberately UTC until
#214 executes** — their day/month boundaries are UTC by construction, the operator ruling to move
analytics to the IST day is filed as #214 with a required per-cube finding first, and pinning the
crons *now* would split each cube between UTC-bounded history and IST-bounded new rows. The pin
belongs to #214's execution.

With this, **every `@Cron` in the codebase whose expression means a wall-clock hour to an operator is
pinned to `Asia/Kolkata`**, and every unpinned one has a written reason.
