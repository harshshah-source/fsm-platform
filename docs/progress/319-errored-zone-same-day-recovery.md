# #319 — A zone lost to a contained error gets the same day back as a crashed one

**Finding:** AR-13 (`audit/2026-09-01-scheduler-engine-forensics.md` §7) · **Wave 3** · P3
**Landed:** 2026-09-02 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/319-recovery-symmetry-contained-errors.md`](../../.scratch/fsm-platform-v1/issues/319-recovery-symmetry-contained-errors.md)

---

## What was wrong

Recovery pointed the wrong way round. #286 gave a zone lost to **process death** a mark in
`dispatch_zone_recoveries` and a bounded same-day re-dispatch, and deliberately scoped the marks to the
reaper. So:

- **kill the process** → the reaper marks the zone, the collector re-dispatches it, and the cockpit
  says so;
- **let a zone throw inside a live run** → `processZone` catches it, `finalizeZoneClaim` writes ERROR,
  and *nothing ever asks for that zone again until 05:00 tomorrow*;
- **let the run unwind with a claim still open** → `releaseStrandedClaims` frees the claim to ERROR,
  and the same silence.

The worse failure had the better recovery, and the two quiet cases are the ones an operator is least
likely to notice — there is no crashed process to find, and the run's own ledger row says it finished.

## What decides a mark now

**A claim finalizing ERROR.** Not the cause of it. Both losses end at the same `dispatch_run_zones` row
in the same state, so that state is the whole rule, and the two writers that can produce it gained the
mark:

| writer | the loss it represents |
|---|---|
| `processZone` | a contained per-zone throw, or a whole-zone `skipReason` |
| `releaseStrandedClaims` | a claim still RUNNING as the run unwinds |

`markZonesForRecovery` is reused **verbatim** — the issue's own boundary — so there is one row, one
attempt budget and one operating-day cutoff per (zone, day) however many ways the zone was lost today.
No new state member, no collector change, no migration.

Three things follow from stating the rule on the claim's own discriminator rather than on a subset:

- **A whole-zone `skipReason` is included, deliberately.** `LOCK_CONTENDED` is the only one reserved
  today and nothing currently sets it, but the zone did not dispatch whichever containment produced
  that — and putting the rule on `error !== null` means it cannot drift the next time a skip reason is
  added.
- **DONE zones are never marked.** A zone that dispatched is not owed a day.
- **CONTENDED zones are never marked, by construction rather than by a second predicate.** That row is
  written by `admit`, which neither of these two writers goes through, so #286's "busy is not broken"
  rule cannot be bent here by accident — a healthy zone can never be charged against a budget meant for
  broken ones.

**Both mark before freeing or finalizing**, which is the reaper's own ordering rule and worth restating:
if the process dies in the gap the claim is still RUNNING, so the next reap pass finds it and marks it.
The other order loses the zone's day to exactly the death the mark exists to survive.

`releaseStrandedClaims` also had to start *reading* — a blind `updateMany` cannot name the zones it is
freeing. On a clean run it matches nothing and costs one indexed read. It now takes the run's `now`
rather than using the wall clock, so a mark written while unwinding lands on the operating day the run
was dispatching.

## The interaction that needed checking, not assuming

The collector re-dispatches a marked zone by calling `runForActiveZones` — so **a failing recovery run
now re-marks the zone from inside the collector's own attempt.** Two writers on one row.

It holds because the mark write never touches `attempts`: it re-arms `state` to PENDING and stamps
`marked_at` / `marked_by_run_id` / `resolved_at`. The collector's accounting is guarded on
`{ id, state: 'PENDING', attempts: <the count this pass read> }` (#286's own #265-style predicate), and
that guard still matches, so the budget is spent exactly once per attempt and EXHAUSTED still lands on
the final one. The spec pins this directly rather than leaving it to inspection.

An `EXHAUSTED` or `EXPIRED` mark is still not re-armable — `markZonesForRecovery`'s second write is
scoped to `state IN (PENDING, RECOVERED)` — so an error arriving after the budget is spent cannot put
the zone back in the queue. That is the loop the budget exists to prevent, and it is reachable through
the new door too, so it is asserted through the new door.

## The UI half — coverage widened, so the copy had to

The issue records the cockpit recovery notice as "existing — coverage widens". It widened into copy
that had become false:

> "This zone's dispatch run **died** — a re-dispatch is queued"

True while only the reaper could mark a zone. For both new cases the run did **not** die: it finished
and reported the loss. An operator reading "died" would go hunting for a crashed process that never
existed. The headline now says the thing that is true of every marked zone — it **lost its dispatch
run** — and `last_error` continues to carry the specific reason whenever the collector has one. The
`TodayRecovery` docblock on the backend read says the same, so the two ends of the field agree about
what it means.

## Tests

`test/dispatch-errored-zone-recovery.e2e-spec.ts` (new, 8 cases), modelled on
`dispatch-crashed-zone-recovery`'s staging so the two read as a pair.

**Staging the unwind case.** The interesting injection is the second one: a run has to unwind with a
claim still RUNNING, which nothing in the service does on its own — `processZone` contains everything
it can. The spec proxies the client so the **successful** finalize throws once, keyed on
`data.status === 'DONE'` rather than on a call count, because the reaper and `releaseStrandedClaims`
write the same delegate with `status: 'ERROR'` and a counter would trip the wrong one.

**Red first, each case with its own signature:**

| case | before |
|---|---|
| a zone that throws inside a live run | no mark row at all |
| the collector then re-dispatches it | `{ attempted: 0, recovered: 0 }` — nothing to collect |
| a claim left open when the run unwinds | claim correctly freed to ERROR, **no mark** |
| exhausts on the shared budget | nothing to attempt |
| expires at the operating-day cutoff | nothing to expire |

Three cases were green before and after and are the controls that keep the rule narrow: a DONE zone is
never marked, a zone refused at admission is never marked, and the reaper and the error path produce
**one** row with its attempt count intact.

- **Full backend suite: 452 spec files, 2,414 tests passed, 5 skipped, zero failures**, five foreground
  batches, no `SUITE INCOMPLETE` and no #184 worker recovery. `dispatch-crashed-zone-recovery` — the
  documented load-sensitive flake and the file most exposed to this change — was green in the 40-file
  dispatch surface run and again in its batch.
- The **40-file regression surface** (every spec naming `DispatchRunService`, `recoverMarkedZones`,
  `reapStaleDispatchRuns`, `releaseStrandedClaims`, `dispatchRunZone` or `dispatchZoneRecovery`): 229
  tests, all green.
- **Admin: 119 files / 830 tests passed**, `tsc --noEmit` clean in both apps. The one reported error is
  the pre-existing #292 unhandled rejection in `ticket-drawer-tabs`, documented in INDEX since
  2026-08-31 and untouched here.

## What this does not do

- **It does not make the collector smarter about deterministic failures.** A zone that fails the same
  way every time now burns its three attempts and ends EXHAUSTED with the reason on the mark. The issue
  names that as acceptable and bounded by design, and the cockpit's warning-weighted EXHAUSTED state is
  where a human is supposed to pick it up.
- **It records no cause on the mark.** `dispatch_zone_recoveries` gains no column, so nothing
  distinguishes a crash from a contained error at the row level — which is why the cockpit copy stopped
  naming one. If that distinction is ever wanted operationally it is a schema change and its own issue.
