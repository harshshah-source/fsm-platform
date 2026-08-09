# 226 — FSM holds NULL GPS for devices the source has telemetry for

Status: needs-triage
Type: AFK · Backend ingestion
Filed: 2026-08-07
Origin: `audit/cross-analysis.md` §2.1 — surfaced while verifying [#223](./223-ndd-counted-healthy.md)'s
NDD population against AutoPlant directly. **Not a state-modelling defect; a data-loss defect.**
Coordinates with: [#223](./223-ndd-counted-healthy.md) (these devices are inside its 913 and will be
mis-treated by its fix until this is resolved) · [#222](./222-telemetry-staleness.md)

## Problem

The 913 devices FSM holds as `latest_gps_datetime IS NULL` were taken to AutoPlant production and
checked one by one. **15 of them have telemetry at the source. 14 pinged within the last 24 hours.**

| Question asked of `ap_widgets.tb_vehiclemaster` for FSM's 913 null-GPS devices | Answer |
|---|---:|
| Rows found | 907 |
| `latest_gps_datetime IS NULL` at source — genuinely never reported | 892 |
| **`latest_gps_datetime IS NOT NULL` at source** | **15** |
| …of which pinged **within the last 24 h** | **14** |
| …carrying a `gpssignal` telemetry blob | 15 |

FSM stored NULL over a value that exists. This is not the NDD question — the source *has* the data
and FSM did not persist it.

## Why it matters

These 15 are **doubly misreported**: FSM has lost real telemetry, and then counts the loss as health
(via the [#223](./223-ndd-counted-healthy.md) defect). 14 of them are actively reporting vehicles
that FSM believes have never been heard from.

More importantly, **15 is the count we can see**. The measurement only covers devices whose FSM value
is NULL. A device whose FSM value is *stale but non-null* for the same underlying reason would not
appear in this count at all. **The true blast radius is unmeasured**, and that is the reason to
investigate rather than patch.

## Not yet diagnosed

Deliberately not chased — this issue is filed to preserve the finding, not to assert a cause.
Candidate mechanisms, unranked and untested:

- `mapVehicleMasterRow` returns `null` for the row (the `mapping.ts:168` skew guard, a blank/unparsable
  `latest_gps_datetime` string, or a `NULLISH` hit) and the null is persisted rather than skipped.
- The device was read in a chunk that failed and the run recorded partial success.
- The snapshot cursor skipped it (`snapshot_run_chunks` would show this).
- The row appeared in `tb_vehiclemaster` after the last snapshot pass — but 14 of 15 pinged within
  24 h and several runs have completed since, so this explains at most a few.

## First steps

1. Pull the 15 device ids and check `raw_device_snapshots` — did FSM ever ingest a row for them, and
   with what `gps_datetime`? That separates "never read" from "read and dropped".
2. Check `snapshot_run_chunks` for the chunks those device ids fall in across the last several runs.
3. Run the 15 raw source rows through `mapVehicleMasterRow` directly (pure function, no DB) and see
   whether any returns `null`. If one does, the guard is eating live data and that is the answer.
4. **Then** widen: count devices whose FSM `latest_gps_datetime` is more than one run-interval older
   than the source's, to size the non-null version of the same fault.

## Acceptance

- The mechanism named, with evidence, not inferred.
- The 15 either ingesting correctly or explicitly classified (e.g. genuinely unparsable at source).
- The **non-null** blast radius measured and reported, so we know whether this was 15 devices or a
  visible corner of something larger.
- If the cause is a guard silently dropping rows, it emits a counted, logged rejection rather than a
  silent `null` — see [#228](./228-guard-pattern-remediation.md).
