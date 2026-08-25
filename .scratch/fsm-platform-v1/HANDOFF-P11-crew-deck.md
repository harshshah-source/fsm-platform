# HANDOFF — P11 (Today's Dispatch / Crew Deck), 2026-08-25

Stopped at a safe point mid-P11. **Everything implemented is committed** (`8b342e3`, `ea8f5cd`);
this file records what is verified, what is not, and the three traps waiting for the next session.

## Where P11 stands

| Issue | State |
|---|---|
| #282 decision record + recovered design | **DONE** — `8b342e3` |
| #283 provenance seams | **DONE** — `ea8f5cd`, report `docs/progress/283-assignment-provenance-seams.md` |
| #284 read layer | **MOSTLY DONE** — both reads + controller shipped. **Open:** run-level decision stream (`GET /dispatch-runs/:runId/decisions`) and `GET /schedules?date=` |
| #285 cockpit | **DONE** — `ea8f5cd`, report `docs/progress/284-285-dispatch-today-cockpit.md` |
| #286 crashed-zone re-dispatch | **NOT STARTED** — policy ruled (#282 R3), ACs written |
| #287 MV freshness | **DONE** (backend + panel), see caveat below |
| #288 escalate-only mid-day unavailability | **NOT STARTED** — policy ruled (#282 R4), ACs written |
| #289 override impact preview | **NOT STARTED** — ACs written |
| #290 `/assign` visual grammar | **NOT STARTED** — the violet token it needs already exists (added by #285) |

## Test verification — exactly what was and was not run

**Backend, verified green after the final code state:**

- Affected surface, 135 spec files / ~639 tests — the blast radius of the provenance and read
  changes (dispatch, batch, assign, override, intraday, schedule, recommender, closure, eligibility,
  capacity, removal, deferral, candidate, day-plan, cron-tick, lost-race).
- Remaining specs batch 1, 141 files / 879 tests.

**NOT run: remaining specs batch 2 (~146 files).** The command was interrupted. Run it first:

```
$all = Get-ChildItem test -Filter *.ts | Where-Object { $_.Name -match '\.(e2e-)?spec\.ts$' } | % { $_.Name }
$affected = $all | ? { $_ -match 'dispatch|batch|assign|override|intraday|schedul|recommender|closure|eligib|capacity|removal|special-ticket|deferral|vu-|bulk-unassign|candidate|day-plan|provenance|mv-fresh|cron-tick|lost-race' }
$rest = $all | ? { $affected -notcontains $_ } | % { "test/$_" }
npx vitest run @($rest[141..($rest.Count-1)]) --reporter=basic
```

**Admin: 110 files / 613 tests green — but that run predates the `ConfigInEffectPanel` MV block.**
Re-run the admin suite; nothing else changed in admin since.

## Three traps — read before touching anything

### 1. Never run tests concurrently against the test database

`vitest.config.ts` sets `fileParallelism: false` deliberately: "tests share one local Postgres with
global invariants". Running a targeted spec while a full suite runs corrupts both. This cost two
wasted full runs in this session — **29 phantom failures**, then **163 phantom file failures** —
neither of which was a real defect. Same for `npx prisma generate` mid-run. One test process at a
time, always.

### 2. `Worker exited unexpectedly` is #184, not your bug

Three times this session a batch reported `N-1 passed (N)` with an `Unhandled Error: Worker exited
unexpectedly` and no FAIL line. Each lost file passed when run alone
(`recommender-filter-honesty`, `global-guard-validation`). See
`issues/184-vitest-worker-exited-unexpectedly.md`. Re-run the missing file alone before believing it.

Full-suite runs via `npm test` were also **killed twice** at ~2 min in this session. Running the
suite in explicit batches with `npx vitest run @files` worked reliably; that is why the verification
above is batched.

### 3. Uncommitted work from earlier sessions is interleaved with this one

These files carry **other issues' uncommitted work** and were deliberately **left out** of
`ea8f5cd`:

| File | Whose | Why it matters |
|---|---|---|
| `apps/admin/src/api/dispatch-runs.ts` | #270 (`notEnforcedFilters`) **+ my `eligibilityMv` type** | The MV panel below needs my half of it |
| `apps/admin/src/pages/dispatch/ConfigInEffectPanel.tsx` | #270 (eligibility-proxy note) **+ my MV freshness block** | #287's UI half lives here |
| `apps/backend/test/day-plan-notification-outbox-writers.e2e-spec.ts` | #264 (untracked test file) **+ my fixture fix** | **The fixture fix is required**: it built its actor as `'zm-obx-' + NS`, and #283 writes `added_by` to a `uuid` column, so the old fixture now fails. Whoever commits #264 must include it |

So **#287 is backend-complete and committed, but its ConfigInEffect display is uncommitted** —
it exists in the working tree, typechecks, and will land whenever #270's admin work is committed.
The wider tree also has ~30 files of prior-session work (charts, reports, settings, #281's own
frontend). Do not assume `HEAD` reflects the working tree.

## Two design decisions the next session must not undo

**No `MANUAL_ASSIGNED` batch status.** It looks like the obvious fix for human batches stamped
`AUTO_ASSIGNED`, and it is a data-loss bug: seven production readers use
`status IN ('AUTO_ASSIGNED','OVERRIDDEN')` as the live-batch predicate
(`engineers-query.service.ts:201,275`, `me-tickets/se-ticket-access.ts:53`,
`me-tickets-query.service.ts:49`, `zm-schedule-query.service.ts:106,133`,
`day-plan-query.service.ts:43`). Provenance is on the ticket row; `status` stays a lifecycle column.
The reasoning is in #283's "Explicitly NOT in scope" section — read it before "fixing" this.

**NULL provenance is unknown, never system.** A pre-#283 row records nothing and history is
deliberately not backfilled. The cockpit draws it dotted and says why. Drawing it solid is the one
failure the whole grammar exists to prevent (#282 R2), and it has its own test.

## Suggested next order

1. Finish verification (batch 2 + admin re-run).
2. **#286** — highest operational value, policy already ruled, and its "stop deleting failed-run
   traces" note pairs naturally with the re-dispatch work.
3. **#284's leftovers** — the decision stream makes Replay real rather than a link.
4. **#290** then **#289**, **#288**.

## Reading order for the next session

`CLAUDE.md` → `docs/SYSTEM-STATE-2026-07.md` (§2.4 and §3k are updated) → `INDEX.md` §P11 →
`audit/scheduler-engine-forensics-2026-08-25.md` (the evidence base) →
`docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html` (authoritative design) → the issue.
