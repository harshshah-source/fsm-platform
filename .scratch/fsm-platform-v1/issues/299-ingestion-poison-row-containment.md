# 299 — Row-level poison containment in snapshot ingestion
Status: **done** (2026-09-02) — report [`docs/progress/299-ingestion-poison-row-containment.md`](../../../docs/progress/299-ingestion-poison-row-containment.md). **Activation blocker cleared.** One deviation, operator-ruled 2026-09-02: an out-of-range value nulls its FIELD and keeps the row (counted) rather than rejecting the row — the file already degrades a malformed value in the same columns that way, and dropping a live device over a bad voltage reading manufactures a Troubleshoot Ticket. Row rejection is kept for the GPS instant (AR-1), which the row cannot exist without.
Type: AFK
Wave: 1 · Severity: P1 · Findings: AR-1 + AR-2, `audit/2026-09-01-scheduler-engine-forensics.md` §7
**Activation blocker: land before `INGESTION_SCHEDULER_ENABLED` is turned on in production.**

## Problem

Two independent poison-row modes each freeze the whole pipeline indefinitely:

1. **AR-1 (parse):** one source row with an unparseable `latest_gps_datetime` kills every future
   scan at the same row. The keyset scan is deterministic (`ORDER BY device_id`, restarted from
   `cursor = null` every run), so all devices sorting after it are never ingested again.
2. **AR-2 (insert):** one out-of-range value (e.g. `mains_status` 99999 into SmallInt) fails its
   whole 90-row chunk atomically, deterministically, through all 3 retries — every 30 minutes,
   forever.

Either way the run finalizes PARTIAL/FAILED and the #230 gate
(`integration-sync.service.ts:143`) skips recompute, auto-recovery and ticket creation
**fleet-wide, every tick**, until the source row is hand-fixed. The #230 gate is correct
(freeze beats fabrication — the run-153 lesson); the blast radius of one row is the defect.

## Root cause

- `mapping.ts:238` calls `normalizeSourceRow` with no per-row catch; `normalize.ts:46-48` throws
  on an unparseable timestamp; the reader (`autoplant-source-reader.ts:109-117`) doesn't catch
  either; the worker treats it as a read error (`snapshot-ingestion.worker.ts:107-109`) and stops
  draining.
- No range validation exists between coercion and insert: `coerceMainsStatus` (`mapping.ts:125-135`)
  returns any integer; `lat`/`lon` unvalidated; `createMany` is atomic per chunk.

## Affected files / symbols

- `apps/backend/src/ingestion/autoplant/mapping.ts` — `mapVehicleMasterRow`, `coerceMainsStatus`,
  `coerceNumeric`
- `apps/backend/src/ingestion/autoplant/autoplant-source-reader.ts` — per-row mapping loop
- `apps/backend/src/ingestion/normalize.ts` — read-only (the throw stays; the *caller* contains it)
- `apps/backend/src/ingestion/snapshot-ingestion.worker.ts` — rejected-row accounting only

## Intended behavior after fix

- A row whose GPS timestamp cannot be parsed is **rejected and counted** (`SourceChunk.rejected`,
  the same channel the #222 skew guard already uses) — the scan continues past it. Same posture
  `parseTripCreation`/`parseInstalledAt` already take for their fields.
- Every value bound for a constrained column is range-validated at mapping time (SmallInt bounds
  for `mains_status`/`csq`, Decimal(12,2) bounds, lat ∈ [-90,90], lon ∈ [-180,180]); an
  out-of-range value rejects **that row**, counted with a reason, never the chunk.
- Rejection reasons are distinguishable in logs/counters (parse vs range vs skew), so #300 can
  surface them.

## Implementation boundaries

- Do NOT weaken the #230 gate, the skew guard, or chunk atomicity for *unexpected* DB errors —
  a chunk that fails for a non-row reason (connection loss) must still retry/finalize as today.
- Do NOT add a resume cursor or change the scan shape.
- The throw in `normalize.ts` stays (it is the correct contract for a single row); containment
  lives in the mapping/reader layer.

## DB / API / frontend impact

DB: none. API: none. Ingestion run counters gain rejected-row reasons (additive).

## Dependencies

None upstream. #300 (alert surfacing) builds on the counters this slice writes. Wave-4 #323
(zero-date floor, NULLISH unify) touches the same file — sequence after this.

## Regression risks

- Over-eager rejection silently dropping good rows: every rejection must be counted and logged
  with device id + reason; the two-directional skew guard's bounds are the model.
- The #230 gate's semantics must be preserved: a run with only row-level rejections and all
  chunks SUCCESS finalizes SUCCESS (rejections are data-quality facts, not run failures).

## Tests required

- Reader/mapping spec: a chunk containing one unparseable-timestamp row ingests the other 89 and
  counts 1 rejected; the **next** run proceeds past the same row (the AR-1 replay).
- Range spec per guarded column: out-of-range value → row rejected, chunk SUCCESS, run SUCCESS.
- Regression: unexpected DB error (simulated) still fails the chunk and retries — containment did
  not swallow real failures.
- Pin: a run that is all-SUCCESS-with-rejections triggers the downstream stages (gate untouched).

## Acceptance criteria

- [x] AC1 — a single poison row (either mode) never prevents any other device's ingestion in the
      same or any later run.
- [x] AC2 — every rejected row is counted with a reason; nothing is silently dropped.
- [x] AC3 — downstream stages run on ticks where all chunks succeeded, rejections notwithstanding.
- [x] AC4 — a non-row chunk failure still retries and finalizes PARTIAL/FAILED exactly as today.

## UI surfaces

n/a (backend; the operator-facing half is #300).

## Reference

n/a.

## Blocked by

— (independent; blocks #300's usefulness, sequenced before #323)
