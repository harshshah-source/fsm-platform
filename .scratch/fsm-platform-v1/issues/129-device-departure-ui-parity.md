# 129 — Device-departure UI parity: surface the departed lifecycle (dashboards, device detail, health)

Status: ready-for-agent
Type: AFK

> Fast-follow to [#128](./128-device-deployment-lifecycle.md) (backend mechanism landed Slice 1,
> commit `b9242da`, 2026-07-18). The data layer is ready; this issue is display-only. Split out per the
> operator decision 2026-07-18 (parity gate met by an honest follow-up issue, not by blocking the
> backend mechanism on display work — the backfill approval gate is the priority).

## Problem (one paragraph)

#128 gave FSM a truthful device-deployment lifecycle: departed devices carry an active
`device_departures` row, `device_states.is_departed=true`, and drop out of inactive / SLA /
eligibility / dispatch. But the departure is not yet **surfaced**: the ZM/OH dashboards show no
"departed" tally (so fleet totals no longer visibly reconcile — operational + departed = mirrored
fleet), the device detail page shows no lifecycle status or departure/restore history, and the
integration-health page does not show the per-run departures/restores churn. Per CLAUDE.md's parity
gate these in-scope UI ACs cannot be silently dropped; they are deferred here, not abandoned.

## Data layer already in place (from #128 — no backend build needed for the tallies)

- `device_states.is_departed` (denormalised, indexed) — a single-predicate filter for any count.
- `device_departures` side table — observed status, reason, `departed_at`, `restored_at`,
  `detected_by_run_id` / `restored_by_run_id`, `cancelled_tickets_count` (history for the detail page).
- `master_sync_runs.entity_stats` carries `departures` / `restores` per run (health page delta).
- Audit rows `DEVICE_DEPARTED` / `DEVICE_REDEPLOYED` (system actor).

  A small read/query surface (dashboard tally, a device lifecycle read, a health per-run field) may
  still need to be added where an endpoint does not already expose these — the storage does not.

## Acceptance criteria

- [ ] ZM + OH dashboards show a **departed tally** per zone / fleet, alongside the inactive and
      #119 deactivated-plant tallies; fleet totals reconcile (operational + departed = mirrored fleet).
      Sibling of the existing deactivated-plants tally on the same dashboards.
- [ ] Device detail page shows **lifecycle status** (operational / departed, with observed status) and
      the **departure/restore history** (each transition: status, reason, run id, timestamp,
      cancelled-ticket count).
- [x] Integration-health page shows **per-run departures/restores** (from `entity_stats`) — the churn
      delta per master-sync run ("+212 departed, 37 restored").
      **Landed in #349, 2026-09-03** (`docs/progress/349-integration-health-page-completion.md`) —
      `LifecycleHealth.runs` on `GET /api/integration/health` plus the per-run churn table on the
      Build Health page, with the departure-auto-closed ticket count beside the two counters. The
      remaining ACs below stay with this issue.
- [ ] Reference the authoritative UI images under `docs/ui/desktop/v2-reference/` before building
      (surfacing rule); match layout / hierarchy / role visibility — do not redesign.
- [ ] Tests: admin specs for each surface; role visibility (ZM sees own zone, OH sees fleet).

## Dependencies / notes

- Blocked-by: none (the #128 data layer is ready). Best built after the #128 backfill (Slice 3)
  applies real departed data, so the tallies render against real numbers rather than an empty set —
  but not blocked on it.
- Out of scope: any change to the #128 mechanism, scheduler flags, `eligibility_mode`, backfill.
