# 13b — ZM Monitoring & Override admin UI

Status: done
Type: AFK
Progress: docs/progress/13b-zm-monitoring-override-admin-ui.md — all 6 ACs green (admin 38 tests / 15 files; +1 backend zone-SE endpoint, backend 268 tests). Strict TDD, 2026-06-22.

## What to build

The React admin (ZM dashboard) UI on top of the Issue 13a override engine + API. Split out of
Issue 13 (2026-06-21) so 13a could ship the backend override engine + API + contract tests; this
issue is the front-end half.

- **Schedule list page** (`/schedules`): per-SE row — batch ticket count, date range, status badge
  (`AUTO_ASSIGNED` / `OVERRIDDEN`). No countdown clock, no Approve action. Advisory Schedule Cadence
  reminder only (locks nothing). Reads `GET /api/schedules`.
- **Schedule detail page** (`/schedules/:engineerId`): ordered stop list; per-ticket "Why suggested?"
  chip (Company Tier, Device Bucket, Priority Rank, Plant Cluster Multiplier) that expands to the
  Recommender reasoning. Reads `GET /api/schedules/:engineerId`.
- **Override controls**: Swap SE, Split Batch, Remove Ticket, Reorder (drag), Defer Ticket, Reassign —
  each POSTs `/api/batches/:id/override` and reflects the immediate `OVERRIDDEN` flip.
- **Conflict banner**: when an override targets a ticket the SE holds `ON_SITE` on, show the warning
  banner returned by the API (409 conflict payload) and require an explicit mandatory reason code +
  confirm before re-submitting.
- **Grouped Critical Work Queue**: wire the existing inert `CriticalQueue` "Assign" button to the
  one-click assign endpoint (creates a Formal Assignment).

## Acceptance criteria

- [x] Schedule list shows `AUTO_ASSIGNED` / `OVERRIDDEN` badges; no Approve action, no countdown
- [x] "Why suggested?" chip expands to the Recommender reasoning
- [x] Each override control commits via the API and reflects the `OVERRIDDEN` status
- [x] Override propagates to the SE Day Plan (verified via the SE Day Plan API) and the UI reflects it
- [x] ON_SITE conflict banner + mandatory reason code flow before commit
- [x] CriticalQueue "Assign" creates a Formal Assignment

## Blocked by

- #13 (13a — backend override engine + API)
