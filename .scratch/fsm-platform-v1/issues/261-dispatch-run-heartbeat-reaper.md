# 261 — Dispatch-run heartbeat + reaper + conditional finish (and the same fix for the ingestion reaper)

Status: done (2026-08-23) — see `docs/progress/261-dispatch-run-heartbeat-reaper.md`
Type: AFK · Backend
Decision: #258 Q8.8 (G5, G6). Folds in the defect half of #132.

## Objective

A crashed or killed process can never leave a permanently-RUNNING dispatch run or a permanently-held
zone claim, and a reaped zombie can never resurrect itself by finishing unconditionally.

## Current behaviour

- `dispatch_runs` has **no reaper**: a row opened RUNNING (`dispatch-run.service.ts:227`) is closed
  only by the same in-process call (`:304`); process death = RUNNING forever. With #259, the zone
  claim row would be stuck RUNNING too (advisory locks self-release; ledger truth does not).
- The ingestion side has the house idiom but with the #132 flaw intact: liveness judged from
  `startedAt` alone (`snapshot-run.service.ts:34-41`) — a legitimately long run gets reaped — and
  `finishRun` is an unconditional update (`:86-90`) — the reaped zombie later overwrites FAILED with
  SUCCESS ("zombie resurrect").

## Required change

1. `dispatch_runs.heartbeat_at` — touched at run start and after every zone (with #262, after every
   SE batch); cheap single-column update outside any long transaction.
2. New `DispatchRunStatus` value `ABORTED`.
3. **Reaper**: `reapStaleDispatchRuns(now)` — RUNNING runs whose `heartbeat_at` is older than
   `DISPATCH_STALE_RUN_MIN` (default 10) → `status = ABORTED`, `finishedAt = now`, and their
   RUNNING zone-claim rows → `ERROR('ABANDONED')`, freeing admission. Invoked at every admission
   (the `snapshot-run.service.ts:44` pattern) **and** from a slow business sweep tick so an idle
   system still self-heals.
4. **Conditional finish**: the run finalize becomes `updateMany({where: {runId, status:'RUNNING'}})`;
   0 rows updated → log "finished after being reaped", do NOT overwrite. Same for zone rows.
5. Apply 1/4 to the ingestion `snapshot_runs`/master-sync ledgers: add heartbeat (touched per
   pipeline stage), reap on stale heartbeat not `startedAt`, make `finishRun` conditional. This IS
   #132's fix — do not copy the flawed pattern into dispatch and leave ingestion broken.
6. Recovery semantics after ABORTED (verify, don't assume): committed work stays (idempotent);
   leftover SUGGESTED recs of the aborted run are already collected by `clearFinalizedOrphans`
   (`recommender.service.ts:737-746` — ABORTED ≠ RUNNING, so they qualify). Assert this in a test.

## Existing code to reuse

`snapshot-run.service.ts` reaper shape (corrected); `stale-run.ts` env parsing; business-sweep
`runGuarded`; #259 claim rows.

## Data model

`dispatch_runs.heartbeat_at TIMESTAMPTZ NULL`; enum value `ABORTED`; `snapshot_runs.heartbeat_at`.
Index not required (RUNNING rows are few).

## API / UI surfaces

Transparency run list shows ABORTED (existing status rendering — verify enum passthrough). Mobile: n/a.

## Acceptance criteria

- [x] Kill mid-run (simulated: open run+claim, no process holding them): next admission reaps —
      run ABORTED, claim freed, new run admits and dispatches; remaining SUGGESTED from the aborted
      run are re-evaluated, not double-dispatched (G1 asserted on ticket rows).
- [x] A reaped run's late `finalize` is a no-op; status stays ABORTED (zombie-resurrect pinned dead).
- [x] A slow-but-alive run (heartbeat fresh, wall-clock old) is NOT reaped.
- [x] Ingestion: same three assertions against `snapshot_runs` (closes #132's evidence).

## Tests

e2e: reaper spec (dispatch), zombie-finish spec, heartbeat-liveness spec, ingestion-reaper update of
`stale-run-reaper.e2e-spec.ts`.

## Dependencies / Blocked by

#259 (claims to release). The ingestion half (item 5) is independent and may land first.

## Risks

Reap threshold vs. #260's retry deadline must be coherent (reap ≤ retry deadline, or a crashed
holder starves the cron's whole retry window). State both defaults in one place (`dispatch-cron.ts`).

## Rollback

Additive columns; reverting disables reaping, never corrupts.
