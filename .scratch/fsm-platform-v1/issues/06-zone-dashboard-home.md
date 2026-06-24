# 06 — Zone Dashboard Home

Status: done
Type: AFK
Progress: DONE (2026-06-20) — strict TDD. Backend 142 tests / 42 files + admin 20 tests / 8 files,
both typecheck clean. Decisions: trend % stubbed until Issue 40; "export to Excel" delivered as CSV
(no install). Action Required cards are graceful stubs (all sources are later issues). See
docs/progress/06-zone-dashboard-home.md.

## What to build

The default landing page (`/`) for ZM / CSM / Operations Head. **Action Required panel** (cards ordered by urgency): recently auto-dispatched batches not yet reviewed (informational), Vehicle Unavailability Reports + readiness conflicts, CRITICAL insertions awaiting SE Acceptance, Failed Verification items, Component-Blocked Tickets, WAITING_COMPONENT >7 days, `AWAITING_MANAGER_CONFIRMATION` Non-Op requests, and manual-assignment-required (3-retry exhaustion). **Zone Overview table** (zone rows; total inactive + count per SLA bucket + trend % vs yesterday; filter by zone/bucket; export to Excel). **Company / Plant Overview table** (company → plant → device drill-down; filter zone/company/plant/bucket; export). **Grouped Critical Work Queue** (CRITICAL+ grouped by company/plant, suggested SE options, plant-cluster multiplier signals, one-click assign).

Role scoping: ZM own zone; CSM/Operations Head all zones (read). SLA bucket colour coding per the severity table. Action Required cards may render as stubs for capabilities not yet built and fill in as later slices land.

## Acceptance criteria

- [x] Action Required panel renders urgency-ordered cards (graceful for not-yet-built sources)
- [x] Zone Overview shows per-bucket counts + trend % vs previous day; filter + Excel export work
- [x] Company/Plant Overview supports company → plant → device drill-down; filter + Excel export work
- [x] Grouped Critical Work Queue groups CRITICAL+ by company/plant with suggested SE + cluster signals
- [x] SLA bucket colour coding matches the reference table; ACTIVE never appears
- [x] Role/zone scoping enforced (ZM own zone; CSM/OH all zones read)

## Blocked by

- #05
