# 122 — Dashboard / Ticket / Device / SE Activity UI overhaul (operator QA batch)

Status: ready-for-agent
Type: full vertical slice (backend read enrichment + admin web)

> Source: operator QA batch 2026-07-14 (6-part work order across Zone Dashboard, Ticket Operations,
> SE Activity, Device Detail). Bug fixes + UX/parity enhancements. Backend read surfaces were enriched
> to carry the operator-facing identities/assignment the pages needed; no business-rule change.

## Decisions taken (HITL)

- **"Critical+" KPI + scorecard column → strictly the CRITICAL band** (relabelled **Critical**).
  The operator flagged that "Critical+ Devices" equalled "Inactive Devices". Root cause is data, not a
  formula bug: the three sub-critical bands (Warning/Early-Risk/Risk) are currently empty, so every
  inactive device is already critical-or-worse. Asked the operator (AskUserQuestion 2026-07-14); they
  chose **"Only the CRITICAL band"** (1,168 on dev DB, vs 5,873 for critical-and-worse). Worse bands
  (Long-Pending/Severe/…) remain visible in Zone Overview + the SLA Bucket Distribution, so nothing is
  hidden overall. New helpers `criticalOnlyCount` / `sumCriticalDevices` (`lib/slaBucket.ts`).

## Backend (slice 1, commit e223257)

- `/api/tickets` rows: `plantName`, `companyName`, `vehicleNo`, live assignment (`assignedSeId/Name`,
  `batchId`, `scheduleId`, `overridden`) via a LATERAL join on the one active
  `batch_assignment_tickets` row. New `plant` (name-or-id) + `q` (universal) filters.
- `/api/dashboard/zone-overview` rows: `zonalManagerName` (`zones.zonal_manager_user_id` → `users`).
- `/api/devices` rows: open-ticket assignment context; new `criticalPlus=true` filter.
- `/api/engineers/:seId`: `zoneName` + schedule header + plant `stops` with per-ticket
  device/vehicle/company/SLA context.
- 6 e2e (`issue-122-dashboard-reads`); impacted suites green.

## Admin (slice 2, commit 0bbcd7b)

- **Zone Dashboard**: Critical KPI (above); Scorecard gains a **Zonal Manager** column, a clickable
  Critical count (→ device list, that zone's inactive CRITICAL), and clickable rows (→ device list for
  the zone). Scorecard already renders for CSM (Central Tower) + OH (Fleet Command).
- **Company / Plant Overview**: company is its own column; collapsed-by-default company rollups expand
  to plants, then to open device tickets with **assignment status / vehicle / overridden**; universal
  search + assignment-state filter; multi-select + **CSV/Excel/PDF** download.
- **Ticket Operations**: company **dropdown** (was ID box); plant search by **name or id**; universal
  search; separate **Company** + **Plant** name columns + **Vehicle No.** + **Assignment** (SE/
  overridden); multi-format download.
- **Device Detail**: **Assignment** column + assignment block on the selected device; scorecard
  deep-links via URL filters; multi-format download.
- **SE Activity**: SE drill-down shows full **Scheduled Work** — schedule header + plant stops with
  per-ticket device/vehicle/company/SLA.
- Shared: dependency-free `lib/exportFile` (Excel SpreadsheetML + hand-assembled PDF + CSV) behind a
  reusable `ExportMenu`. 3 new specs; full admin suite green, tsc + build clean.

## Notes / follow-ups

- Universal search on Company/Plant Overview filters the company/plant tree by name/id; device- and
  vehicle-level matching happens in the expanded open-tickets panel and on the Ticket Operations page
  (which searches device/vehicle/plant/company server-side via `q`).
- `criticalPlus` device filter is implemented + tested but the scorecard drill-down currently uses the
  existing single-`bucket=CRITICAL` filter (matches the CRITICAL-only column); kept as a general
  capability.
- PDF export is a minimal single-font (Helvetica) table renderer; fine for operational exports, not a
  typeset report. Excel is SpreadsheetML 2003 (.xls) — opens natively in Excel, zero dependency
  (FortiGate install block, same posture as `lib/csv`).
