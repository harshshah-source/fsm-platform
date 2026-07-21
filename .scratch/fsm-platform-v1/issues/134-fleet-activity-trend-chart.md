# 134 — Fleet-activity trend: Inactive vs Troubleshoot vs Installation line graph

Status: done
Type: AFK

> **Done 2026-07-20** — Backend `GET /api/dashboard/activity-trend?range=&zoneId=`
> (`DashboardService.activityTrend`): TROUBLESHOOT/INSTALL counts grouped over `tickets.created_at`,
> inactive stock from `soft_inactive_count_history` (last snapshot per zone per bucket) topped up with
> the live eligible-inactive count; hour/day/month bucketing by range; ZM zone-clamp; deactivated
> plants excluded. FE: `FleetActivityTrendChart` (3-series recharts) + `ActivityTrendSection` (range
> chips 1D/7D/1M/1Y/MAX + Pan-India/Zone-wise toggle + OH/CSM zone dropdown), placed between the KPI
> hero and SLA Bucket Distribution on the OH/ZM/CSM dashboards. Tests: `dashboard-activity-trend.e2e`
> (5/5, deterministic counts in an isolated zone) + `activity-trend-section.test` (3/3). Uncommitted.

> Operator ask (2026-07-20): a line graph of **Total Inactive Device vs Troubleshoot vs
> Installation** over time on the dashboards. Range-selectable (1D / 7D / 1M / 1Y / MAX), with two
> views — **Pan-India** and **zone-wise** — and, on the Operations-Head dashboard, a zone dropdown to
> pick the zone. Placed **between the KPI hero section (truck) and the SLA Bucket Distribution**.

## Metric semantics (decided with operator 2026-07-20)

Three series on one time axis, bucketed by day (coarser bucket for long ranges):

- **Inactive Devices** — the *live inactive count* (stock). Historical points come from
  `soft_inactive_count_history` (twice-daily zone snapshots, the same source as
  `/reports/soft-inactive-trend`); the latest point is the current `device_states` inactive count.
- **Troubleshoot** — count of TROUBLESHOOT `tickets` **created** in each bucket (flow), by
  `created_at`.
- **Installation** — count of INSTALL `tickets` **created** in each bucket (flow), by `created_at`.

(A stock line beside two flow lines is intentional — it answers "how bad is the backlog vs how much
work is coming in".) Reconciles with existing surfaces: troubleshoot/install counts are the same
`tickets` rows the work-type-mix report (#90) totals.

## Data availability caveat

Ingestion + ticket history only began accumulating recently, so **1Y / MAX will be sparse or empty**
until more history exists. The chart must render honestly against a short history (no crash, no fake
points) — MAX = "all data we have".

## Backend

- [ ] New read endpoint `GET /api/dashboard/activity-trend?range=1D|7D|1M|1Y|MAX&zoneId=<n>`
      (manager roles; ZM clamped to their own `zone_id` by the guard + service, OH/CSM may pass
      `zoneId` or omit for pan-India). Returns `{ range, from, to, bucket, points: [{ bucket,
      inactive, troubleshoot, installation }] }`.
- [ ] Troubleshoot/install series: grouped `COUNT` over `tickets` by `date_trunc(bucket, created_at)`
      and `work_type`, respecting the deactivated-plant exclusion (#119) consistent with the other
      dashboard counts.
- [ ] Inactive series: read `soft_inactive_count_history` for the window (sum across zones for
      pan-India, or the one zone), latest bucket topped up from the live `device_states` count.
- [ ] Bucket granularity by range (day for ≤1M, week/month for 1Y/MAX) so the point count stays sane.
- [ ] Tests: e2e for pan-India vs single-zone shaping, ZM zone-clamp (a ZM's response only covers
      their zone regardless of `zoneId`), empty-history renders `points: []` not an error.

## Frontend

- [ ] New multi-series line chart component (3 lines; recharts, semantic colours from the chart kit —
      inactive = warning/critical ramp, troubleshoot = brand, installation = a distinct series colour;
      dark-mode aware) — TrendChart is single-series, so this is a sibling.
- [ ] A dedicated range selector (`1D 7D 1M 1Y MAX`) — NOT the global `DateRangeChips` (different
      values + it's the banner control) — and a **Pan-India / Zone-wise** view toggle.
- [ ] On the OH dashboard, a **zone dropdown** (appears in zone-wise view) sourced from the zone list.
      On the ZM dashboard the chart is inherently the ZM's own zone (no toggle needed, or toggle
      hidden/disabled).
- [ ] Placement: a new section rendered **after `DashboardHero` and before the SLA Bucket
      Distribution** on the OH and ZM dashboards (and CSM where the same body is used).
- [ ] Tests: admin spec that the three series render, the range selector re-queries, the OH zone
      dropdown scopes the request, and an empty series shows an honest empty/period state.

## Dependencies / notes

- Blocked-by: none (reuses `soft_inactive_count_history` + `tickets`). Related: #40 (soft-inactive
  trend), #90 (work-type mix).
- Surfacing rule: read `docs/ui/desktop/v2-reference/04-dashboard-operations-head.png` (+01 ZM) before
  building; match the card/section chrome of the neighbouring SLA Distribution block — do not redesign.
- Out of scope: recovery work-type as a fourth line (operator asked for three); a persisted rollup
  table (compute on read from existing sources).
