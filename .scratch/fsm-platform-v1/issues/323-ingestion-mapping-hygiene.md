# 323 — Ingestion mapping hygiene: zero-date floor + one NULLISH vocabulary
Status: done (2026-09-03) - see `docs/progress/323-ingestion-mapping-hygiene.md`
Type: AFK
Wave: 4 · Severity: P3 · Findings: CB-11 + AR-9c,
`audit/2026-09-01-scheduler-engine-forensics.md` §6/§7

## Problem
1. **CB-11:** `parseTripCreation` (`mapping.ts:170-177`) has no plausibility floor — MySQL
   `"0000-00-00 00:00:00"` lands as ~1899-11-30 in `device_states.trip_creation_datetime` for
   devices whose only stamp is the sentinel (both siblings have floors: `MIN_PLAUSIBLE_GPS_MS`,
   `MIN_PLAUSIBLE_INSTALL_MS`).
2. **AR-9c:** two `NULLISH` sets for one source — `mapping.ts:120` ({'', 'NULL', 'null'}) vs
   `master-mapping.ts:34` (adds 'NA'). A literal `'NA'` device id passes the snapshot path but is
   never mastered: permanently in `unknownDevices`, its telemetry unreachable, warned every chunk.

## Root cause
Copy drift between the two mapping files.

## Affected files / symbols
`apps/backend/src/ingestion/autoplant/mapping.ts`, `master-mapping.ts` (one shared NULLISH +
the trip floor).

## Intended behavior after fix
`parseTripCreation` folds sub-floor values to null (the `parseInstalledAt` posture); one NULLISH
set defined once and imported by both paths ('NA' included, matching the masters path — the
stricter reading).

## Implementation boundaries
Mapping layer only; no watermark/upsert changes; no backfill of already-stored 1899 values in
this slice (count them in the issue when landing; a cleanup is a follow-up decision).

## DB / API / frontend impact
None structural; future ingests stop producing the bad values.

## Dependencies
After #299 (same files — sequence only).

## Regression risks
Widening NULLISH on the snapshot path drops 'NA'-id rows it used to journal — that is the fix;
count them via the rejected/unknown counters so the change is visible.

## Tests required
Unit: zero-date → null; 'NA' device id → same disposition on both paths; existing
`autoplant-mapping.spec` green.

## Acceptance criteria
- [x] AC1 — no path can store a pre-floor trip timestamp.
- [x] AC2 — one NULLISH definition; a literal 'NA' behaves identically on both paths.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
299 (file sequence)
