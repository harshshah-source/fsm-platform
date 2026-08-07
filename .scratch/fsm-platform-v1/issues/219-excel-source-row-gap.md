# 219 — AutoPlant source holds 1,251 more NUVISTA vehicles than the ground-truth Excel

Status: needs-info
Type: AFK · Investigation (read-only)
Filed: 2026-08-07
Origin: AutoPlant↔FSM reconciliation (`audit/autoplant-reconciliation/reconciliation-report.md`, F5)

## Problem

Under the **authoritative** AutoPlant scope (`mst_company.company_id = 1004` → `mst_plant` →
`mst_vehicle`, ACTIVE plants), production holds **26,465** NUVISTA vehicles:
UNDEPLOYED 18,620 + DEPLOYED 7,805 + ACTIVE 40.

The operator-supplied ground-truth Excel (`docs/autoplant/SUMMARY_REPORT.xlsx`, snapshot
2026-08-07 06:49 IST) holds **25,214**. Gap: **1,251 rows**, unexplained.

This is the only figure in the whole reconciliation that could not be accounted for. It does not
block [#218](./218-lifecycle-drift-detection.md) — every #218 finding is device-level and unaffected
— but it means we cannot yet claim the Excel and the source describe the same population.

## Ruled out (measured, not assumed)

- **`vehicle_type`** — 100% `DEDICATED` under the scope; not a filter.
- **`vehicle_status`** (the `bit(1)` soft-delete flag) — 100% `1`; not a filter.
- **Plant scope** — the FSM-derived 22-plant list used in the first pass was a strict subset of the
  authoritative 24 with nothing spurious. Re-running under the authoritative scope *widened* the gap
  from 1,156 to 1,251 rather than closing it.
- **Company ambiguity** — `mst_company` has three NUVISTA rows (1004 `Nuvista`; 1005 `NuVista`, which
  has **zero plants**; 1071 `Nuvista Rakesiding`, 1 plant). 1005 contributes nothing.

## Leading hypothesis (untested)

The Excel is built from `ap_widgets.tb_vehiclemaster` joined to the masters, so only vehicles with a
widgets row (device fitted / ever pinged) appear. Consistent with the Excel carrying GPS, IMSI and
`hw_version` columns that exist only on the widgets side.

`audit/autoplant-reconciliation/corrected-queries.sql` **Q7** tests exactly this and has not been run.

## Acceptance

- Q7 run against production (read-only, aggregate) and the 1,251 either explained or narrowed.
- If it is a widgets join, record it in `excel-benchmark.md` so future reconciliations scope to it.
