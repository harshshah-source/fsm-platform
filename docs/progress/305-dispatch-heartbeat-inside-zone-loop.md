# #305 — The dispatch heartbeat beats inside the zone loop

**Landed 2026-09-02** · branch `feat/autoplant-integration` · issue
[`.scratch/fsm-platform-v1/issues/305-dispatch-heartbeat-inside-zone-loop.md`](../../.scratch/fsm-platform-v1/issues/305-dispatch-heartbeat-inside-zone-loop.md)
· finding RC-5, `audit/2026-09-01-scheduler-engine-forensics.md` §8

## What was wrong

#261 made the reaper judge a run by the freshness of its **beat** rather than by its age, precisely so
a legitimately long run could finish. But the beat was stamped at admission, after every zone, and per
patience iteration — never *during* a zone's work. So a run's silence was bounded by its slowest
single zone.

A zone whose recommend+dispatch outlasts `DISPATCH_STALE_RUN_MIN` (10 minutes) therefore had its
**live** run marked ABORTED, its claim freed, and a #286 recovery mark written — so the collector
could start a second dispatch of a zone whose first was still writing, and the run history recorded
ABORTED for a run that went on to complete. Assignment-level guards stop a double *assignment*, but
the two runs interleave and the ledger lies. The risk grows with zone size, which is exactly when it
matters.

## What was built

An optional `onProgress` callback on the two phases that scale:

- **`dispatchForZone` — once per SE.** The per-SE transaction is already the unit this loop is bounded
  by, so it is the right granularity. Called strictly **between** transactions and after each SE
  either way (a skipped SE still took time, so the run is just as alive): the issue's boundary forbids
  a beat inside a data transaction, and a beat inside one that later rolls back would not have
  happened at all.
- **`runForZone` — every 50 tickets.** Recommendation is the half that scales with ticket count (the
  per-ticket candidate fan-out, AR-11/#330), so per-zone granularity was never enough there either.
  Fifty keeps the silence at a small fraction of the threshold at the slowest measured per-ticket cost,
  at one indexed single-column UPDATE per fifty tickets.

`processZone` passes both the same `() => touchHeartbeat(runId)`.

What was **not** done, per the boundary: `DISPATCH_STALE_RUN_MIN` is untouched — a bigger blind window
is not a beat — and the reap ≤ retry-deadline invariant is unchanged. The beat write is still the
guarded `updateMany` on `status: 'RUNNING'`, so a reaped run cannot beat itself back to life (#261's
rule). Both callbacks are optional, so the preview path and every existing caller are unaffected and
pay nothing.

## Tests

`test/dispatch-heartbeat-in-zone.e2e-spec.ts` (new, 3). The subject is *when* the beat happens, so the
tests measure that directly rather than sleeping for ten minutes: stubbed phases sample the run's
`heartbeat_at` before and after calling the `onProgress` they are handed.

- **AC1** — the beat moves during both phases. Before this, every sample equalled the admission beat.
- **AC2** — the invariant, staged as the reaper's own predicate rather than as a moving column: age the
  beat past the threshold mid-zone, beat, then run the **real** `reapStaleDispatchRuns` from inside the
  zone. It reaps nothing, the run finalizes SUCCESS, and no recovery mark is written — so the collector
  is never invited to start a second dispatch of a zone still being written.
- **AC3** — a genuinely dead run is still reaped on the same threshold, and a late beat does not flip
  ABORTED back.

**Red before green**: removing the two `onProgress` arguments turns **2 of 3 red** (AC1 and AC2, the
defect itself); the dead-run pin stays green, which is the correct split.

## Validation

- Targeted: 3/3. Every dispatch- or recommender-touching spec run together: **162 files / 932 tests
  green**.
- One investigated non-issue: on the first pass of that batch,
  `dispatch-crashed-zone-recovery`'s "defers to whoever holds the zone" case failed. Isolated it is
  3×12/12 green in ~1.5 s of test time; it is green co-run with every spec this chain changed; and the
  same 162-file batch is green on re-run **with no code change in between**. This is the load
  sensitivity that file is already documented to have (it parks a real second DB connection and sleeps
  twice against vitest's 5 s default) — not a regression, and nothing was changed for it.
- `tsc --noEmit` clean.
- Full backend suite: recorded with the dispatch chain's combined run in
  [`INDEX.md`](../../.scratch/fsm-platform-v1/INDEX.md)'s session log.

## Follow-ups

None. AR-11/#330 (candidate-query memoisation) still narrows the window this widens tolerance for, but
it is a performance fix and does not replace the beat.
