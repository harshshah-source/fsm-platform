# 305 — The dispatch heartbeat beats inside the zone loop
Status: **done** (2026-09-02) — report [`docs/progress/305-dispatch-heartbeat-inside-zone-loop.md`](../../../docs/progress/305-dispatch-heartbeat-inside-zone-loop.md). An optional `onProgress` on both long phases: `dispatchForZone` beats once per SE (strictly between transactions, never inside one) and `runForZone` every 50 tickets. `DISPATCH_STALE_RUN_MIN` untouched, and the beat write is still the guarded `updateMany` on `status: 'RUNNING'`, so a reaped run cannot beat itself back to life.
Type: AFK
Wave: 2 · Severity: P2 · Finding: RC-5, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## Problem

A single zone whose recommend+dispatch takes longer than `DISPATCH_STALE_RUN_MIN` (10 min) of
silence gets its **live** run marked ABORTED by the reaper, its claim freed, and a recovery mark
written — so the #286 collector can start a second dispatch of a zone whose first is still
writing, and the ledger records ABORTED for a run that completed. Assignment-level guards prevent
double *assignment*, but two runs interleave and the run history lies. Risk grows with zone size —
exactly when it matters (compounded by the per-ticket candidate fan-out, AR-11/#330).

## Root cause

The heartbeat is stamped at admission, after every zone, and per patience iteration
(`dispatch-run.service.ts:1104-1107`, `:1010-1012`) — never **during** a zone's work, so a run's
silence is bounded by its slowest single zone, and a big zone exceeds the bound while healthy.
The code already logs the anomaly (`finalized === 0` at `:953-955`) without preventing it.

## Affected files / symbols

- `apps/backend/src/scheduling/dispatch-run.service.ts` — heartbeat plumbing into `processZone`
- `apps/backend/src/scheduling/batch-assignment.service.ts` — beat per SE inside `dispatchForZone`
- Possibly `recommender.service.ts` — a beat callback per N tickets if recommendation dominates

## Intended behavior after fix

The run beats at a granularity bounded by per-SE work (dispatch) and per-N-tickets
(recommendation), so a live run's silence can never exceed the reap threshold under any zone
size. `#261`'s invariant "the beat is the reaper's precondition" then holds as designed.

## Implementation boundaries

- Do not raise `DISPATCH_STALE_RUN_MIN` as the fix (a bigger blind window is not a beat), and do
  not change the reap ≤ retry-deadline invariant (`dispatch-cron.ts:167-186`).
- The beat is a cheap guarded UPDATE outside the per-SE transaction — never inside it (a beat
  must not extend or join a data transaction).

## DB / API / frontend impact

None (write frequency on an existing column only).

## Dependencies

Sequence with #303/#304/#307 (same files). Independent otherwise; AR-11 (#330) reduces the
window but does not replace the beat.

## Regression risks

- Beat writes must stay `updateMany` guarded on `status: 'RUNNING'` (a reaped run must not
  resurrect itself by beating — the #261 rule).
- Frequency: per-SE/per-100-tickets, not per-row — no measurable overhead.

## Tests required

- Simulated slow zone (injected delay) with a short stale threshold: run is NOT reaped while
  alive; finishes SUCCESS; no recovery mark written.
- Pin: a genuinely dead run (no beats) is still reaped exactly as today
  (`dispatch-run-reaper` suite green).
- Pin: a beat after reaping does not flip ABORTED back (guarded write asserted).

## Acceptance criteria

- [x] AC1 — a live run's heartbeat silence is bounded by per-SE work, independent of zone size.
      Asserted by sampling `heartbeat_at` from inside both phases: it moves DURING the zone, where before
      every sample equalled the admission beat.
- [x] AC2 — no live run can be reaped, and no second dispatch of a zone can start while its
      first is alive. Staged by ageing the beat past the threshold mid-zone, beating, then running the
      real reaper from inside the zone: it reaps nothing, the run finalizes SUCCESS, and no recovery
      mark is written — so the #286 collector is never invited to start a second dispatch.
- [x] AC3 — dead-run reaping latency is unchanged. A run that stops beating is still reaped on the
      same threshold, and a late beat cannot flip ABORTED back (#261's guarded write, asserted).

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

— (sequence with 303/304/307 on shared files)
