# #260 — The 05:00 run waits out brief contention instead of skipping a zone until tomorrow

**Landed** 2026-08-23 · branch `feat/autoplant-integration` · TDD via `/tdd`
**Issue:** [`.scratch/fsm-platform-v1/issues/260-dispatch-cron-bounded-retry.md`](../../.scratch/fsm-platform-v1/issues/260-dispatch-cron-bounded-retry.md)
**Commit:** `cf5c799`

---

## What changed, in one paragraph

#259 shrank a refusal from the whole request to the single zone, which was the important half. The
half it left: a zone contended at 05:00:00 by something that finishes at 05:00:20 still got **nothing
that day**, because the cron asks once and the next attempt is tomorrow. The automatic run is now
patient — it re-asks every `DISPATCH_RETRY_INTERVAL_MS` (default 60 s) until
`DISPATCH_RETRY_DEADLINE_MS` (default 15 min), dispatching every zone it recovers under the **same**
`dispatch_runs` row. A MANUAL run is never patient.

## Acceptance criteria

All four met, in `apps/backend/test/dispatch-cron-bounded-retry.e2e-spec.ts` (7 tests).

| AC | Where | Note |
|---|---|---|
| 1 · zone held briefly → retry admits and dispatches within the window, same runId, zone DONE | `waits for the only zone it wants…` (admission path) and `promotes a CONTENDED zone in place…` (in-run path) | **Two tests, because there are two paths** — see below |
| 2 · held past the deadline → zone stays CONTENDED, run PARTIAL, a log line states the give-up | `gives up at the deadline, leaving the zone CONTENDED and the run PARTIAL` | Plus `still refuses with zero rows when the wait runs out on a single-zone run` — patience must not turn "everything is busy" into an empty run row |
| 3 · manual runs never wait (timing-asserted) | `never makes a MANUAL run wait, however patient the config is` | Given a policy that would keep a CRON run waiting 10 s; asserted under 400 ms |
| 4 · retry never starts a second `dispatch_runs` row | asserted in both AC-1 tests | One run row, and one *zone* row — the CONTENDED claim is promoted, never duplicated |

## Design decisions

**Patience lives in two places, and the issue does not say so.** This is the one thing that is not
obvious from the issue text and it falls straight out of #259's design. When *every* requested zone is
held, #259 opens **no run row at all** — its "a run which never happened leaves no history" rule — so
there is nothing for an in-run retry to retry *under*. The waiting therefore has to happen at
**admission** as well as inside the run. Both are bounded by one deadline measured from the original
fire time, and the admission loop preserves #259's rule exactly: while everything is held, still
nothing is written. The spec pins that with a probe that asserts zero run rows *while the run is
waiting*.

**Late admission is an UPDATE, not a second INSERT.** `@@unique([runId, zoneId])` gives a run exactly
one row per zone, so a zone recovered late has to have its CONTENDED row **promoted in place**. That is
also the better record: the zone's whole story — refused at 05:00:00, dispatched at 05:03 — lives on
one row.

**`contended_with_run_id` is deliberately not cleared on promotion.** This run genuinely was refused
this zone, and who by is the only surviving trace of the collision. Every reader (transparency query,
admin run detail) discriminates on `status`, never on this column being non-null, so carrying it
forward onto a DONE row costs nothing and keeps history that would otherwise be destroyed. A test
fails if it is nulled.

**`NOT EXISTS` is the ordinary path; the partial unique is the backstop.** Two runs promoting the same
zone in the same instant is a real if narrow race, and it surfaces as a P2002 which is **safe to catch
here** — unlike #265's, this is a single statement with no interactive transaction to abort.

**Both loops reap before re-asking.** Without it a patient run would spend its entire deadline waiting
behind a claim nobody is holding, then give up — exactly the risk #260's own issue names, and the
reason #261 was made its hard prerequisite. And the run **beats while it waits**: a patient run that
stopped reporting would be reaped by its own reaper.

**Run status is measured against the zones still held when the run finished**, not against those held
at admission. A run that waited out every collision is a plain SUCCESS; reporting PARTIAL would surface
something the system absorbed as something the operator has to interpret.

**The policy lives on the scheduler's config, not in the environment at the point of use.** `#182 R5`
says a spec that needs a different value passes it through the service's own config-override
constructor param and never by setting an env var — which only works if the tick *owns* the policy and
hands it down. `deadlineMs: 0` disables patience entirely; that is the issue's stated rollback, so it
is a supported configuration and the parser guards it with `>= 0` rather than `> 0` so it survives the
fallback that rescues garbage.

## An enabling refactor came first

`execute`'s zone-loop body became `processZone`, over a named `RunTotals` accumulator. The retry pass
gave that loop a **second caller**, and two copies of ten `+=` lines would have drifted the first time
a column was added — while the invariant those columns exist to hold (a run's totals equal the sum of
its per-zone cards) is exactly the kind of thing drift breaks silently. Landed test-green and separate
from the behaviour change; 34 tests across five dispatch specs confirmed it behaviour-preserving before
a line of #260 was written.

## A pre-existing gap this found

**`DISPATCH_` was missing from `test/setup-env.ts`'s allowlist prefixes.** #261 introduced
`DISPATCH_STALE_RUN_MIN` and #260 adds two more, and none of them were being neutralised — so a
developer's own `.env` would reach the suite and change outcomes. That is the precise class of bug
#182 inverted that list to close ("the *next* flag anyone adds reaches the suite unmodified"), and it
is load-bearing for tests rather than only for production: a raised stale threshold makes the reaper
specs' hour-old fixtures no longer stale, and a leaked retry deadline makes every contended-zone
assertion wait minutes for an answer it expects at once. Prefix added, both vars pinned in
`setup-env-allowlist.spec.ts`.

## One sibling test re-pointed

`dispatch-in-flight-guard.e2e-spec.ts`'s *"a manual run in flight makes the cron tick skip rather than
start a second run"* began timing out, because the tick is now patient — it waits instead of skipping.
That test pins the **guard** (a second run is never started over a first), not the patience, so it runs
with `deadlineMs: 0` and asserts exactly what it always did. The patient behaviour has its own spec.
Two `dispatch-scheduler.e2e-spec.ts` config pins were updated for the grown config shape.

## Sensitivity

| Break | Test that caught it |
|---|---|
| in-run promotion removed | `promotes a CONTENDED zone in place` → outcome CONTENDED, not DONE |
| admission patience removed | `waits for the only zone it wants` → CONFLICT, not RAN |
| MANUAL made patient too | `never makes a MANUAL run wait` → 9755 ms against a 400 ms bound |
| promotion clears `contended_with_run_id` | `promotes a CONTENDED zone in place` → undefined, not the holder's id |

## Tests

Backend **403 files / 1999 passed / 5 skipped / 0 failed**, all four chunks exit 0 with **no**
crash-retries. No admin change — the ledger already shows the outcome, as the issue says.

## What this deliberately does NOT do

- **No settings-registry knob.** #213 moved the dispatch *hour* into `system_settings` because it is a
  business decision an operator owns. How long the run is willing to wait for a lock is an
  implementation detail of how it copes with itself, so it stays env-configured.
- **The reap sweep still does not dispatch.** Freeing a zone and running it are different jobs; the
  patient run is the thing that dispatches a recovered zone, and it does so under its own run row.
