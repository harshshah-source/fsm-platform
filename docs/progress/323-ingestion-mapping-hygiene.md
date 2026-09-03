# #323 — One source, one sentinel vocabulary, one plausibility floor

**Findings:** CB-11 + AR-9c (`audit/2026-09-01-scheduler-engine-forensics.md` §6/§7) · **Wave 4** · P3
**Landed:** 2026-09-03 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/323-ingestion-mapping-hygiene.md`](../../.scratch/fsm-platform-v1/issues/323-ingestion-mapping-hygiene.md)

---

## What was wrong

Two mapping layers read the same MySQL tables written by the same application, and had drifted into
two answers about what that source means.

**CB-11 — one of three timestamp parsers had no plausibility floor.** `parseTripCreation` accepted
anything the naive-timestamp grammar accepted, and MySQL's `0000-00-00 00:00:00` satisfies it: for a
device whose only trip stamp is the sentinel, an instant near **1899-11-30** was written into
`device_states.trip_creation_datetime`. Its two siblings — `MIN_PLAUSIBLE_GPS_MS` on the ping and
`MIN_PLAUSIBLE_INSTALL_MS` on the fitment date — had the guard, with the same reasoning written out
twice. A plausible-looking date no reader can tell from a real one is strictly worse than the null it
should have been.

**AR-9c — two `NULLISH` sets.** `mapping.ts` had `{'', 'NULL', 'null'}`; `master-mapping.ts` added
`'NA'`. A literal `'NA'` device id therefore **passed** the snapshot path and was journalled, while the
masters path refused to create the device — so it sat in `unknownDevices` permanently, its telemetry
unreachable, and warned about on every chunk. Nothing an operator could do resolved it, because the two
halves of the pipeline disagreed about whether the row existed.

## The fix

`src/ingestion/autoplant/source-sentinels.ts` — one module holding what the *source* means, imported by
both mapping layers:

- `SOURCE_NULLISH` / `isSourceBlank` — `{'', 'NA', 'NULL', 'null'}`, matched whole and trimmed. The
  **stricter** reading wins, and the reason is directional rather than aesthetic: the masters path is
  the one that decides whether a device exists at all, so a telemetry row for a device that can never
  be created is not data worth keeping.
- `MIN_PLAUSIBLE_SOURCE_MS` — 2000-01-01 UTC. Both siblings keep their own names and their own
  docblocks at their own call sites (`MIN_PLAUSIBLE_GPS_MS`, `MIN_PLAUSIBLE_INSTALL_MS`); only the
  number stopped being copied, and `parseTripCreation` now folds below it exactly as `parseInstalledAt`
  does.

The floor is deliberately a **sentinel** guard and not a staleness guard. A device silent for a year is
not implausible data — it is the finding this platform exists to produce — so a floor tuned to fleet
percentiles would drop precisely the devices the system is meant to catch. AutoPlant's own fleet starts
in 2023, so 2000 leaves two decades of margin.

## The regression the issue predicted, made countable

Widening the snapshot path's sentinel set drops `'NA'`-id rows it used to journal. That is the fix, and
the issue asked that it be visible rather than silent. `RowRejectionReason` gains
**`SENTINEL_DEVICE_ID`**, counted through the reader's existing per-chunk tally and named in its WARN.

The discrimination matters: a **NULL or empty** device id is deliberately *not* reported. That is the
source's ordinary "vehicle with no fitted device" shape — tens of thousands of rows — and counting it
would bury every real signal in the same channel. Only a non-empty sentinel word is named, which also
retro-illuminates `'NULL'`/`'null'`, silently dropped here since the beginning.

## What the residue actually is: zero

The issue asked for the already-stored 1899 values to be counted when landing. New read-only probe
`scripts/probe-source-sentinels.cjs`, run against dev `fsm`:

| question | measured |
|---|---|
| `trip_creation_datetime` below the floor | **0** of 25,314 non-null |
| earliest stored trip stamp | 2024-01-04T20:13:41Z |
| devices whose id is a sentinel word | **none** |

So both defects are real in the code and have not yet produced a bad row in this database — 5,067 of
30,381 devices carry a null trip stamp, i.e. the source has been sending blanks (already caught by
`isBlank`) rather than zero-dates. **No cleanup is needed and no backfill decision is pending**, which
is a stronger answer than the issue's "count them and defer": there is nothing to defer.

That is a measurement of today, not a proof about tomorrow. The source can start sending zero-dates the
day a device's trip record is reset, which is exactly why the guard is worth having with zero rows
behind it.

## Verification

- `test/autoplant-mapping-hygiene.spec.ts` — 12 cases. Red first: `parseTripCreation` returned
  `1899-11-30T00:00:00.000Z`, and `mapVehicleMasterRow` returned a full row for `device_id: 'NA'`.
- Both existing mapping specs (`autoplant-mapping`, `autoplant-master-mapping`) green unchanged — the
  masters path's behaviour is identical, it just stopped owning its own copy of the definition.
- A case pins that the set is matched **whole**: `'NA'` is a sentinel, `'NA0123'` is a WheelsEye-style
  device id and survives.
- 48-file ingestion regression surface — 345/345.
- Full backend suite with #324: **456 files, 2,441 passed, 5 skipped, zero failures**, five batches,
  every batch exit 0 (one #184 worker-crash retry in batch 2, recovered clean).
- `npx tsc --noEmit` clean. No schema change, no migration.

## Acceptance criteria

- [x] **AC1** — no path can store a pre-floor trip timestamp.
- [x] **AC2** — one NULLISH definition; a literal `'NA'` behaves identically on both paths.

`UI surfaces: n/a`.
