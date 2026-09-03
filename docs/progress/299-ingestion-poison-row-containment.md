# #299 — Row-level poison containment in snapshot ingestion (TDD completion report)

**Date:** 2026-09-02 · **Branch:** `feat/autoplant-integration` · **Type:** AFK · Backend
**Issue:** [`.scratch/fsm-platform-v1/issues/299-ingestion-poison-row-containment.md`](../../.scratch/fsm-platform-v1/issues/299-ingestion-poison-row-containment.md)
**Findings:** AR-1 + AR-2, `audit/2026-09-01-scheduler-engine-forensics.md` §7 · Wave 1 / P1.
**Activation blocker cleared:** this was the slice that had to land before `INGESTION_SCHEDULER_ENABLED`
is turned on in production.

> Frozen once written, per the progress convention. Corrections go to INDEX / SYSTEM-STATE.

## What was wrong

Two independent single-row failure modes each froze the **whole** pipeline, indefinitely.

**AR-1 (parse).** `normalizeGpsTimestamp` throws on a wall clock that does not match the naive-timestamp
grammar. `mapVehicleMasterRow` called it with no catch, the reader's row loop had none either, so the
throw escaped `readChunk` — where the worker reads any throw as a *source read* failure and stops
draining. The scan is deterministic (`ORDER BY device_id`, restarted from `cursor = null` every run,
no telemetry watermark), so this was not a transient: every device sorting after the bad row was never
ingested again, in that run or any future one, until somebody edited the source by hand.

**AR-2 (insert).** Nothing validated a coerced value against the column it was bound for, and
`createMany` is atomic per chunk. One `mains_status` of 99999 going into a SmallInt failed its whole
90-row chunk, deterministically, through all three retries, every 30 minutes, for ever.

Either way the run finalised PARTIAL/FAILED, and the #230 gate (`ingestComplete = snapshotStatus ===
'SUCCESS'`) correctly refused to run device-state derivation, auto-recovery and ticket creation —
**fleet-wide, on every tick**. The gate is right; freeze beats fabrication, which is the run-153 lesson.
The blast radius of one source row is the defect.

## Root cause verified against the tree

Confirmed before editing: `mapping.ts` calls `normalizeSourceRow` bare; `normalize.ts` throws;
`autoplant-source-reader.ts`'s `for` loop has no per-row guard; `snapshot-ingestion.worker.ts` treats the
escape as `readError` and breaks the drain. Column bounds read from `schema.prisma`
(`mains_status`/`csq` SmallInt, `mains_voltage`/`speed` Decimal(12,2)). One thing the issue did not
mention and the tree does: **`speed` reached its Decimal column through no coercer at all** —
`lat`/`lon`/`speed` were assigned straight from the MySQL row, so they never passed through
`coerceNumeric` the way the `gpssignal` fields did.

## The one deviation from the issue text, and why

#299 says an out-of-range value "rejects **that row**". Raised before writing code, and **ruled by the
operator on 2026-09-02: null the field, keep the row, count it.** Two reasons.

*Internal consistency.* `mapping.ts` already degrades a **malformed** value in those same columns to
null and keeps the row — `coerceMainsStatus('abc')`, `coerceNumeric`, `parseTripCreation` all do exactly
that. Rejecting the row for an **out-of-range** value would have made one column behave two different
ways depending on whether its garbage happened to be numeric.

*Operational.* The load-bearing content of the row is the device id and the ping instant. Dropping it
over a nonsense voltage makes a live device look dark, which climbs `inactivity_hours` and manufactures
a Troubleshoot Ticket for a device that is fine — the platform reporting a fault it invented. A nulled
field costs one reading, and is counted.

Row **rejection** therefore survives only where the row cannot exist without the value: the GPS instant
(AR-1), plus the two pre-existing skew arms.

## What was built

**`mapping.ts`** — the containment layer.

- `RowRejectionReason` gains `UNPARSEABLE_TIMESTAMP`; `normalizeSourceRow` is called inside a
  `try/catch` that reports and returns null. The throw in `normalize.ts` is untouched, per the issue's
  boundary: it is the correct contract for one row, and containment belongs in the caller.
- New `FieldRepairReason` (`RANGE_LAT`, `RANGE_LON`, `RANGE_SPEED`, `RANGE_MAINS_STATUS`,
  `RANGE_MAINS_VOLTAGE`, `RANGE_CSQ`) and a `withinOrNull` helper, applied to every value bound for a
  constrained column, with the column's real bounds (`SMALLINT_MIN/MAX`, `DECIMAL_12_2_LIMIT = 10^10`
  — precision 12 scale 2 leaves ten integer digits; scale is deliberately *not* enforced because
  Postgres rounds excess decimals rather than erroring).
- `lat`/`lon`/`speed` now go through `coerceNumeric` before the bound check, closing the unguarded
  `speed` path and removing NaN/Infinity before they reach a comparison.
- `csq` is guarded although `ap_widgets` gives it no source and it is null by construction, so the
  guarded set matches the *column* set rather than today's accident of which columns carry values.
- New `MapOptions.onRepair`, separate from `onReject`.

**`autoplant-source-reader.ts`** — tallies `repaired` beside `rejected`, records the first device id per
reason so the WARN is chaseable against the source, and splits the log line in two.

**`source-reader.ts`** — `SourceChunk.repaired?: Record<string, number>`, optional and additive.

**`snapshot-ingestion.worker.ts`** — accumulates both tallies across the run onto `SnapshotRunResult`
(`rejected`, `repaired`, always present, `{}` when clean so an alert need not null-guard the happy
path). No schema change; #300 owns the operator-facing surface.

**Two counters, not one.** A rejection is a hole in the fleet's telemetry — that device has no ping this
run. A repair is a data-quality fact about a device that reported perfectly well and had one unusable
reading. Summing them yields a number that answers neither question, and #300 must alert on them
differently.

## Tests — 24 new across three specs, red before green

`test/autoplant-mapping.spec.ts` (+13): four unparseable shapes each asserted **not to throw** and to
return null (the throw is the defect, so the absence of it is the assertion); the reason and device id
reported; per-column range cases each asserting the field is null *and* the ping survives; boundary
values (`-90`, `180`, `-32768`) kept; absent readings not counted as repairs; numeric strings coerced;
and a repair explicitly not appearing on the rejection channel.

`test/autoplant-source-reader.spec.ts` (+6): the containment over a real chunk — one poison row costs
its own row and nothing else; **the AR-1 replay**, where the identical next run reads straight past the
same row (this is the whole of AR-1: the failure was deterministic, so the fix has to be too); 89 of 90
rows surviving at the chunk size the issue measured, asserting *which* row is missing rather than only
the count; and a chunk carrying both kinds of damage reporting two separate tallies.

`test/snapshot-worker.e2e-spec.ts` (+4): **AC3** — all chunks SUCCESS with rows rejected finalises
SUCCESS, which is what opens the #230 gate, and `data_as_of` still advances; **AC2** — reasons totalled
across chunks with the two channels kept apart; empty tallies on a clean run; and **AC4** — a genuine
chunk-write failure still retries three times, records the chunk FAILED and pulls the run to PARTIAL,
proving containment did not swallow real failures.

Each half of the fix was reverted independently to confirm the tests fail without it: removing the
AR-1 catch → 8 failed / 45 passed; neutralising the AR-2 range guard → 8 failed / 45 passed.

## Verification

- Backend `tsc --noEmit`: clean.
- #299 specs: `autoplant-mapping` 38/38, `autoplant-source-reader` 15/15, `snapshot-worker` 12/12,
  `normalize` 6/6 — 71 green.
- Ingestion affected-surface sweep, 14 specs / 86 tests green (config, health, master mapping/source/
  pagination, mysql timeout, ingest-chunk, ingestion-schema, partial-cursor, run-lifecycle,
  snapshots-api, and the three dual-write specs).
- The #230 gate's own specs, 3 specs / 27 tests green (`integration-sync-tickets`,
  `device-state-recompute`, `business-sweep-scheduler`) — the gate is untouched and still behaves.
- Full backend suite: see the INDEX session-log row for this date.

## Deliberate omissions

- `normalize.ts` unchanged, per the issue's boundary.
- No resume cursor and no change to the scan shape.
- No schema change and no persisted rejection counters — the tallies ride `SnapshotRunResult`, and
  #300 owns turning them into an operator-facing signal. A run's rejections are therefore visible in
  logs and to a caller, but are **not** queryable after the fact; that is #300's call to make, not a
  gap this slice closed silently.
- `port_no` (Int) and `ip_address` (Inet) are null by construction from this source and are not
  guarded — noted in the code beside `csq`, which is guarded as the pattern for whoever gives one of
  them a source.
- The guard lives in the AutoPlant mapping, per the issue's named files. A second `SourceReader` would
  need its own; today AutoPlant is the only production reader and `InMemorySourceReader` is a fixture.
