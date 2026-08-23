# #261 — Heartbeat, reaper and conditional finish (dispatch + ingestion; folds #132)

**Landed** 2026-08-23 · branch `feat/autoplant-integration` · TDD via `/tdd`
**Issue:** [`.scratch/fsm-platform-v1/issues/261-dispatch-run-heartbeat-reaper.md`](../../.scratch/fsm-platform-v1/issues/261-dispatch-run-heartbeat-reaper.md)
**Commits:** `cf6f9de` (ingestion half) · `5a044ee` (dispatch half)
**Closes the defect half of #132.**

---

## What changed, in one paragraph

#259 made dispatch admission a row, which is what made a refusal durable across processes — and
durability cuts both ways. `releaseStrandedClaims` finalizes the claims of a run that *unwinds*; a
process that **dies** unwinds nothing, and the RUNNING `dispatch_run_zones` row it leaves behind
refuses that zone to every future run for the rest of the database's life, with no code path anywhere
that would ever close it. `dispatch_runs.heartbeat_at` plus a new `ABORTED` status plus
`reapStaleDispatchRuns` are what close it. The same two corrections were owed to the ingestion
ledgers, where #97's reaper judged staleness from `started_at` alone and `finishRun` was an
unconditional update — that pair is #132's actual defect and is fixed here too.

## Acceptance criteria

All four met.

| AC | Where | Note |
|---|---|---|
| 1 · kill mid-run → next admission reaps, run ABORTED, claim freed, new run dispatches; leftover SUGGESTED re-evaluated, not double-dispatched (G1 on ticket rows) | `dispatch-run-reaper.e2e-spec.ts` → `reaps a dead run at the next admission…`; `dispatch-zone-wedge.e2e-spec.ts` → `#261: an ABORTED run's orphan is cleared…` | G1 asserted on `batch_assignment_tickets` rows, not on the count the run reported |
| 2 · a reaped run's late `finalize` is a no-op; status stays ABORTED | `dispatch-run-reaper.e2e-spec.ts` → `a reaped run's late finalize is a no-op…` | Staged by parking a real run inside the recommender and reaping it from outside while genuinely mid-flight |
| 3 · slow-but-alive (fresh beat, old wall clock) is NOT reaped | `dispatch-run-reaper.e2e-spec.ts` → `leaves a slow-but-alive run alone…` | Also asserts the live run *still holds* the zone — a reaper that freed it would just move the double-dispatch to the next admission |
| 4 · ingestion: the same three assertions against `snapshot_runs` (closes #132's evidence) | `stale-run-reaper.e2e-spec.ts` (13 tests) | Staged across both ledgers, because one RUNNING row per table is all the in-flight guard index permits |

Beyond the ACs: the per-stage beat is pinned on both pipelines
(`snapshot-worker.e2e-spec.ts` → `beats once per chunk…`, `master-sync-service.e2e-spec.ts` →
`beats through the sync…`), the sweep tick in `dispatch-scheduler.e2e-spec.ts`, and the ABORTED
transparency passthrough in the reaper spec.

## Design decisions

**Liveness had to stop being wall-clock age *before* a reaper was safe to add at all.** This is the
load-bearing decision and it is easy to get backwards. A dispatch run walks every active zone and is
legitimately long; an age-keyed reaper eventually frees the zones of a **live** run and lets a second
run in on top of it — two runs writing the same day plans. That failure is strictly worse than the
wedge being fixed, so the beat is not a refinement of the reaper, it is its precondition. Beating
after every zone bounds a run's silence by its slowest single zone rather than by its total length.

**`ABORTED` is a new status, not a reuse of `FAILED`.** FAILED is a statement about the *work* — every
zone tried, every zone failed. ABORTED says nobody knows what the run did, because whoever was running
it stopped existing. Collapsing them would make "the dispatcher is broken" and "the box was restarted"
the same row on the transparency list, and those two demand different responses from an operator.

**The reaper writes the run first and its claims second.** Dying between the two leaves RUNNING claims
under an ABORTED run — which the next pass finds and finishes. The reverse order leaves a RUNNING run
holding nothing, which reads as a live run doing no work and which no later pass corrects.

**Both finalizes became `updateMany` keyed on `status = 'RUNNING'`.** Without this the reaper *creates*
the zombie-resurrect defect on the dispatch side rather than fixing it: a reaped-but-alive run would
report SUCCESS over the top of a zone already handed to somebody else. The per-zone one still names its
primary key in the `where`; what the status predicate adds is that the row must still be *this run's to
close*. Same rule as #265's `liveScheduleFilter()`.

**Reaping at admission AND on a 3-minute sweep.** Admission-only covers a busy system completely and a
quiet one not at all: a claim abandoned at 05:02 would sit refusing until 05:00 tomorrow, clearing only
because somebody happened to ask. The sweep deliberately **does not dispatch** — #260 owns retrying a
contended zone, and a janitor that also ran the zones it freed would be an unscheduled dispatch run at
an arbitrary minute of the day.

**The sweep lives on `DispatchSchedulerService`, not `BusinessSweepSchedulerService`.** The issue says
"a slow business sweep tick"; that file's own comment says dispatch is deliberately kept out of it to
avoid threading an 11th collaborator through it. `DispatchSchedulerService` already holds the dispatch
cron and already takes `DispatchRunService`, so the tick costs no new wiring.

**Thresholds stated together, with the invariant they only make sense under.**
`DEFAULT_DISPATCH_STALE_RUN_MIN = 10` and `DEFAULT_DISPATCH_RETRY_DEADLINE_MIN = 15` both live in
`dispatch-cron.ts`: **reap ≤ retry deadline**, or a crashed holder starves #260's entire retry window.
The ingestion threshold stays separate at 30 min — an AutoPlant sync waits on a remote system, a
dispatch run does not.

**`heartbeat_at` is nullable with no default, on all three tables.** Every row written before the
column existed never beat, and the filter falls back to `started_at` for exactly those. A
`DEFAULT now()` would have silently re-dated them and narrowed the reaper to the empty set on precisely
the stranded population it was built to clean up. Each filter carries that fallback arm, and a test
fails when it is removed.

**Item 6 was verified, not assumed.** `clearFinalizedOrphans` keys on `not: 'RUNNING'`, so an aborted
run's SUGGESTED recs are already collected. That holds *only* because the predicate is a negation —
rewritten as an allow-list of terminal statuses (a plausible refactor) the orphans become immortal and
wedge the zone exactly the way Issue 126 describes. The test fails when made one.

## Three sibling tests were re-aimed, not merely repaired

The per-zone finalize changed from `dispatchRunZone.update` to `updateMany`. **Three** tests broke the
old writer *by name*:

- `dispatch-zone-claim-admission.e2e-spec.ts` — #259's wedge
- `dispatch-in-flight-guard.e2e-spec.ts` — #213's wedge
- `dispatch-run-containment.spec.ts` — #113's hand-built fake Prisma

Left pointing at a method the code no longer calls, each would have passed forever while proving
nothing. This is the same drift the handoff recorded reaching #213's wedge test during #259 — found
three more times here, from one signature change. **The two wedges cannot simply break `updateMany`**,
because `releaseStrandedClaims` — the release they exist to prove — now uses it too; they discriminate
on the argument that separates them (the finalize names a `zoneId`, the release does not). Both were
re-verified by deleting the release and watching them go red.

`scheduler-wiring.e2e-spec.ts`'s exact cron-name set went 18 → 19. That guard did its job.

## Sensitivity

Nine assertions here were green on arrival; every one had its sensitivity proven by deliberate
breakage, with the red recorded:

| Break | Test that caught it |
|---|---|
| liveness keyed on `started_at` (the pre-#261 rule) | `leaves a slow-but-alive run alone` → reaped 1/1 |
| the NULL-beat fallback arm removed | `still reaps a run that never beat at all` → reaped 0/0 |
| the per-zone beat deleted | `beats after every zone it finishes` → beat == startedAt |
| one master-sync stage beat deleted | `beats through the sync` → 6 became 5 |
| `clearFinalizedOrphans` made an allow-list | `an ABORTED run's orphan is cleared` → recommended 0, not 1 |
| `releaseStrandedClaims` deleted | both re-aimed wedges → CONFLICT / claim left RUNNING |

## Tests

Backend **402 files / 1994 passed / 5 skipped / 0 failed**, all four chunks exit 0 (two #184 crashes,
both auto-retried and recovered). Admin **104 files / 544 passed**. New/changed: `dispatch-run-reaper`
(6, new), `stale-run-reaper` (13), `snapshot-worker` (8), `master-sync-service` (5),
`dispatch-scheduler` (9), `dispatch-zone-wedge` (5), plus the three re-aimed siblings.

`npx tsc -p tsconfig.test.json --noEmit` leaves three errors, all pre-existing and outside every hunk
touched here: `snapshot-worker.e2e-spec.ts(52,9)` and `(205,49)` (PoisonWriter's `string` vs `bigint`)
and `master-sync-service.e2e-spec.ts(94,5)` (a fixture missing `imsi_no`). `makeWorker`'s parameter was
widened from `InMemorySourceReader` to `SourceReader` — the interface the worker actually takes, which
three tests in that file were already violating.

## What this deliberately does NOT do

- **It does not retry a contended zone.** #260 owns that, and the reap threshold is set against #260's
  deadline so a crashed holder cannot starve its window.
- **The admin surface is the status only.** ABORTED renders on the runs list and run detail with a
  `critical` tone; there is no reaper page, no "runs reaped today" figure. The follow-up the previous
  session filed — *the runs-list row has no zone outcome* — is untouched and still worth doing.
