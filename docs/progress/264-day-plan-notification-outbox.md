# 264 — Durable day-plan notification outbox (executes #189)

**Status:** DONE · 2026-08-24 · branch `feat/autoplant-integration`
**Issue:** `.scratch/fsm-platform-v1/issues/264-day-plan-notification-outbox.md` · **Decision:** #258
Part 7 (G5, G7). Supersedes #189 (marked done via this issue, per INDEX.md's own note).
**Suite at completion:** backend full suite, 4 foreground chunks, **414 files / ~2090 tests, 0 failed**
(two `#184` Windows worker-crash flakes, both self-recovered on retry — pre-existing, unrelated).
Admin: 106 files / 555 tests, 0 failed (the pre-existing unrelated `TicketDetailDrawer.tsx:440`
runtime fault, not a test failure, flagged by every recent handoff). Backend and admin `tsc --noEmit`
both clean.

---

## 1. What was wrong

Dispatch/override "Day Plan is live/updated" events lived in a process-local array, fired post-commit
with no durability: a crash between commit and the notify loop silently lost the notification forever
(re-run is a no-op — the recs are already DISPATCHED). Worse, a notifier throw propagated OUT of
`dispatchForZone`/the six override write-paths and was caught by `DispatchRunService.processZone` as a
**zone dispatch error** — the sharpest observability inversion in the engine: a zone that fully
succeeded reported as failed because an unrelated notification channel hiccuped.

## 2. What was built

**`day_plan_notification_outbox`** (migration `20260824140000_day_plan_notification_outbox`):
`(id, event_type, se_id, schedule_id, zone_id NULL, payload JSONB, created_at, sent_at NULL, attempts,
last_error)`. A partial index `(created_at) WHERE sent_at IS NULL` backs the sweep's query — not
expressible in the Prisma schema DSL, added as raw SQL (the established convention for every other
partial index in this schema).

**`scheduling/day-plan-notification-outbox.ts`** — the module both writers and the sweep share:
- `queueDayPlanDispatched`/`queueDayPlanOverridden(tx, event)` — write the intent inside the caller's
  own transaction, return the row id.
- `drainRow(prisma, notifier, row, now)` — **claims first, delivers second**: a guarded
  `transitionOrConflict`-style `sentAt IS NULL` update wins or loses BEFORE the notifier is ever
  called, which is what makes "duplicate drain delivers once" literally true (the losing racer never
  calls the notifier at all, not just never double-writes the row). A delivery failure un-claims the
  row (`sentAt: null`, `lastError` stamped) so a later drain retries it.
- `drainRows`/`drainUnsent` — the post-commit "drain what we just wrote" call and the sweep's "drain
  everything still unsent, bounded attempts" call.
- `pruneSentDayPlanOutbox` — retention, ridden on the existing daily `partition-maintenance` tick
  (`#263 AC-4`'s own precedent for the claim table), not a 21st cron.

**Writers — both now write inside their own transaction, drain after commit:**
- `batch-assignment.service.ts`: `dispatchForSe`'s per-SE transaction (#262) writes one outbox row
  per SE; `dispatchForZone` collects the ids and calls `drainRows` once, after every SE's transaction
  has settled. A rolled-back SE transaction takes its outbox row with it (JS-side id never resolves
  against a real row — `drainRows` fetches by id and simply finds nothing).
- `override.service.ts`: all **six** `dayPlanOverridden` call sites (`removeTicket`, `deferTicket`,
  `reorder`, `assignTicket`, `swapSe`, `moveTickets`) now queue the outbox row inside their existing
  `withAudit` transaction and return its id, then drain post-commit. Every one of these previously
  called the notifier directly after the transaction had already committed — the identical fragility
  the dispatch path had.

**The sweep**: `business-notification-outbox` (`*/2 * * * *`, minute-cadence family, unpinned tz — a
re-drain backstop, not a wall-clock job), wired through `BusinessSweepSchedulerService.runGuarded`
exactly like the other eleven sweeps (single-in-flight guard, `#263`'s tick claim, never throws out of
the cron context).

## 3. Corrections to the issue text / decisions made while implementing

- **Module wiring gap the issue didn't anticipate.** `BusinessSweepSchedulerModule` deliberately does
  NOT import `SchedulingModule` (its own docstring: avoiding a cycle with `IntradayModule`/
  `CrossZoneModule`, which already depend on it), so `DAY_PLAN_NOTIFIER` was unreachable from the
  sweep's DI container. Fixed by exporting `DAY_PLAN_NOTIFIER` from `SchedulingModule` (additive — it
  was already provided there, just not exported) and importing `SchedulingModule` into
  `BusinessSweepSchedulerModule` for that one token. The edge stays one-directional (`SchedulingModule`
  still does not import the sweep module back), so this does not reopen the cycle the docstring warns
  about.
- **Constructor param order, found by four failing specs.** The natural place to add `prisma`/
  `dayPlanNotifier` was right before the existing trailing `config?` param — but four specs
  (`business-sweep-scheduler{,-install,-intraday}.e2e-spec.ts`, `cron-tick-claim-wiring.e2e-spec.ts`)
  construct `BusinessSweepSchedulerService` positionally, ending their argument list at `config`.
  Inserting earlier silently shifted their `config` object into the new `prisma` slot instead of
  failing to compile — `readBusinessSweepSchedulerConfig()`'s environment-read default then resolved
  `enabled: false`, and every sweep those specs expected to run reported `DISABLED`. Fixed by
  appending the two new params AFTER `config` instead, both optional (a spec that never calls
  `notificationOutboxTick` needs neither); the module's real factory now passes `config` as explicit
  `undefined` so `prisma`/`dayPlanNotifier` land in their own named slots. `scheduler-wiring.e2e-spec.ts`
  and the four affected specs are the regression guard for this — see §4.
- **AC's literal "guard the send with a conditional `sent_at IS NULL` claim update" reads two ways**
  (claim-then-un-claim-on-failure, vs. claim only after confirmed success). The former is what the
  data model (`sent_at`/`attempts`/`last_error`, no separate lease column) actually supports without a
  narrow reopened-race window that is provably harmless (a racer that already lost the claim has
  already returned by the time a later un-claim happens) — implemented and pinned by
  `test/day-plan-notification-outbox.e2e-spec.ts`'s duplicate-drain test, which runs two real
  concurrent racers against Postgres and asserts exactly one delivery.

## 4. Tests

- `test/day-plan-notification-outbox.e2e-spec.ts` (new, 7 tests) — the module's own seam: a written,
  undrained row is delivered once by the sweep; a throwing notifier leaves the row unsent with
  `lastError` and never propagates; a rolled-back writing transaction leaves no row; two genuinely
  concurrent racers on one unsent row deliver exactly once; `dayPlanOverridden` intents drain through
  the same mechanism; an exhausted row (`attempts >= MAX_OUTBOX_ATTEMPTS`) is excluded from the sweep;
  `pruneSentDayPlanOutbox` removes only sent rows past retention.
- `test/day-plan-notification-outbox-writers.e2e-spec.ts` (new, 2 tests) — the writer-side integration
  ACs against a real dispatch run and a real override: a notifier throw leaves the run `SUCCESS` with
  **zero zone errors** (the core misreport-inversion AC) and the outbox row carries the error; the same
  for `assignTicket`'s override path.
- `scheduler-wiring.e2e-spec.ts` — pin 19 → 20 registered cron jobs, `business-notification-outbox`
  added to the decision-record list.
- `business-sweep-scheduler.e2e-spec.ts` — `readBusinessSweepSchedulerConfig`'s exact-shape assertion
  gained `notificationOutboxCron`; the "registers all N named jobs" test gained the twelfth name.
- Regression, all green: every `batch-override-*`, `override-defer-*`, `override-schedule-live`,
  `deferral-override-confirm`, `critical-assign`, `ist-day-boundary-scheduling`, `lost-race-hygiene`,
  `dispatch-run*`, `partition-maintenance*`, `cron-tick-claim-wiring`, `business-sweep-scheduler-
  {install,intraday}` — no behavioural regression from the transaction/return-shape restructuring
  across all six `override.service.ts` call sites.
- **Full backend suite** (4 foreground chunks) and **full admin suite**: 0 failed, confirming the
  restructuring across `batch-assignment.service.ts` and all six `override.service.ts` call sites
  introduced no regression anywhere else in the codebase.

## 5. What's left

None on this issue's own ACs. `#189` (the defect record this issue executes) can be marked
superseded-by-#264 in `CONTEXT.md`/`INDEX.md` bookkeeping, consistent with how the issue file states
its own relationship to #189.
