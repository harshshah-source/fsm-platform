# 232 — Commissioning cohort & install quality: the admin surface (AC-1, AC-3)

**Completed 2026-08-13.** Frozen completion record — corrections go to INDEX / SYSTEM-STATE, not here.

Issue: `.scratch/fsm-platform-v1/issues/232-commissioning-cohort-view.md`
Reference: `docs/ui/desktop/v2-reference/21-reports.png`
Depends on: [#233](../../.scratch/fsm-platform-v1/issues/233-commissioning-cohort-counts-warehouse-as-failed.md) ·
[#234](../../.scratch/fsm-platform-v1/issues/234-commissioning-resolution-curve.md)

---

## What shipped

Route `/reports/commissioning`, Analytics nav group, `MANAGER_ROLES` via `RoleRoute` mirroring the
backend `@Roles`. The parity-gate item that had been open since the backend landed on 2026-08-10 is
closed: two manager-facing endpoints that no screen called now have one.

| Piece | File |
|---|---|
| Page | `apps/admin/src/pages/reports/CommissioningCohortPage.tsx` |
| Typed client | `apps/admin/src/api/reports.ts` (`apiCommissioningCohort`, `apiCommissioningInstallers`) |
| KPI provenance | `apps/admin/src/lib/kpiCatalog.ts` — 6 new entries |
| Documentation | `docs/kpi-definitions.md` §8, written from those entries |
| Route · nav | `AppRoutes.tsx` · `components/shell/nav.ts` |
| Tests | `apps/admin/test/commissioning-cohort.test.tsx` (14) |

Breadcrumb needed no change — `resolveBreadcrumb` derives from `buildNav`, so the nav entry is the
registration.

## UI discovery (workflow.md steps 1–5)

1. **Reference:** `21-reports.png`.
2. **Structure:** scope-chip band → KPI strip → two side-by-side panels → breakdown tables.
3. **Mapped to ACs:** the strip carries the cohort counts, the left panel the #234 curve, the right
   panel install quality, the tables the per-plant and per-installer breakdowns.
4. **Reused, not rebuilt:** `PageHeader`, `MetricStrip` + `KpiInfo`, `FilterBar`/`FilterSelect`,
   `ReportGrid`, `ChartCard`, `BarList`, `DataTable` (with its `TableDownloadButton` and `S.No.`),
   `EmptyState`. The only bespoke markup is three caption paragraphs — no new component was needed,
   and the "new bucket-histogram component" the investigation predicted turned out to be `BarList`
   over pre-computed percentages.
5. **No redesign.** Layout, hierarchy and role visibility follow the reference.

**Presentation only.** Every number is served ready-made; nothing is recomputed in the browser. The
population predicate and the "came online" definition live in one SQL expression, and a second
arithmetic in the client is precisely how two surfaces begin to disagree.

## The three rendering rules that are correctness, not polish

These are the reason this page could do harm if built carelessly — it reports on install quality, so
overstated confidence is worse than a missing panel.

1. **A null median renders `—`, never `0`.** Zero claims every device commissioned instantly; the null
   says nothing was measured. `sampleSize` rides on the card rather than in a tooltip, because the
   median is measured over 400 fitments against 2,360 online and a reader who cannot see that will
   over-trust it.
2. **Installer logins are labelled and never ranked as people.** Every row shows its `installerKind`,
   and a standing caveat says these are login strings with no user master behind them. 17,712 of
   24,294 are an underscore form that mixes plant-prefixed individuals with depot accounts.
3. **The window says "last 90 days", not "last 3 months".** The ceiling is 90 — a measured performance
   contract — and a 92-day request returns `WINDOW_OUT_OF_RANGE`. A label overstating the scope by two
   days would be the page lying about itself. Pinned by test (operator decision D1).

Two further things the page states rather than hides:

- **The census line** — `6,810 in window = 2,623 operational + 4,187 warehouse + 0 deactivated + 0
  unmirrored`. Without it a reader reconciling against AutoPlant concludes the page is broken; before
  #233 the page *would* have been, since those 4,187 were counted as failed installs.
- **The curve's basis** — how many fitments are gradeable, how many were excluded as pre-epoch, and how
  many are too young. A curve over 65 of 2,623 fitments has to say so.

## Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| AC-1 layout / hierarchy / role visibility per `21-reports.png`; no redesign | ✅ | UI-discovery steps above; composed entirely from existing primitives |
| AC-2 population visible as a control **and** as a named drop; default `operational` | ✅ | selector + census line; `population=operational` asserted on the request |
| AC-3 `kpiCatalog` entry per figure, rendered through `KpiInfo`; `kpi-definitions.md` from the same entries | ✅ | 6 entries; §8 of the doc; a test asserts each `kpi-info-<key>` resolves |
| AC-4 null median renders `—`, sample size shown | ✅ | 2 tests |
| AC-5 `installerKind` shown; non-`PERSON` never ranked | ✅ | 1 test + standing caveat |
| AC-6 window label states the true window | ✅ | 1 test, including that no "3 months" option exists |

**AC-3's failure mode is worth noting:** `KpiInfo` renders *nothing* for an unknown catalog key, so a
typo would silently drop the provenance affordance and no other test would fail. The test asserts each
`kpi-info-<key>` is present for exactly that reason.

## Testing

| Suite | Result |
|---|---|
| `commissioning-cohort.test.tsx` | **14** — new |
| Full admin suite | **456 tests / 95 files, exit 0** (was 442 / 94) |
| `kpi-transparency` · `routing` · `breadcrumb` · `sidebar-shell` | green — the nav/route/selector-contract neighbours |
| `tsc --noEmit` | clean |

Backend untouched by this slice; #233 and #234's 147 tests stand as run.

## Not done, and honestly so

- **Never opened in a browser against a live backend.** No committed path seeds a credential on a dev
  database (#194), so every login 401s there. The page is proven by tests over recorded payload
  shapes, and those shapes come from the live probe's real output rather than from invention — but
  that is not the same as having seen it render against `fsm`.
- **Drill-through is [#235](../../.scratch/fsm-platform-v1/issues/235-recently-commissioned-device-drillthrough.md)**,
  not this slice. Cohort rows do not yet link into the Device Detail list; that needs the
  `commissionedWithinDays` filter to exist first.
- **The install-quality panel shows the top 10 rows and says nothing about the rest.** Acceptable
  because the full breakdown is one table down, but it is a silent cap and is recorded here as one.
