# 227 — FSM holds device rows the source no longer has

Status: needs-triage
Type: AFK · Backend ingestion / data hygiene
Filed: 2026-08-07
Origin: `audit/cross-analysis.md` §2.1 — surfaced while verifying [#223](./223-ndd-counted-healthy.md)'s
NDD population against AutoPlant directly.
Coordinates with: **[#220](./220-mst-vehicle-hard-deletes.md)** — likely the same mechanism seen in a
different table; read that issue first · [#223](./223-ndd-counted-healthy.md)

## Problem

Of the 913 devices FSM holds with null GPS, **6 do not exist in `ap_widgets.tb_vehiclemaster` at
all** — not a status mismatch, an absent row. FSM is carrying device state for devices the source has
no record of.

They are currently counted in `operationalDevices` and in `healthyOperational`.

## Relationship to #220 — check before treating as new

[#220](./220-mst-vehicle-hard-deletes.md) establishes that `ap_masters.mst_vehicle` is **not
append-only**: 1,153 of the 6,767 devices FSM holds departed are absent from that table entirely,
with no tombstone.

This issue is the same *shape* in the **other** table — `ap_widgets.tb_vehiclemaster` rather than
`ap_masters.mst_vehicle`, and a much smaller set (6, against a null-GPS population of 913; the full
`tb_vehiclemaster` orphan count across all 26,543 mirrored devices has **not** been measured).

**Do not assume they are the same defect.** #220's mechanism analysis (vehicle re-registration,
`vehicle_no` reuse) may or may not apply. But the fix posture is likely shared, so they should be
designed together rather than separately.

## Not yet measured

- The **total** `tb_vehiclemaster` orphan count across all mirrored devices — only the null-GPS slice
  (6 of 913) was checked. This is the first thing to establish and it is one query.
- Whether the 6 are also absent from `mst_vehicle` (i.e. gone from both) or present in one.
- Whether they were ever present and when they disappeared (`master_sync_runs` history may show it).

## Why it is filed separately rather than inside #223

Six rows do not justify blocking a KPI slice, and the state-modelling question in #223 is unrelated
to mirror hygiene. But 6 is the count *within one slice of one population* — the real number is
unknown, and folding it into a list inside another issue is exactly how it would be lost.

## Acceptance

- Total `tb_vehiclemaster` orphan count measured across all 26,543 mirrored devices.
- Overlap with #220's `mst_vehicle` orphan set established.
- A decision recorded on the disposition: retain (mirror frozen by design, as #218 treats
  `ABSENT_FROM_READ`), tombstone, or exclude from operational counts. **This is a judgement about
  what FSM should believe when the source forgets a device — coordinate with #220, do not decide it
  twice.**
