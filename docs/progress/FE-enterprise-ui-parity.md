# FE Enterprise UI Parity — Phases F0–F5 (in progress)

**Branch:** `feat/fe-enterprise-ui` · **Backlog:** `.scratch/fsm-platform-v1/` (see `INDEX.md` "FE —
Enterprise UI parity" section + per-issue files `FE-06`…`FE-26`) · **Design authority:**
`.scratch/fsm-platform-v1/DESIGN-SYSTEM.md` (reference-derived) + the screenshots under
`docs/ui/desktop/v2-reference/`.

**Last session:** 2026-06-26. **Last commit:** `74ac934 feat(FE-26)`. **Test baseline:** admin
`pnpm --filter @fsm/admin run typecheck` clean · **vitest 103/103** · `vite build` OK (verified after
every FE commit).

> 🐛 **Repo-integrity fix this session (FE-19):** `.gitignore`'s generic `coverage/` rule (test-coverage
> output) was also matching the source dir `apps/admin/src/pages/coverage/`, so `TerritoryPage.tsx` was
> **never committed** despite a live import in `AppRoutes.tsx` (dangling import on fresh clone). Added a
> targeted `!apps/admin/src/pages/coverage/` negation; the page is now tracked. **Watch for other source
> dirs that collide with generic ignore rules.** Note: this very progress doc lives under `docs/progress/`
> which is intentionally ignored by `docs/*` (only `docs/agents/` + `.scratch/fsm-platform-v1/` are
> versioned) — it is an on-disk handoff, not committed.

> ⚠️ **Shared branch.** `feat/fe-enterprise-ui` also carries backend issues (e.g. Issue 33 Install) from
> a **concurrent agent**. Always `git log` before starting, stage with **explicit pathspecs** (never
> `git add -A`/`.`), keep `apps/backend/**` out of FE commits, and coordinate follow-up issue numbers via
> `INDEX.md` (memory: `shared-fe-branch-concurrent-agent`). `apps/admin/tsconfig.tsbuildinfo` shows dirty
> — a build artifact, do **not** commit it.

---

## What this work is

A **presentation-only** reskin of the existing admin app onto the FE design system. On every page:
routing, auth, RBAC, API clients, business logic, and the **test selector contract are preserved** — only
the markup/styling changes. Verify each page's own test(s) **and** the full suite + build before
committing. NOT a rewrite.

The design system + component library (the `components/{ui,data,charts,domain,overlay,shell}`, `hooks/`,
tokens in `index.css`, `lib/cn.ts`) landed as **FE-00…05** and are the building blocks every later FE
issue composes. Tokens are Tailwind v4 `@theme` CSS vars; never hardcode hex/spacing.

### Reusable primitives (where things live)
- `components/data` — `PageHeader`, `MetricStrip`/`MetricCard`, `DataTable` (`Column`, `rowTestId`,
  `rowAccent`, `loading`/`empty`), `FilterBar`/`FilterSelect`/`SearchInput`, `DateRangeChips`,
  `feedback` (`EmptyState`/`ErrorState`/`Skeleton`), `Toast`.
- `components/ui` — `Button`, `Badge`, `Card`/`SectionCard`, `Input`/`Field`, `icons`.
- `components/domain` — `SLABadge`/`StatusPill`/`TierBadge`/`AgeChip`/`EntityBadge`, `TicketCard`, `Timeline`.
- `components/charts` — `DistributionBar`, `BarChartCard`, `DonutChart`, `TrendChart`, `RadialGauge`, `ChartCard`, `colors`.
- `components/overlay` — `Modal`, `Sheet`, `Tabs`, `Select`, `DropdownMenu`.
- `lib/slaBucket.ts` — single SLA colour source: `SLA_BUCKETS`, `BUCKET_LABEL`, `BUCKET_CLASS`, **`BUCKET_HEX`** (added FE-07 for charts).

---

## Done this session (committed, all green)

| Commit | Issue | Notes |
|---|---|---|
| `1ea62bc` | **FE-00…05 foundation** | Was **uncommitted** in the tree; committed as the milestone. |
| `25d8988` | **FE-06** Zone Dashboard (ZM) | `DashboardHome`/`ActionRequiredPanel`/`ZoneOverviewTable`/`CompanyPlantTable`/`CriticalQueue`. |
| `f224621` | **FE-07** Role-variant dashboards | `ManagerDashboard` selects `ZmDashboard`/`CentralDashboard`/`OpsHeadDashboard` by role+actingZone; `ScorecardTable`+`EscalationQueueList`+`BUCKET_HEX`. |
| `65234b6` | **FE-08** Tickets list | `TicketsPage` → PageHeader+FilterBar+DataTable. |
| `123984f` | **FE-10** SE Activity | `SeManagementPage`; literal status via `Badge` (not StatusPill humanizer). |
| `54ca33b` | **FE-11** SE Planner grid | `PlannerPage`; bespoke drag/drop grid reskinned in place. |
| `9276fa1` | **FE-12** Schedules + Detail | `SchedulesPage` (no Approve gate) + `ScheduleDetailPage` override surface. |
| `dcf99e5` | **FE-13** Intra-day Queue | `IntradayQueuePage` w/ severity row-accents. |
| `c146bbf` | **FE-14** Readiness / Vehicle Unavailability | `VehicleUnavailabilityPage` dual-clock cells; no EXPECTED_BACK. |
| `48082a2` | **FE-15** Component queues | `ComponentRequestsPage` (+readOnly) + `ShadowUseQueuePage`. |
| `3fedcb7` | **FE-16** Recovery + Non-Op queues | `RecoveryReceipt`/`RecoveryDecision`/`NonOperational` queues; Mark dual-confirm modal preserved. |
| `26bc063` | **FE-17** Warehouse dashboard | `DashboardHome` now a thin role selector → new `WarehouseDashboard` for `WAREHOUSE_MANAGER`. |
| `ada423d` | **FE-18** Settings | PageHeader+DateRangeChips+token tabs; new `SlaRulesTable`+`AccessMatrixGrid`. |
| `9c26bd7` | **FE-19** Territory | `TerritoryPage` on PageHeader+Field/FilterSelect+SectionCard; membership list→`DataTable` (role list→table, name kept); native selects retained for `selectOptions`; **+`.gitignore` fix** (page was untracked). |
| `e7cf1ea` | **FE-20** CSM Backup-Share | `CsmApprovalSharePage` on PageHeader+MetricStrip (4 KPIs derived from loaded rows)+BarChartCard+DataTable; table aria-label + `csm-row-*` ids + %-cell preserved; route-level OH gate untouched. |
| `74ac934` | **FE-26** Help Center | new role-scoped `/help` (`buildHelpSections` mirrors nav role logic) + glossary; sidebar Support→Help for all roles (+`IconHelp`); TDD 3 tests; static, no backend. |

**Phases F0, F1, F3, F4 complete; F2 complete except paused FE-09; F5: FE-18/19/20/26 done — only the
backend-gated FE-21…25 remain (see NEXT).**

---

## NEXT (pick up here)

**All unblocked FE parity issues are done.** The only remaining roadmap items are **FE-21…25**, and they
are **doubly blocked**:

1. **No backend.** Verified from the repo (2026-06-26): there are **no reporting API clients** beyond
   `roleBackup`, and **no backend controllers** for fleet-uptime / soft-inactive / root-cause /
   system-efficiency / zm-scorecard / device-detail. **BE 39–44 do not exist.**
2. **Net-new pages, not reskins.** `apps/admin/src/pages/reports/` contains only `CsmApprovalSharePage`.
   FE-21–25 would each be a brand-new page + route + nav — i.e. **net-new feature UI**, which the
   Enterprise-UI-Parity mission explicitly excludes ("NOT feature development", and the surfacing rule:
   *"Build the seam" applies to external integrations — NOT to admin pages*).

**DECIDED 2026-06-26 (user): DEFER FE-21–25** until BE 39–44 ship — option (A), keeping to the
parity-only / no-feature-dev mission. Do **not** build chrome-only stubs for them. When the reporting
endpoints land, FE-21–25 become net-new pages (Reports landing, Device Detail [+Issue 49 `deal_type`
tag UI], Root-Cause, System Efficiency, ZM Scorecard) on FE-05 chart primitives.

**Net result: the Enterprise UI Parity initiative is COMPLETE for all unblocked issues.** Outstanding
work is only: backend-gated **FE-21–25** (deferred) and paused **FE-09** (Forms tab blocked on
follow-up #70; its Verification / Assignment-History / Components tabs are buildable if unpaused).

### Per-issue working method (proven this session)
1. Read the FE issue file + the reference screenshot(s) + the page's existing source + **its test(s)**.
2. Reskin onto the primitives, preserving **every** `aria-label`/`role`/`data-testid`/asserted text +
   all fetch/CRUD/business logic. Grouped/expandable/drag-drop tables that `DataTable` can't express stay
   bespoke but get token styling.
3. `pnpm --filter @fsm/admin run typecheck` → run the page test(s) → run the full suite → `vite build`.
   (Use `pnpm exec vitest run <files>` from `apps/admin`; **`npx vitest` fails** — tries to hit the network.)
4. Mark the FE issue `done` (check ACs + add an Outcome section) + update its `INDEX.md` line.
5. Commit with explicit pathspecs (`feat(FE-NN): …`, ending with the `Co-Authored-By` trailer); verify no
   `apps/backend` leak before committing.

---

## Open follow-ups filed this session (backend gaps — surfaced, not fabricated)

Per the **parity gate**, where the reference showed data the backend doesn't expose, the chrome was
rendered with a `—`/placeholder and a follow-up filed (rather than faking data or silently deferring):

- **#70** — per-ticket troubleshoot/install **form read** endpoint (`GET /tickets/:id/forms`). **Blocks
  FE-09 Forms tab.** FE-09 is **PAUSED** by user decision; its Verification/Assignment-History/Components
  tabs ARE buildable (wire `GET /tickets/:id/verification`; derive Assignment-History from the loaded
  `ticket.lifecycle`). Note `ticket-detail-drawer.test.tsx` asserts Forms="coming soon" — update it when
  the Forms tab is filled.
- **#71** — ungated ticket-state (slaBucket/tier/PARTIAL flag) on the **schedule-stop payload**, so FE-12
  can add per-ticket PARTIAL/CRITICAL/tier card badges (today the reasoning is gated behind "Why
  suggested?" and must stay hidden).
- **#72** — `Modal`-ize the remaining `window.prompt` reason legs (recovery reschedule/close-failed;
  non-op override). Needs coordinated updates to `recovery-decision-queue.test` + `non-operational-queue.test`
  (they currently assert direct/prompt→POST on click). DESIGN-SYSTEM §5.4.
- **#73** — warehouse **stock read** endpoint + Low-Stock/Fulfillment-SLA KPIs, to fill the
  `WarehouseDashboard` stock `SectionCard` (FE-17 ships chrome + gated placeholder).

(#69 is the concurrent agent's Install-create admin UI — not ours.)

## Documented deviations (chrome rendered, dead control/value omitted — DESIGN-SYSTEM §9.2)
- Fleet Uptime % KPI → `—` until Fleet Uptime report (BE-39/40 / FE-21). Appears on ZM/Central/OpsHead/Warehouse dashboards.
- Auto-Dispatch efficiency row (OpsHead) → `—` until System Efficiency (BE-42 / FE-24).
- Approve gate omitted (FE-12, Decisions §7) → AUTO-ASSIGNED framing.
- `EXPECTED_BACK` omitted (FE-14).
- FE-15/FE-16 mandatory-reason legs kept **inline** (not Modal) to protect locked selectors → see #72.
- FE-18 Zone before/after delta columns → live CRUD kept, no fabricated deltas.

## Visual-regression note
FE-00 Playwright pixel baseline is still TODO (only `/_kitchensink` exists). Functional parity is covered
by vitest; pixel baselines vs the v2 references are a separate harness task.
