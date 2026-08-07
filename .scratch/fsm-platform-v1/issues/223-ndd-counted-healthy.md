# 223 — Devices that have never reported are counted as "healthy"

Status: needs-triage
Type: HITL (changes a published KPI definition) · Backend + Admin
Filed: 2026-08-07
Origin: AutoPlant↔FSM reconciliation, finding **F3**
(`audit/autoplant-reconciliation/reconciliation-report.md`)
Deliberately excluded from [#218](./218-lifecycle-drift-detection.md) by operator decision.

## Problem

`healthyOperational` is defined as the *negation* of inactive (`dashboard.service.ts`,
`FLEET_COUNT_COLUMNS`):

```sql
COUNT(*) FILTER (WHERE ds.is_departed = false
                   AND NOT (ds.is_inactive = true AND ds.sla_bucket IS NOT NULL))
```

A device that has **never reported GPS** (`latest_gps_datetime IS NULL`) is not inactive and has no
SLA bucket, so it falls into `healthy` by construction. **51 operational Nuvista devices are in that
state today**, counted inside `healthyOperational` (8,258).

The ground-truth source treats these as a distinct third state — **NDD, "No Device Data"** (343 rows
in the Excel, where `Active + Inactive + NDD = total` closes exactly, and NDD ≡ blank
`GPS_DATE_TIME` ≡ `Device Status = NDD` as identical row sets). **NDD is a peer of Active and
Inactive, not a flavour of either.**

## Why it matters

Small in count, wrong in kind: **"we have never heard from this device" is being reported as "this
device is reporting normally."** A never-reporting device is arguably the most broken state a device
can be in, and it currently inflates Fleet Health %.

The count is limited only because most NDD devices are undeployed and therefore never mirrored (the
#128 insert-scope pin) — it is not structurally bounded, and would grow if the insert scope widened.

## Proposed

Introduce NDD as an explicit third state rather than folding it into healthy.

**This is HITL, not a patch.** It changes a published KPI definition (`docs/kpi-definitions.md` §3)
and breaks the documented identity `healthy + inactive = operational`, which
`dashboard-kpi-reconciliation.e2e-spec.ts` asserts over the whole database. Either the identity
becomes `healthy + inactive + ndd = operational`, or NDD is excluded from `operational` entirely —
that is a business decision about whether a never-reporting device is part of the operational fleet.

`audit/autoplant-reconciliation/corrected-queries.sql` **Q3** shows the three-way split.
