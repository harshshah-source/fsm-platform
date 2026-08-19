# 250 — Recommender dry-run seam + target-date parameters (preview foundation)

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-08-19. Approved Decisions 1/18: the preview must project the **real** recommender —
never a second scheduling implementation — and must be non-mutating and future-date aware. This
slice is the engine seam; #251 is the endpoint/UI.

## What to build

### Current behaviour (verified)

`RecommenderService.runForZone(zoneId, { now, runId })` is mutating by construction — **six**
mutations: ① `clearFinalizedOrphans(zoneId)` (`:264 → :504-513`) — a **zone-wide** `deleteMany` of
finalized/null-run SUGGESTED recs (a concurrent caller would delete another run's state);
② SUGGESTED recommendation writes (`:393-415`); ③ UNASSIGNABLE recommendation writes (`:309-328`);
④ `dispatchDecisionTrace.createMany` (`:480-482`); ⑤ `inventory.recordComponentBlock` (`:365`);
⑥ `inventory.resolveComponentBlock` (`:372`). There is no dry-run flag anywhere.
Several reads are `now`-bound: deferral day (`:138`), planner day (`:246`, IST-fixed by #240),
`committedDayLoad(istDate(now))` (`:244`), `currentStatusMany(…, now)` (`:525`),
`modeForZone(zoneId, now)` (`:118` — decides DEFICIT vs PREVENTIVE, i.e. whether installs appear),
`resolveActiveOverrides(…, now)` (`:122` — tier overrides), and the PREVENTIVE age-score term
(`:382`). `device_states.slaBucket` / `inactivity_hours` are materialised as-of the last recompute —
**no as-of-date variant exists or is being built**; a future-date preview inherently ranks on
current buckets. Separately: `runForActiveZones(now)` with a future `now` would create *real*
future-dated schedules — only the controller's hardcoded `new Date()` prevents it today.

### Required change

1. **`runForZone` options grow `{ dryRun?: boolean; targetDate?: Date }`.**
   - `dryRun: true` suppresses all six mutations and instead returns the full projection in memory:
     per-ticket decision (chosen SE, precedence rank, hard-filter drops, capacity outcome), the
     projected `se → plant → tickets` grouping, withheld/unassignable counts — the same data the
     writes would have carried.
   - `targetDate` (defaulting to `istDate(now)`) parameterises the date-bound reads: deferral day,
     planner day, `committedDayLoad`, `currentStatusMany`, `modeForZone`, `resolveActiveOverrides`.
     Wall-clock `now` remains separate (age terms). The projection carries an explicit
     `bucketsAsOf` field (the last recompute watermark) so #251 can state the honest limit —
     buckets/inactivity are as-of-now even for a D+1 preview.
2. **Preview orchestration** (a thin service method beside `runForActiveZones`): iterates active
   zones in dry-run, **never** touching the in-process in-flight guard, the per-zone advisory lock,
   or `dispatch_runs` (no ledger row — the trigger enum stays CRON/MANUAL).
3. **Guard the footgun:** the real `runForActiveZones` asserts its `now` is not a future day
   (beyond skew) — the preview path is now the only sanctioned way to ask about tomorrow.
4. Real-run behaviour is bit-identical when the flags are absent.

### Existing code to reuse

The entire recommender — this is a seam, not a fork. `istDate`, `liveScheduleFilter`,
`se_availability` windows and `se_planner.planned_date` (the data model already supports future
dates; only call sites passed `now`).

### Tests

- Mutation-suppression pin: a dry run against a seeded zone writes **zero** rows in
  `recommendations`, `dispatch_decision_traces`, `component_blocked_queue`, `work_schedules`,
  `plant_batch_assignments`, `batch_assignment_tickets`, `dispatch_runs` — asserted by table counts.
- Concurrency: a dry run neither blocks nor is blocked by a live `dispatchForZone` (no lock taken);
  a live run's SUGGESTED recs survive a concurrent dry run (the zone-wide orphan delete is
  suppressed).
- Target-date: tomorrow's preview uses tomorrow's deferral/planner/availability/capacity and
  today's buckets, with `bucketsAsOf` populated; a ticket deferred until tomorrow appears in
  tomorrow's preview and not today's.
- Parity: dry-run projection for *today* equals the real run's decisions on a frozen fixture
  (the "projects the real recommender" guarantee).
- Future-`now` assertion on the real path.

### Risks / rollback

Flag-gated; absent flags = current behaviour (pinned by the parity test). Rollback = revert.

## Acceptance criteria

- [ ] AC1 — Dry run writes nothing (all six mutations + the four dispatch tables + the ledger — 
      proven by count assertions) and takes no lock or in-flight slot.
- [ ] AC2 — `targetDate` moves deferral, planner, capacity, availability, mode, and tier-override
      evaluation to the target IST day; wall-clock terms stay on `now`.
- [ ] AC3 — The projection carries `bucketsAsOf` and per-ticket decision detail sufficient for
      #251 to render the plan and its caveat.
- [ ] AC4 — Today-parity: dry-run decisions equal real-run decisions on identical fixtures.
- [ ] AC5 — The real dispatch path refuses a future `now`; preview is the only future-date entry.

## UI surfaces

n/a (this slice; #251 owns the page)

## Reference

n/a

## Blocked by

Nothing hard (#240 sequenced first so the planner date is IST before it is parameterised).
Blocks #251.
