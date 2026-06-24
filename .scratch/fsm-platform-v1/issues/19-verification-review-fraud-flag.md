# 19 — Verification Review page + fraud flag

Status: done
Type: AFK
Progress: docs/progress/19-verification-review-fraud-flag.md — all 6 ACs green (backend +4 tests, admin +4 tests). Action Required cross-link deferred. 2026-06-23.

## What to build

The ZM-facing GPS Verification Review page (`/verification`). Filter by outcome, zone, company, date range; default = all non-CLOSED for the zone, sorted by `submitted_at` desc. Row types: PARTIAL_RECOVERY (ping count + 24h countdown), FAILED_VERIFICATION no-pings, FAILED_VERIFICATION fraud-flag (distance-delta chip in orange), CLOSED (green, no action). FAILED_VERIFICATION reasons split by "no pings" vs "fraud flag". Clicking a row opens the Ticket Detail Drawer pre-navigated to the Verification tab. Fraud-flagged rows get an **Escalate** action (mandatory reason); auto-recovery gets a **Mark CLOSED_AUTO_RECOVERY** button. Failed Verification items also surface in the Action Required panel.

## Acceptance criteria

- [x] Review page filterable by outcome / zone / company / date; default non-CLOSED sorted by submitted_at desc
- [x] Row types render correctly incl. PARTIAL_RECOVERY ping count + 24h countdown
- [x] FAILED_VERIFICATION split into "no pings" vs "fraud flag" with distance-delta chip
- [x] Row click opens Ticket Detail Drawer at the Verification tab
- [x] Escalate (mandatory reason) on fraud-flagged rows; Mark CLOSED_AUTO_RECOVERY on auto-recovery rows
- [x] Role/zone scoping enforced

## Blocked by

- #18
