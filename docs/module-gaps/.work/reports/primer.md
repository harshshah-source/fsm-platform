# reports — module primer (first walker, 2026-09-02, api-walk only, no browser)

Login/instrument: see `.work/_shared-primer.md`. Reports live at `apps/backend/src/reports/`
(one controller, `reports.controller.ts`) and `apps/admin/src/pages/reports/`; `exports/` is a
separate controller the module owns for C11.

## Role matrix — measured, E4
`fleet-uptime` `root-cause` `efficiency` `work-type-mix` `verification-outcomes`: MANAGER_ROLES —
OH 200 · CSM 200 · ZM 200 (zone-clamped) · WM 403 · SE 403.
`zm-scorecard`, `soft-inactive-trend`, `exports/*`: OPERATIONS_HEAD only — ZM 403, CSM 403.
Zone clamp is server-side AND honest: `efficiency?zoneId=2` as `zm.north` returns
`filters.zoneId: 1`. `zm.south` fleet-uptime sees only zone 2. Do not re-walk this.

## Data density — which month has data (this is the whole story)
`GET /reports/fleet-uptime?month=YYYY-MM` as OH:

| 2026-03 | 04 | 05 | 06 | 07 | 08 | 09 (default) |
|---|---|---|---|---|---|---|
| empty | empty | empty | 20309 dev / 100% | **15311 dev / 56.19%** | empty | empty |

**2026-07 is the only month with real downtime.** Every "empty" month returns
`rows:[], eligibleDeviceCount:0, uptimePct:100` — the fabricated perfect score (RPT-01).
`root-cause`, `zm-scorecard`, `efficiency` all default to the current month/day and all return
empty or all-zero. Never take a number from a default-parameter report call as evidence the
report works; ask for `?month=2026-07` to see the code path on real rows.

## Do not
Do not fire `POST /reports/fleet-uptime/recompute` — it would populate the current month and erase
the RPT-01 reproduction for later walkers. Freshness contrast (RPT-03) is settled: no report body
carries a stamp; `GET /exports/entity-mapping/summary` carries `dataAsOf`.
