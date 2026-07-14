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

## Batch 2 (2026-07-14 second QA pass — commits c86febc / ea97c6f / 33fe4fa)

- **Snapshot alert investigated**: the banner was TRUTHFUL — runs 64/65 (14 Jul) FAILED ~30ms in at the
  AutoPlant MySQL hop; last good data really is 13 Jul 18:28 IST. The tree's uncommitted
  `autoplant-mysql.client.ts` WIP notes the real telemetry source is `ap_gpsmw.ng_gps_data` (grant
  pending) — external-integration issue, NOT a banner bug. Banner made LIVE anyway (60s poll +
  re-read on ingestion-complete). Run-Ingestion button fixed-width (no more search-field resize).
- **Action-Required KPI card → Companies / Plants / Devices** via new `GET /api/dashboard/fleet-summary`
  (scoped, deactivated plants excluded). The Action Required *panel* stays.
- **Device-ID-shows-vehicle-number verified as SOURCE DATA**: 1,950 devices have `device_id` exactly
  equal to their `vehicle_no` (Vasavadatta 1,449 / Saurashtra 393 / Deepak 75 / Prism 25 …) — AutoPlant's
  master sends it that way. UI adds a tooltip on such cells; no FSM fix possible/needed.
- **Company/Plant Overview**: multi-select removed; 8 bucket columns → one wrapping "SLA Spread" chip
  row — table fits with no horizontal scroll.
- **Device Detail**: company-dependent **plant dropdown** (filter-options grew a plants leg + `plantId`
  list filter) and a 3-step **Assign SE** panel driving new `POST /api/schedules/assign-plants`
  ({seId, plantIds[]}) → every OPEN+UNASSIGNED ticket at the plants through the canonical
  `assignTicket` primitive (audit `MANUAL_PLANT_ASSIGN`, notifications, Shared-Pool exit).
- **"Company 15 / #15" root cause**: the running backend process predated the #122 payload — rebuilt
  `dist` + restarted; live API verified returning names. Drawer Overview enriched (company/plant names,
  vehicle, assigned SE + OVERRIDDEN + batch/schedule refs).
- **Batch Schedule**: rows lead with SE NAME + zone (uuid demoted), plain-language statuses
  (Auto-Dispatched / ZM Adjusted), sortable counts, explanatory copy; `ZmScheduleRow`/`Detail` +
  `ZoneEngineerRow` carry names so every SE picker app-wide shows names.
- Tests: 4 backend e2e (`issue-122b-fleet-assign`) + `issue-122b-ui` admin spec; full admin suite 69
  files green; live API verified post-restart.

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
