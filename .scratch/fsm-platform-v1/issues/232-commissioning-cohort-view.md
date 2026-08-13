# 232 — Commissioning cohort & install-quality view: backend shipped, admin surface unbuilt

Status: ready-for-agent
Type: Feature (Backend done · Admin outstanding) · Reports
Filed: 2026-08-13 (retrospectively — the backend was written 2026-08-10 and sat uncommitted and
unowned until a status review found it on disk)
Origin: `audit/commissioning-view-feasibility.md` (2026-08-09), an operator-requested feasibility
read on "how are newly commissioned devices doing?"
Coordinates with: [#223](./223-ndd-counted-healthy.md) (the never-reported fleet state this view
reports over) · [#222](./222-telemetry-staleness.md) (the offset correction that makes
`first_reported_at` comparable) · [#217](./217-operations-data-explorer.md) (the row-level tool a
reader drills into from here)

## Why this exists

The feasibility read corrected the premise it was given. The brief assumed newly fitted devices are
"expected to be silent for a while" and asked for a grace period. They are not:

- **96.97% of genuine new installations report within 12–24 h**, and the curve is flat from there
  (98.53% at 2–3 days, 95.61% at 3–7 days — sampling noise, not a rising tail). A device silent past
  24 h is not commissioning; it is overwhelmingly likely to be broken.
- So the valuable measure is **install quality**, not a grace window: *of the devices fitted in the
  last N days, how many came online, how long did each take, and which have not?*
- `FIRST_INSTALLED_BY` carries a real per-technician login identity (`FIRST_INSTALLED_COMPANY_ID`
  does not — it is the owning company in 62,992 of 62,992 rows), and its unusable-`NA` rate has
  fallen from 100% (2021) to 12.9% (2026), so per-installer attribution is now worth showing.

## What is built (backend — done, committed with this issue)

| Piece | File |
|---|---|
| Cohort + install-quality aggregation | `apps/backend/src/reports/commissioning-aggregation.service.ts` |
| TTFR epoch + window ceilings | `apps/backend/src/reports/commissioning.config.ts` |
| Person vs machine attribution | `apps/backend/src/reports/installer-classification.ts` |
| `GET /api/reports/commissioning/cohort` · `/installers` | `apps/backend/src/reports/reports.controller.ts` |

Both endpoints are `@Roles(...MANAGER_ROLES)`; a ZM is clamped to their own zone in the service and
told so via `scopedToZoneId`.

Design decisions worth not re-litigating:

- **No new module, no new table.** These are the rows master sync already appends to
  `device_commissioning` joined to the `device_states` the telemetry tick already maintains. Cohort
  membership is derived (`installed_at >= now() - N days`); nothing moves a device between states.
- **Online is decided solely by `device_states.first_reported_at`.**
  `device_commissioning.first_reported_at` is an observation-time snapshot (0 of 24,294 rows
  populated), so a reader requiring both to agree would report zero commissioned devices forever.
- **Timing samples exclude fitments before `DEFAULT_TTFR_EPOCH`.** The write-once column captured a
  last-seen value for devices already reporting when it landed — 15,345 of 23,086 stamped on the day
  it shipped, 2,138 earlier than their own `installed_at`.
- **Window ceilings are a performance contract**, measured: every bounded shape holds the same plan
  (6.8 ms / 9.7 ms today, 62.7 ms / 172.1 ms at 4× the one-year projection); an unbounded lookback
  abandons the index and spills the `GROUP BY` to disk at 1,078 ms. No index fixes it.
- **Unresolvable installer logins are labelled, shown, and never ranked** (17,712 of 24,294 rows) —
  never silently called a person.

Verified 2026-08-13 before commit: `commissioning-units` 8/8, `commissioning-cohort` 27/27 (real DI
graph, over HTTP), `tsc --noEmit` clean.

## What is NOT built — the acceptance criteria that remain

1. **AC-1 — the admin surface.** Two manager-facing report endpoints exist that no screen calls.
   Read `docs/ui/desktop/v2-reference/21-reports.png` and follow the UI-discovery steps in
   `docs/agents/workflow.md` before building; do not redesign. This is the open parity-gate item:
   the deferral reason is *not* an external-integration blocker, so per CLAUDE.md this issue cannot
   be marked done while it stands.

   **Blocked by [#233](./233-commissioning-cohort-counts-warehouse-as-failed.md)** (population
   correctness — AC-2 below) and **fed by [#234](./234-commissioning-resolution-curve.md)** (the
   trend panel). Drill-through out of the page is
   **[#235](./235-recently-commissioned-device-drillthrough.md)**.

   Composition, per the investigation §6.1 — all from existing primitives except one new
   bucket-bar component: scope-chip band (`ZoneDrilldownSection` pattern) → `MetricStrip` KPI strip →
   resolution curve → remark split (`BarList`/`DistributionBar`) → per-plant `DataTable` → per-installer
   `DataTable`. Three rendering rules that are correctness, not polish: `medianHours: null` renders
   "—" and never 0; `sampleSize` is shown beside every median; non-`PERSON` `installerKind` rows are
   displayed but **never ranked**. Label the window truthfully — the ceiling is 90 days, so the page
   says "last 90 days", not "last 3 months" (open decision D1).
2. ~~**AC-2 — validate against live `fsm`.**~~ **EXECUTED 2026-08-13, and it FAILED. See
   `audit/recently-commissioned-devices-investigation-2026-08-13.md` §3.**

   The cohort query has **no operational-fleet predicate**. Live over the last 90 days it reports
   **6,832 fitments / 2,668 failed (39.1%)**; with `ds.is_departed = false` the same window is
   **2,645 / 147 (5.6%)**, because **4,127 of the 6,405 cohort devices (64.4%) are departed** — in a
   warehouse, not broken. That defect is now owned by
   **[#233](./233-commissioning-cohort-counts-warehouse-as-failed.md)** and **blocks AC-1**: shipping
   the page first would publish a 39% install-failure rate and send Operations after ~2,500
   warehoused devices.

   Two record corrections this validation also produced:
   - `device_commissioning` is at **25,387 rows across 6 master-sync runs** (117/118/119/124/125/126),
     not 24,294 across one. Append-only is behaving exactly as designed — run 126: `observed 24,659 ·
     inserted 142 · skipped 24,517 · updated 0`.
   - `device_commissioning.first_reported_at` is populated on **371 of 25,387** rows, not 0 of 24,294.
     Later runs snapshot the value for devices that have since begun reporting. **This does not change
     the design decision** — that column remains an observation-time snapshot and must never decide
     "online" — but the figure quoted here, in SYSTEM-STATE §3l and in INDEX is stale.
   - The `graceHours = 48` default is now confirmed on FSM's own stored data, not only on the
     AutoPlant-side survival curve: of 520 measurable TTFR samples, **97.7% fall inside 48 h and
     99.6% inside 72 h**.
3. **AC-3 — `kpiCatalog` / `kpi-definitions.md` entries** for the cohort measures, so these figures
   carry the same provenance every other KPI on the dashboard does.

## Notes

- `COMMISSIONING_TTFR_EPOCH` is documented in `.env.example` and neutralised by #182's test env
  allowlist, so a developer's re-baselined epoch cannot silently move the medians the specs assert.
- The installer-quality analysis that motivated the attribution work is deliberately untracked
  (`audit/installer-quality-2026-08/`, see `.gitignore`): its headline finding is a bulk-provisioning
  vendor feed, not a person doing bad work, and a named account sitting in git history next to a
  97.5% failure rate reads as an accusation to everyone who never opens the file.
