# 220 — AutoPlant hard-deletes `mst_vehicle` rows, with no tombstone

Status: needs-triage
Type: AFK · Domain documentation + integration risk
Filed: 2026-08-07
Origin: [#218](./218-lifecycle-drift-detection.md) root-cause work
(`audit/autoplant-reconciliation/FIX-PLAN.md` §0A)

## The behaviour

`ap_masters.mst_vehicle` is **not append-only**. Of the 6,767 devices FSM currently holds departed,
**1,153 (17.0%) are absent from `mst_vehicle` entirely** — not a status FSM fails to match, an absent
row. Checked exhaustively, not sampled.

Looking those devices up by `vehicle_no` instead of `device_id` (sample of 180):

| Mechanism | n | % |
|---|---:|---:|
| `vehicle_no` also gone — row hard-deleted | 142 | 78.9% |
| Vehicle exists, now carries a different `device_id` — device swapped/refitted | 38 | 21.1% |

**0 of 90 are still present in `ap_widgets.tb_vehiclemaster`** — they leave telemetry too, so this is
retirement from the estate, not a move.

## Why it matters

1. **FSM's mirror freezes.** `vehicles.status` is only written for rows the read returns, so a
   hard-deleted vehicle keeps its last-observed status forever. **1,066 devices currently read
   `DEPLOYED` in FSM for vehicles that no longer exist at source.** Any consumer trusting
   `vehicles.status` over the `device_departures` ledger will be wrong about them — the concrete case
   that **confirms the #130 three-tier status authority**.
2. **No tombstone means departure must be inferred**, which is exactly why #128's `ABSENT_FROM_READ`
   reason and absence-ratio guard exist. That design is correct; this issue does not propose changing
   it.
3. **A refitted vehicle orphans FSM's device row** while the replacement `device_id` is created
   separately — correct behaviour, but device-level history does not follow the vehicle.

## Judgement

This appears to be **normal behaviour for this source**, consistent with the 2026-07-17 investigation
which measured the same class at 3–7% ("when a device is unfitted/refitted its `device_id` can
disappear from the table entirely"). Filed for durability rather than as a defect: the finding
currently lives only in a reconciliation report, and the next person to meet a "vanished" device
should not have to rediscover it.

## Acceptance

- Recorded in `docs/autoplant/` as a documented source characteristic, with the two mechanisms named.
- Confirmed with AutoPlant whether deletion is intentional and whether a soft-delete or tombstone is
  available — that would let FSM distinguish "retired" from "temporarily unreadable", which the
  absence guard currently cannot.
